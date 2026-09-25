# Config Encryption at Rest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `data/db/config.json` currently stores every config value in plaintext, including secrets such as `plugin.kisski.api.key`. The `masked=True` convention (`fastapi_app/lib/utils/config_utils.py`, `fastapi_app/api/config.py`) only hides values from the frontend/API response (`MASKED_SENTINEL = "****"`) — the file on disk is fully readable cleartext. This plan encrypts every config value flagged `masked=True` at rest, using a symmetric key held only in `.env` (`CONFIG_ENCRYPTION_KEY`, never in `config.json` itself), while keeping the encryption completely transparent to backend callers (`config.get()` returns the real decrypted value) and to the frontend/HTTP API (masked keys still resolve to `MASKED_SENTINEL`, never anything decrypted).

**Architecture:**

- A new module `fastapi_app/lib/utils/config_crypto.py` owns all cryptography: a versioned, prefixed ciphertext format (`enc:v1:<fernet-token>`), `encrypt_value()`/`decrypt_value()`/`is_encrypted()`, and a `ConfigEncryptionError` (subclasses `RuntimeError`, deliberately *not* `ValueError`, so it is never accidentally swallowed by the existing `except (FileNotFoundError, ValueError)` clauses in `config_utils.py`). Missing or invalid `CONFIG_ENCRYPTION_KEY` always raises loudly — there is no plaintext fallback.
- `config_utils.py` is refactored so the plain "read config.json as JSON, no masking, no decryption" logic that already existed inline in `load_full_config()` becomes a named, reusable function `load_raw_config(db_dir)`. This is the single choke point every other function in the module builds on:
  - `load_full_config(db_dir, apply_masks=False)`: iterates the raw dict; for masked keys, `apply_masks=True` → `MASKED_SENTINEL` (never touches the ciphertext, so this path works even without `CONFIG_ENCRYPTION_KEY`); `apply_masks=False` → decrypts.
  - `get_config_value(key, db_dir, default, apply_masks=False)`: reads the raw dict but decrypts **only the single requested key**, not the whole config — this is the hot path (`Config.get()` / `get_plugin_config()` / every LLM provider reading its API key), so it must not pay a whole-config decryption cost (or a whole-config `CONFIG_ENCRYPTION_KEY` dependency) for every lookup, including lookups of unrelated, non-masked keys like `session.timeout`.
  - `get_config_metadata(key, db_dir)`: switched from `load_full_config()` to `load_raw_config()` — it only ever reads `.type`/`.values`/`.description`/`.masked` metadata suffixes, never the value itself, so it must never require the encryption key to be present.
  - `set_config_value(...)`: before overwriting `config_data[key]`, determines `is_masked = masked is True or config_data.get(f"{key}.masked") is True` (covering both "first time this key is marked masked=True" and "value update on an already-masked key where the caller didn't repeat masked=True"), and encrypts the value being persisted when `is_masked` is true. Rejects non-string values for masked keys (secrets are always strings; silently encrypting something else would be a footgun).
- Two existing HTTP-facing call sites in `fastapi_app/api/config.py` are fixed as part of this work because the refactor above makes their current behavior actively wasteful/risky: `GET /get/{key}` and the **unauthenticated** `GET /state` both currently call `config.load()` with `apply_masks=False`, which under the new code decrypts *every* masked secret in the whole config just to immediately mask or filter it back out. Both are changed to `config.load(apply_masks=True)` — same observable behavior, but they no longer decrypt anything, and `GET /state` in particular no longer requires `CONFIG_ENCRYPTION_KEY` to be valid just to serve an unauthenticated status check.
- **Fail loud, not silent, when the key is missing/wrong/rotated:** a startup check (`verify_config_encryption()`) runs in `fastapi_app/main.py`'s `lifespan()`, right after `ensure_db_initialized()` and before the rest of app startup. It loads the raw config, and if any key has `masked=True` with an already-encrypted (`enc:v1:`-prefixed) value while `CONFIG_ENCRYPTION_KEY` is unset or invalid, it logs a fatal error and re-raises so app startup aborts — instead of the first request that happens to touch that key crashing with a half-explained 500.
- **Migration** (existing plaintext masked values in already-deployed `data/db/config.json` files): this project's versioned migration system (`fastapi_app/lib/core/migrations/`, see `docs/development/migrations.md`) is SQLite-specific (`Migration.upgrade(conn: sqlite3.Connection)`) and does not touch `config.json` at all. Per `docs/development/migrations.md`'s own "Data Migrations vs. Schema Migrations" section, a one-off transformation of a JSON file's *contents* belongs in `bin/` as a standalone, idempotent, `--dry-run`-capable script (the pattern already used by `bin/migrations/migrate-tei-flavor-rename.py`), not as an entry under `migrations/versions/`. `bin/migrate-config-encrypt-secrets.py` finds every masked key whose stored value is not yet in `enc:v1:` format and re-saves it through the now-encryption-aware `set_config_value()` — reusing the existing atomic-write/file-lock machinery rather than hand-rolling a second writer.
- **"Show masked value" UX:** investigated as part of Task 3 below, and corrected outside this plan (see note). The masked-value editor (`app/src/modules/config-value-editor.js`) already never loads the stored/decrypted value into the DOM — it always starts from an empty input and requires the user to type a brand-new value to change a secret — and no server endpoint or client code path returns a decrypted value. However, `createMaskedValueEditor` did set Shoelace's `password-toggle` attribute on the `sl-input`, rendering a non-functional "eye" reveal icon: since `input.value` is always `''`, toggling it only ever revealed an empty field, never a secret — dead, confusing UI. **This was found and removed directly (not deferred to this plan)** in `app/src/modules/config-value-editor.js:145-151`, replaced with a comment explaining why the input must stay empty. This plan locks the underlying invariant in with a regression test (masked values can never appear in any config API response body, under any endpoint) — see Task 3.
- **Rotation/loss story:** documented explicitly in `docs/development/config-encryption.md` (Task 6). Short version: losing `CONFIG_ENCRYPTION_KEY` makes every masked value permanently unrecoverable by design (that is what "encryption at rest" means) — the documented recovery path is re-entering each secret through the config UI (which encrypts it fresh under whatever key is current), not any form of cryptographic recovery. Rotation is a decrypt-with-old/re-encrypt-with-new batch operation and is called out as a **future** script (`bin/rotate-config-encryption-key.py`), explicitly out of scope for this plan (not implemented here).

**Tech Stack:** Python 3.13, `cryptography` (Fernet — AES-128-CBC + HMAC-SHA256, authenticated, versioned token format; added as a new dependency via `uv add cryptography`), the existing `unittest.TestCase` + `tempfile.TemporaryDirectory` style already used in `tests/unit/fastapi/test_config_utils.py` (no new test framework), FastAPI `lifespan`.

**Design reference:** No separate spec document exists. This is Part 3 of a broader secret-handling hardening request; Parts 1–2 (a `.claude/settings.json` permission-deny rule blocking direct reads of `.env`/`.env.*`, and a "Secret handling" rule added to the root `CLAUDE.md`) were implemented directly in the same working session as this plan, on branch `feature/inference-settings-plugin`, and are independent of this plan's scope.

---

## File Structure

- `fastapi_app/lib/utils/config_crypto.py` (new) — `ConfigEncryptionError`, `encrypt_value()`, `decrypt_value()`, `is_encrypted()`
- `fastapi_app/lib/utils/config_utils.py` (modify) — `load_raw_config()` extraction, decrypt-on-read wiring, encrypt-on-write wiring, `find_unencrypted_masked_keys()`
- `fastapi_app/main.py` (modify) — call `verify_config_encryption()` during `lifespan()` startup
- `fastapi_app/api/config.py` (modify) — `GET /get/{key}` and `GET /state` switched to `apply_masks=True`
- `bin/migrate-config-encrypt-secrets.py` (new) — one-off idempotent migration script
- `tests/unit/fastapi/test_config_crypto.py` (new)
- `tests/unit/fastapi/test_config_utils.py` (modify) — add encryption-aware cases
- `tests/unit/fastapi/test_config_api_masking.py` (new) — regression lock: no config endpoint ever returns a decrypted masked value
- `docs/development/config-encryption.md` (new) — setup, rotation, loss/recovery story
- `.env`, `.env.development`, `.env.production` (modify) — add commented `CONFIG_ENCRYPTION_KEY` placeholder + generation command
- `pyproject.toml` / `uv.lock` (modify) — add `cryptography` dependency
- `CLAUDE.md` (modify) — cross-reference the new doc from the "Secret handling" rule added in Part 2

---

### Task 1: Encryption primitives (`config_crypto.py`)

**Files:**

- Create: `fastapi_app/lib/utils/config_crypto.py`
- Test: `tests/unit/fastapi/test_config_crypto.py`

- [ ] **Step 1: Write the failing test**

  Create `tests/unit/fastapi/test_config_crypto.py`:

  ```python
  """
  Unit tests for config_crypto.py

  Self-contained tests that can be run independently.

  @testCovers fastapi_app/lib/utils/config_crypto.py
  """

  import os
  import unittest
  from pathlib import Path
  from unittest import mock

  import sys
  sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

  from cryptography.fernet import Fernet

  from fastapi_app.lib.utils.config_crypto import (
      ConfigEncryptionError,
      encrypt_value,
      decrypt_value,
      is_encrypted,
  )

  VALID_KEY = Fernet.generate_key().decode()
  OTHER_KEY = Fernet.generate_key().decode()


  class TestConfigCrypto(unittest.TestCase):

      def test_round_trip(self):
          with mock.patch.dict(os.environ, {"CONFIG_ENCRYPTION_KEY": VALID_KEY}):
              ciphertext = encrypt_value("super-secret-api-key")
              self.assertTrue(is_encrypted(ciphertext))
              self.assertNotIn("super-secret-api-key", ciphertext)
              self.assertEqual(decrypt_value(ciphertext), "super-secret-api-key")

      def test_is_encrypted_false_for_plaintext(self):
          self.assertFalse(is_encrypted("plain-value"))
          self.assertFalse(is_encrypted(""))
          self.assertFalse(is_encrypted(None))

      def test_encrypt_without_key_raises(self):
          with mock.patch.dict(os.environ, {}, clear=True):
              with self.assertRaises(ConfigEncryptionError):
                  encrypt_value("secret")

      def test_decrypt_without_key_raises(self):
          with mock.patch.dict(os.environ, {"CONFIG_ENCRYPTION_KEY": VALID_KEY}):
              ciphertext = encrypt_value("secret")
          with mock.patch.dict(os.environ, {}, clear=True):
              with self.assertRaises(ConfigEncryptionError):
                  decrypt_value(ciphertext)

      def test_decrypt_with_wrong_key_raises(self):
          with mock.patch.dict(os.environ, {"CONFIG_ENCRYPTION_KEY": VALID_KEY}):
              ciphertext = encrypt_value("secret")
          with mock.patch.dict(os.environ, {"CONFIG_ENCRYPTION_KEY": OTHER_KEY}):
              with self.assertRaises(ConfigEncryptionError):
                  decrypt_value(ciphertext)

      def test_decrypt_rejects_plaintext_input(self):
          with mock.patch.dict(os.environ, {"CONFIG_ENCRYPTION_KEY": VALID_KEY}):
              with self.assertRaises(ConfigEncryptionError):
                  decrypt_value("not-actually-encrypted")

      def test_encrypt_refuses_double_encryption(self):
          with mock.patch.dict(os.environ, {"CONFIG_ENCRYPTION_KEY": VALID_KEY}):
              ciphertext = encrypt_value("secret")
              with self.assertRaises(ConfigEncryptionError):
                  encrypt_value(ciphertext)

      def test_invalid_key_format_raises(self):
          with mock.patch.dict(os.environ, {"CONFIG_ENCRYPTION_KEY": "not-a-valid-fernet-key"}):
              with self.assertRaises(ConfigEncryptionError):
                  encrypt_value("secret")


  if __name__ == "__main__":
      unittest.main()
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  uv run python -m pytest tests/unit/fastapi/test_config_crypto.py -v
  ```

  Expected: `ModuleNotFoundError: No module named 'fastapi_app.lib.utils.config_crypto'` (and/or `ImportError` for `cryptography` if not yet installed).

- [ ] **Step 3: Add the dependency and write the implementation**

  ```bash
  uv add cryptography
  ```

  Create `fastapi_app/lib/utils/config_crypto.py`:

  ```python
  """
  Symmetric encryption for config values marked masked=True.

  Encrypted values are stored in config.json as "enc:v1:<fernet-token>" so
  load_raw_config() (config_utils.py) can tell an already-encrypted value
  apart from legacy plaintext without needing the key. Encryption/decryption
  themselves require CONFIG_ENCRYPTION_KEY (an environment variable, set only
  in .env — see docs/development/config-encryption.md) and fail loudly
  (ConfigEncryptionError) rather than silently falling back to plaintext.
  """

  import os

  from cryptography.fernet import Fernet, InvalidToken

  _ENCRYPTED_PREFIX = "enc:v1:"


  class ConfigEncryptionError(RuntimeError):
      """Raised when a masked config value cannot be encrypted or decrypted.

      Deliberately does not subclass ValueError: several call sites in
      config_utils.py catch (FileNotFoundError, ValueError) around config
      reads/writes, and a missing/invalid encryption key must propagate
      instead of being swallowed there.
      """


  def _get_fernet() -> Fernet:
      key = os.environ.get("CONFIG_ENCRYPTION_KEY")
      if not key:
          raise ConfigEncryptionError(
              "CONFIG_ENCRYPTION_KEY is not set. It is required to read or write "
              "masked config values. See docs/development/config-encryption.md."
          )
      try:
          return Fernet(key.encode())
      except (ValueError, TypeError) as exc:
          raise ConfigEncryptionError(
              "CONFIG_ENCRYPTION_KEY is not a valid Fernet key. Generate one with: "
              "python -c \"from cryptography.fernet import Fernet; "
              "print(Fernet.generate_key().decode())\""
          ) from exc


  def is_encrypted(value: object) -> bool:
      """Return True if value looks like ciphertext produced by encrypt_value()."""
      return isinstance(value, str) and value.startswith(_ENCRYPTED_PREFIX)


  def encrypt_value(plaintext: str) -> str:
      """Encrypt plaintext for storage in config.json.

      Raises ConfigEncryptionError if CONFIG_ENCRYPTION_KEY is missing/invalid,
      or if plaintext is already in encrypted format (refuses to double-encrypt).
      """
      if is_encrypted(plaintext):
          raise ConfigEncryptionError("Refusing to double-encrypt an already-encrypted value.")
      token = _get_fernet().encrypt(plaintext.encode()).decode()
      return _ENCRYPTED_PREFIX + token


  def decrypt_value(stored: str) -> str:
      """Decrypt a value previously produced by encrypt_value().

      Raises ConfigEncryptionError if the value isn't in encrypted format, or if
      CONFIG_ENCRYPTION_KEY is missing, invalid, or does not match the key the
      value was encrypted with (wrong key, rotated key, or corrupted data).
      """
      if not is_encrypted(stored):
          raise ConfigEncryptionError(
              f"Value is not in encrypted format (missing '{_ENCRYPTED_PREFIX}' prefix)."
          )
      token = stored[len(_ENCRYPTED_PREFIX):]
      try:
          return _get_fernet().decrypt(token.encode()).decode()
      except InvalidToken as exc:
          raise ConfigEncryptionError(
              "Failed to decrypt config value: CONFIG_ENCRYPTION_KEY is wrong, "
              "rotated, or the stored value is corrupted."
          ) from exc
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  uv run python -m pytest tests/unit/fastapi/test_config_crypto.py -v
  ```

  Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

  ```bash
  git add fastapi_app/lib/utils/config_crypto.py tests/unit/fastapi/test_config_crypto.py pyproject.toml uv.lock
  git commit -m "$(cat <<'EOF'
  feat(config): add Fernet-based encryption primitives for masked config values

  Introduces config_crypto.py (encrypt_value/decrypt_value/is_encrypted,
  ConfigEncryptionError) as the foundation for encrypting masked config.json
  values at rest. Not yet wired into config_utils.py.

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 2: Wire encryption into `config_utils.py`

**Files:**

- Modify: `fastapi_app/lib/utils/config_utils.py`
- Test: `tests/unit/fastapi/test_config_utils.py`

- [ ] **Step 1: Write the failing tests**

  Append to `tests/unit/fastapi/test_config_utils.py` (inside `TestConfigUtils`, or a new `TestConfigUtilsEncryption(unittest.TestCase)` class in the same file, with the same `setUp`/`tearDown` pattern as the existing class plus a `CONFIG_ENCRYPTION_KEY` env patch):

  ```python
  import json
  import os
  from unittest import mock

  from cryptography.fernet import Fernet

  from fastapi_app.lib.utils.config_utils import (
      Config,
      get_config_metadata,
      load_raw_config,
      find_unencrypted_masked_keys,
  )
  from fastapi_app.lib.utils.config_crypto import ConfigEncryptionError, is_encrypted


  class TestConfigUtilsEncryption(unittest.TestCase):

      def setUp(self):
          self.temp_dir = tempfile.TemporaryDirectory()
          self.db_dir = Path(self.temp_dir.name)
          self.config = Config(self.db_dir)
          self.key_patch = mock.patch.dict(
              os.environ, {"CONFIG_ENCRYPTION_KEY": Fernet.generate_key().decode()}
          )
          self.key_patch.start()

      def tearDown(self):
          self.key_patch.stop()
          self.temp_dir.cleanup()

      def test_masked_value_is_encrypted_on_disk(self):
          self.config.set("plugin.kisski.api.key", "sk-real-secret", masked=True)

          raw_json = json.loads((self.db_dir / "config.json").read_text())
          self.assertTrue(is_encrypted(raw_json["plugin.kisski.api.key"]))
          self.assertNotIn("sk-real-secret", json.dumps(raw_json))

      def test_config_get_returns_decrypted_value(self):
          self.config.set("plugin.kisski.api.key", "sk-real-secret", masked=True)
          self.assertEqual(self.config.get("plugin.kisski.api.key"), "sk-real-secret")

      def test_load_apply_masks_never_decrypts(self):
          self.config.set("plugin.kisski.api.key", "sk-real-secret", masked=True)
          data = self.config.load(apply_masks=True)
          self.assertEqual(data["plugin.kisski.api.key"], "****")

      def test_load_apply_masks_true_works_without_key(self):
          self.config.set("plugin.kisski.api.key", "sk-real-secret", masked=True)
          self.key_patch.stop()
          try:
              data = self.config.load(apply_masks=True)
              self.assertEqual(data["plugin.kisski.api.key"], "****")
          finally:
              self.key_patch.start()

      def test_metadata_lookup_never_requires_key(self):
          self.config.set("plugin.kisski.api.key", "sk-real-secret", masked=True)
          self.key_patch.stop()
          try:
              meta = get_config_metadata("plugin.kisski.api.key", self.db_dir)
              self.assertTrue(meta["masked"])
          finally:
              self.key_patch.start()

      def test_updating_already_masked_key_stays_encrypted(self):
          self.config.set("plugin.kisski.api.key", "sk-first", masked=True)
          # Simulate the admin UI re-saving a new value without repeating masked=True
          self.config.set("plugin.kisski.api.key", "sk-second")
          raw_json = json.loads((self.db_dir / "config.json").read_text())
          self.assertTrue(is_encrypted(raw_json["plugin.kisski.api.key"]))
          self.assertEqual(self.config.get("plugin.kisski.api.key"), "sk-second")

      def test_get_without_key_raises_loudly(self):
          self.config.set("plugin.kisski.api.key", "sk-real-secret", masked=True)
          self.key_patch.stop()
          try:
              with self.assertRaises(ConfigEncryptionError):
                  self.config.get("plugin.kisski.api.key")
          finally:
              self.key_patch.start()

      def test_unmasked_values_are_unaffected(self):
          self.config.set("session.timeout", 3600)
          raw_json = json.loads((self.db_dir / "config.json").read_text())
          self.assertEqual(raw_json["session.timeout"], 3600)

      def test_find_unencrypted_masked_keys(self):
          # Write a masked key directly as plaintext, bypassing set_config_value,
          # to simulate a pre-existing plaintext secret from before this feature.
          config_path = self.db_dir / "config.json"
          config_path.write_text(json.dumps({
              "plugin.kisski.api.key": "sk-plaintext-legacy",
              "plugin.kisski.api.key.masked": True,
              "session.timeout": 3600,
          }))
          self.assertEqual(
              find_unencrypted_masked_keys(self.db_dir),
              ["plugin.kisski.api.key"],
          )

      def test_find_unencrypted_masked_keys_empty_once_migrated(self):
          self.config.set("plugin.kisski.api.key", "sk-real-secret", masked=True)
          self.assertEqual(find_unencrypted_masked_keys(self.db_dir), [])
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  uv run python -m pytest tests/unit/fastapi/test_config_utils.py -v
  ```

  Expected: `ImportError: cannot import name 'load_raw_config'` (and similar for `find_unencrypted_masked_keys`).

- [ ] **Step 3: Write the implementation**

  In `fastapi_app/lib/utils/config_utils.py`:

  Add the import near the top (after the existing `get_data_file_path` import):

  ```python
  from fastapi_app.lib.utils.config_crypto import encrypt_value, decrypt_value, is_encrypted
  ```

  Replace the body of `load_full_config` (lines 169–201) — extract the raw-read logic into a new public `load_raw_config`, and make `load_full_config` decrypt-or-mask on top of it:

  ```python
  def load_raw_config(db_dir: Path) -> dict:
      """
      Load config.json exactly as stored on disk: no masking, no decryption.

      Used by callers that only need metadata (get_config_metadata) or that
      operate on ciphertext directly (find_unencrypted_masked_keys, the
      bin/migrate-config-encrypt-secrets.py migration). Never requires
      CONFIG_ENCRYPTION_KEY.

      Args:
          db_dir: Path to the database directory containing config.json

      Returns:
          Configuration dictionary, exactly as persisted
      """
      config_file = get_data_file_path(db_dir, 'config')

      if not config_file.exists():
          config_file.parent.mkdir(parents=True, exist_ok=True)
          with open(config_file, 'w', encoding='utf-8') as f:
              json.dump({}, f, indent=2)
          return {}

      try:
          with open(config_file, 'r', encoding='utf-8') as f:
              return json.load(f)
      except (IOError, json.JSONDecodeError):
          return {}


  def load_full_config(db_dir: Path, apply_masks: bool = False) -> dict:
      """
      Load complete configuration from config.json, resolving masked keys.

      Args:
          db_dir: Path to the database directory containing config.json
          apply_masks: When True, replace masked values with MASKED_SENTINEL
              (no decryption attempted — safe to use without CONFIG_ENCRYPTION_KEY).
              When False, masked values are decrypted to their real value
              (raises ConfigEncryptionError if CONFIG_ENCRYPTION_KEY is
              missing/invalid).

      Returns:
          Configuration dictionary
      """
      data = load_raw_config(db_dir)

      for key in list(data.keys()):
          if not key.endswith(_METADATA_SUFFIXES) and data.get(f"{key}.masked") is True:
              data[key] = MASKED_SENTINEL if apply_masks else decrypt_value(data[key])

      return data
  ```

  Replace `get_config_value` (lines 204–223) to decrypt only the requested key:

  ```python
  def get_config_value(key: str, db_dir: Path, default: Any = None, apply_masks: bool = False) -> Any:
      """
      Get a configuration value with dot notation support.

      Decrypts only the requested key when it is masked (not the whole config),
      so looking up an unrelated key never requires CONFIG_ENCRYPTION_KEY.

      Args:
          key: The configuration key (supports dot notation like "session.timeout")
          db_dir: Path to the database directory containing config.json
          default: Default value if key not found
          apply_masks: When True, return MASKED_SENTINEL for masked keys instead
              of decrypting

      Returns:
          The configuration value or default
      """
      try:
          data = load_raw_config(db_dir)
      except (FileNotFoundError, ValueError):
          return default

      if key not in data:
          return default

      if data.get(f"{key}.masked") is True:
          return MASKED_SENTINEL if apply_masks else decrypt_value(data[key])

      return data[key]
  ```

  In `get_config_metadata` (line 236), change the source of `config_data` from `load_full_config(db_dir)` to `load_raw_config(db_dir)` — metadata never touches the actual value, so it must never require the encryption key:

  ```python
  def get_config_metadata(key: str, db_dir: Path) -> dict[str, Any]:
      """Return type, values, description, and masked metadata for a config key.
      ...
      """
      config_data = load_raw_config(db_dir)
      return {
          "type": config_data.get(f"{key}.type"),
          "values": config_data.get(f"{key}.values"),
          "description": config_data.get(f"{key}.description"),
          "masked": config_data.get(f"{key}.masked", False),
      }
  ```

  In `set_config_value`, right before the existing `# Set the value` / `config_data[key] = value` line (line 313–314), insert the masked-detection-and-encrypt step:

  ```python
                  # Determine masked status BEFORE overwriting config_data[key]: either
                  # this call explicitly passes masked=True, or the key was already
                  # marked masked=True by a prior set() call (re-saving a secret's
                  # value doesn't require repeating masked=True every time).
                  is_masked = masked is True or config_data.get(f"{key}.masked") is True
                  if is_masked and not isinstance(value, str):
                      return False, "Masked config values must be strings"
                  stored_value = encrypt_value(value) if is_masked else value

                  # Set the value
                  config_data[key] = stored_value
  ```

  (`value` itself is left untouched so the existing type-inference block below, which calls `_get_json_type(value)`, keeps inferring the type of the real plaintext rather than the ciphertext.)

  Add `find_unencrypted_masked_keys` near the other module-level functions (after `get_config_metadata` is a reasonable spot):

  ```python
  def find_unencrypted_masked_keys(db_dir: Path) -> list[str]:
      """
      Return keys with {key}.masked = True whose stored value is not yet encrypted.

      Used by bin/migrate-config-encrypt-secrets.py to find legacy plaintext
      secrets written before this feature existed.

      Args:
          db_dir: Path to the database directory containing config.json

      Returns:
          List of config keys (not metadata sub-keys) needing migration
      """
      data = load_raw_config(db_dir)
      return [
          key for key in data
          if not key.endswith(_METADATA_SUFFIXES)
          and data.get(f"{key}.masked") is True
          and not is_encrypted(data[key])
      ]
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  uv run python -m pytest tests/unit/fastapi/test_config_utils.py -v
  ```

  Expected: PASS (all existing tests + 10 new tests)

- [ ] **Step 5: Commit**

  ```bash
  git add fastapi_app/lib/utils/config_utils.py tests/unit/fastapi/test_config_utils.py
  git commit -m "$(cat <<'EOF'
  feat(config): encrypt masked config.json values at rest

  Wires config_crypto's encrypt/decrypt into config_utils.py:
  - load_raw_config() extracted as the single "no masking, no decryption" read
  - set_config_value() encrypts values of keys flagged masked=True
  - get_config_value() decrypts only the requested key (not the whole config)
  - get_config_metadata() switched to load_raw_config() (never needs the key)
  - find_unencrypted_masked_keys() added for the migration script

  Backend callers (config.get()) keep receiving the real decrypted value;
  apply_masks=True callers keep receiving MASKED_SENTINEL without ever
  decrypting anything.

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 3: Harden the config API endpoints + lock in the no-reveal invariant

**Files:**

- Modify: `fastapi_app/api/config.py`
- Test: `tests/unit/fastapi/test_config_api_masking.py`

- [ ] **Step 1: Write the failing tests**

  Create `tests/unit/fastapi/test_config_api_masking.py`. Follow this project's existing FastAPI route test conventions (`app.dependency_overrides` for auth — check a sibling test file such as `tests/unit/fastapi/test_config_utils.py`'s neighbors under `tests/unit/fastapi/` for the exact override pattern used for `require_authenticated_user` and adapt it here; the shape below shows the required assertions, not the final fixture wiring):

  ```python
  """
  Regression tests: no config HTTP endpoint may ever return a decrypted masked value.

  @testCovers fastapi_app/api/config.py
  """

  import json
  import os
  import unittest
  from pathlib import Path
  from unittest import mock

  from cryptography.fernet import Fernet
  from fastapi.testclient import TestClient

  # Adapt these imports/fixtures to match this project's existing FastAPI test
  # setup (see other files under tests/unit/fastapi/ for the TestClient +
  # dependency_overrides pattern already used for require_authenticated_user).


  class TestConfigApiMasking(unittest.TestCase):

      def setUp(self):
          # ... construct a TestClient against a temp db_dir, override auth,
          # seed a masked key via Config(db_dir).set(..., masked=True) ...
          pass

      def test_list_never_returns_decrypted_value(self):
          resp = self.client.get("/api/v1/config/list")
          self.assertEqual(resp.json()["plugin.kisski.api.key"], "****")

      def test_get_by_key_never_returns_decrypted_value(self):
          resp = self.client.get("/api/v1/config/get/plugin.kisski.api.key")
          self.assertEqual(resp.json(), "****")

      def test_get_by_key_works_without_encryption_key(self):
          # GET /get/{key} must not require CONFIG_ENCRYPTION_KEY to serve a
          # masked key's sentinel, nor to serve an unrelated non-masked key.
          with mock.patch.dict(os.environ, {}, clear=True):
              resp = self.client.get("/api/v1/config/get/plugin.kisski.api.key")
              self.assertEqual(resp.status_code, 200)
              self.assertEqual(resp.json(), "****")

      def test_state_never_returns_masked_value_and_works_unauthenticated(self):
          resp = self.client.get("/api/v1/state")
          self.assertNotIn("plugin.kisski.api.key", resp.json()["publicConfig"])

      def test_state_works_without_encryption_key(self):
          with mock.patch.dict(os.environ, {}, clear=True):
              resp = self.client.get("/api/v1/state")
              self.assertEqual(resp.status_code, 200)


  if __name__ == "__main__":
      unittest.main()
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  uv run python -m pytest tests/unit/fastapi/test_config_api_masking.py -v
  ```

  Expected: `test_get_by_key_works_without_encryption_key` and `test_state_works_without_encryption_key` FAIL with `ConfigEncryptionError` bubbling up as a 500, since `config.load()` (no `apply_masks`) still eagerly decrypts every masked key at this point.

- [ ] **Step 3: Write the implementation**

  In `fastapi_app/api/config.py`:

  Line 121, inside `get_config_value_endpoint`, change:

  ```python
      config_data = config.load()
  ```

  to:

  ```python
      config_data = config.load(apply_masks=True)
  ```

  (The existing `if config_data.get(f"{key}.masked") is True: return MASKED_SENTINEL` check at line 126–127 stays as an intentional belt-and-suspenders check — `config_data[key]` is already `MASKED_SENTINEL` at that point, so this is now redundant-but-harmless, mirroring the pattern-based safety net already used in `_get_public_config`.)

  Line 255, inside `get_state`, change:

  ```python
          publicConfig=_get_public_config(config.load()),
  ```

  to:

  ```python
          publicConfig=_get_public_config(config.load(apply_masks=True)),
  ```

  (`_get_public_config` already excludes any key whose `.masked` flag is true regardless of what the value currently holds, so this is behavior-preserving — it just stops decrypting secrets that get thrown away one line later, on the one endpoint that doesn't even require authentication.)

  **"Show masked value" UX — already done:** the non-functional `password-toggle` "eye" icon on the masked-value editor (`app/src/modules/config-value-editor.js:145-151`, `createMaskedValueEditor`) was found and removed directly in the same session this plan was written, ahead of this task — it toggled visibility of an input that is always empty (`input.value = ''`), so it never revealed anything real. A comment now documents why the input must stay empty, so a future edit doesn't "fix" it into loading the real value. No further frontend change is expected here; re-check both `config-value-editor.js` and `app/src/plugins/config-editor.js` at implementation time in case a different reveal path exists elsewhere that this plan's research missed, and remove it here with a matching backend regression test above if found.

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  uv run python -m pytest tests/unit/fastapi/test_config_api_masking.py -v
  ```

  Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

  ```bash
  git add fastapi_app/api/config.py tests/unit/fastapi/test_config_api_masking.py app/src/modules/config-value-editor.js
  git commit -m "$(cat <<'EOF'
  fix(config-api): stop decrypting masked secrets that are immediately discarded

  GET /get/{key} and the unauthenticated GET /state both loaded the full
  config with apply_masks=False, decrypting every masked secret only to mask
  or filter it back out one line later. Switch both to apply_masks=True:
  same response, no unnecessary decryption, and /state no longer needs
  CONFIG_ENCRYPTION_KEY to serve an unauthenticated status check.

  Also locks in, via regression test, that no config endpoint can ever
  return a decrypted masked value.

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 4: Fail-fast startup check

**Files:**

- Modify: `fastapi_app/lib/utils/config_crypto.py` (add `verify_config_encryption`)
- Modify: `fastapi_app/main.py` (call it from `lifespan`)
- Test: `tests/unit/fastapi/test_config_crypto.py`

- [ ] **Step 1: Write the failing test**

  Append to `tests/unit/fastapi/test_config_crypto.py`:

  ```python
  import json
  import tempfile

  from fastapi_app.lib.utils.config_crypto import verify_config_encryption


  class TestVerifyConfigEncryption(unittest.TestCase):

      def setUp(self):
          self.temp_dir = tempfile.TemporaryDirectory()
          self.db_dir = Path(self.temp_dir.name)

      def tearDown(self):
          self.temp_dir.cleanup()

      def _write_config(self, data: dict) -> None:
          (self.db_dir / "config.json").write_text(json.dumps(data))

      def test_passes_when_no_masked_keys_exist(self):
          self._write_config({"session.timeout": 3600})
          with mock.patch.dict(os.environ, {}, clear=True):
              verify_config_encryption(self.db_dir)  # must not raise

      def test_passes_when_key_present_and_valid(self):
          key = Fernet.generate_key().decode()
          with mock.patch.dict(os.environ, {"CONFIG_ENCRYPTION_KEY": key}):
              ciphertext = "enc:v1:" + Fernet(key.encode()).encrypt(b"secret").decode()
              self._write_config({
                  "plugin.kisski.api.key": ciphertext,
                  "plugin.kisski.api.key.masked": True,
              })
              verify_config_encryption(self.db_dir)  # must not raise

      def test_raises_when_key_missing_but_encrypted_values_exist(self):
          key = Fernet.generate_key().decode()
          ciphertext = "enc:v1:" + Fernet(key.encode()).encrypt(b"secret").decode()
          self._write_config({
              "plugin.kisski.api.key": ciphertext,
              "plugin.kisski.api.key.masked": True,
          })
          with mock.patch.dict(os.environ, {}, clear=True):
              with self.assertRaises(ConfigEncryptionError):
                  verify_config_encryption(self.db_dir)

      def test_raises_when_key_present_but_wrong(self):
          key = Fernet.generate_key().decode()
          ciphertext = "enc:v1:" + Fernet(key.encode()).encrypt(b"secret").decode()
          self._write_config({
              "plugin.kisski.api.key": ciphertext,
              "plugin.kisski.api.key.masked": True,
          })
          with mock.patch.dict(os.environ, {"CONFIG_ENCRYPTION_KEY": Fernet.generate_key().decode()}):
              with self.assertRaises(ConfigEncryptionError):
                  verify_config_encryption(self.db_dir)
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  uv run python -m pytest tests/unit/fastapi/test_config_crypto.py -v
  ```

  Expected: `ImportError: cannot import name 'verify_config_encryption'`

- [ ] **Step 3: Write the implementation**

  Add to `fastapi_app/lib/utils/config_crypto.py` (note: this needs `load_raw_config`, `_METADATA_SUFFIXES` from `config_utils.py` — import locally inside the function to avoid a circular import at module load time, since `config_utils.py` imports from `config_crypto.py`):

  ```python
  def verify_config_encryption(db_dir) -> None:
      """
      Fail fast at startup if masked config values exist but cannot be decrypted.

      Called from fastapi_app/main.py's lifespan(). Raises ConfigEncryptionError
      (rather than deferring the failure to whichever request first touches an
      encrypted key) when CONFIG_ENCRYPTION_KEY is missing, invalid, or does not
      match the key used to encrypt an existing value.
      """
      from fastapi_app.lib.utils.config_utils import load_raw_config, _METADATA_SUFFIXES

      data = load_raw_config(db_dir)
      encrypted_keys = [
          key for key in data
          if not key.endswith(_METADATA_SUFFIXES)
          and data.get(f"{key}.masked") is True
          and is_encrypted(data[key])
      ]
      for key in encrypted_keys:
          decrypt_value(data[key])  # raises ConfigEncryptionError on failure
  ```

  In `fastapi_app/main.py`, inside `lifespan()`, right after the existing `ensure_db_initialized(...)` try/except block (after line 64, before the `# Now load config...` comment at line 66):

  ```python
      # Fail fast if masked config values exist but CONFIG_ENCRYPTION_KEY is
      # missing/invalid, instead of the first request that touches one crashing.
      from .lib.utils.config_crypto import verify_config_encryption, ConfigEncryptionError
      try:
          verify_config_encryption(db_dir)
      except ConfigEncryptionError as e:
          logger.error(f"Config encryption check failed: {e}")
          raise
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  uv run python -m pytest tests/unit/fastapi/test_config_crypto.py -v
  ```

  Expected: PASS (12 tests total in this file)

- [ ] **Step 5: Commit**

  ```bash
  git add fastapi_app/lib/utils/config_crypto.py fastapi_app/main.py tests/unit/fastapi/test_config_crypto.py
  git commit -m "$(cat <<'EOF'
  feat(config): fail startup fast when CONFIG_ENCRYPTION_KEY can't decrypt masked config

  Adds verify_config_encryption(), called from lifespan() right after database
  initialization. If config.json has masked keys already stored encrypted but
  the key to decrypt them is missing, invalid, or wrong, the app now refuses
  to start with a clear log message instead of failing on the first request
  that happens to touch that key.

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 5: Migration script for existing plaintext secrets

**Files:**

- Create: `bin/migrate-config-encrypt-secrets.py`
- Test: `fastapi_app/lib/core/migrations/tests/test_migrate_config_encrypt_secrets.py` (manual-verification style, per the `fastapi_app/CLAUDE.md` convention that migration tests live under `fastapi_app/lib/core/migrations/tests/` and are not part of the CI-run suite — even though this is a `bin/`-style migration rather than a `Migration` subclass, it is still a migration and belongs alongside the others for discoverability)

- [ ] **Step 1: Write the failing test**

  Create `fastapi_app/lib/core/migrations/tests/test_migrate_config_encrypt_secrets.py`:

  ```python
  """
  Manual verification test for bin/migrate-config-encrypt-secrets.py.

  Not run automatically in CI (see fastapi_app/CLAUDE.md "Migration tests
  location"). Run directly:
      uv run python fastapi_app/lib/core/migrations/tests/test_migrate_config_encrypt_secrets.py
  """

  import json
  import os
  import sys
  import tempfile
  import unittest
  from pathlib import Path
  from unittest import mock

  project_root = Path(__file__).parent.parent.parent.parent.parent
  sys.path.insert(0, str(project_root))
  sys.path.insert(0, str(project_root / "bin"))

  from cryptography.fernet import Fernet

  from fastapi_app.lib.utils.config_utils import find_unencrypted_masked_keys, Config
  from fastapi_app.lib.utils.config_crypto import is_encrypted

  import importlib
  migrate = importlib.import_module("migrate-config-encrypt-secrets")


  class TestMigrateConfigEncryptSecrets(unittest.TestCase):

      def setUp(self):
          self.temp_dir = tempfile.TemporaryDirectory()
          self.db_dir = Path(self.temp_dir.name)
          self.key_patch = mock.patch.dict(
              os.environ, {"CONFIG_ENCRYPTION_KEY": Fernet.generate_key().decode()}
          )
          self.key_patch.start()

      def tearDown(self):
          self.key_patch.stop()
          self.temp_dir.cleanup()

      def test_encrypts_legacy_plaintext_value(self):
          (self.db_dir / "config.json").write_text(json.dumps({
              "plugin.kisski.api.key": "sk-plaintext-legacy",
              "plugin.kisski.api.key.masked": True,
              "session.timeout": 3600,
          }))

          keys = migrate.find_unencrypted_masked_keys(self.db_dir)
          self.assertEqual(keys, ["plugin.kisski.api.key"])

          migrate.migrate_config(self.db_dir, dry_run=False)

          raw = json.loads((self.db_dir / "config.json").read_text())
          self.assertTrue(is_encrypted(raw["plugin.kisski.api.key"]))
          self.assertEqual(raw["session.timeout"], 3600)
          self.assertEqual(Config(self.db_dir).get("plugin.kisski.api.key"), "sk-plaintext-legacy")

      def test_dry_run_makes_no_changes(self):
          (self.db_dir / "config.json").write_text(json.dumps({
              "plugin.kisski.api.key": "sk-plaintext-legacy",
              "plugin.kisski.api.key.masked": True,
          }))
          migrate.migrate_config(self.db_dir, dry_run=True)
          raw = json.loads((self.db_dir / "config.json").read_text())
          self.assertEqual(raw["plugin.kisski.api.key"], "sk-plaintext-legacy")

      def test_idempotent_second_run(self):
          (self.db_dir / "config.json").write_text(json.dumps({
              "plugin.kisski.api.key": "sk-plaintext-legacy",
              "plugin.kisski.api.key.masked": True,
          }))
          migrate.migrate_config(self.db_dir, dry_run=False)
          first_pass = json.loads((self.db_dir / "config.json").read_text())

          migrate.migrate_config(self.db_dir, dry_run=False)
          second_pass = json.loads((self.db_dir / "config.json").read_text())

          self.assertEqual(first_pass, second_pass)
          self.assertEqual(find_unencrypted_masked_keys(self.db_dir), [])


  if __name__ == "__main__":
      unittest.main()
  ```

  (`bin/migrate-config-encrypt-secrets.py` has a hyphenated filename, like the other `bin/migrate-*.py` scripts, so it must be imported via `importlib.import_module` rather than a normal `import` statement — mirror however the existing `bin/migrations/migrate-tei-flavor-rename.py` is imported by its own tests, if it has any, for consistency.)

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  uv run python fastapi_app/lib/core/migrations/tests/test_migrate_config_encrypt_secrets.py
  ```

  Expected: `ModuleNotFoundError: No module named 'migrate-config-encrypt-secrets'`

- [ ] **Step 3: Write the implementation**

  Create `bin/migrate-config-encrypt-secrets.py`:

  ```python
  #!/usr/bin/env python3
  """
  Encrypt existing plaintext masked config values in data/db/config.json in place.

  Every config key with `{key}.masked = True` is expected to hold its value
  encrypted (see fastapi_app/lib/utils/config_crypto.py) once
  CONFIG_ENCRYPTION_KEY is configured. Config values set before that feature
  existed are still plaintext on disk. This script finds every such key and
  re-saves its current (plaintext) value through set_config_value(), which
  transparently encrypts it because {key}.masked is already True.

  This is a one-off data migration (see docs/development/migrations.md "Data
  Migrations vs. Schema Migrations"), not part of the auto-run schema-migration
  framework: config.json is not a SQLite database. It is idempotent: a key
  whose stored value already carries the "enc:v1:" prefix is left untouched,
  so a second run reports nothing to do.

  Requires CONFIG_ENCRYPTION_KEY to be set in the environment (see
  docs/development/config-encryption.md).

  Usage:
      uv run python bin/migrate-config-encrypt-secrets.py [options]

  Options:
      --dry-run     Show which keys would be encrypted without writing
      -v/--verbose  Enable debug logging
  """

  import sys
  import argparse
  import logging
  from pathlib import Path

  project_root = Path(__file__).parent.parent
  sys.path.insert(0, str(project_root))

  from fastapi_app.config import get_settings
  from fastapi_app.lib.utils.config_utils import (
      find_unencrypted_masked_keys,
      load_raw_config,
      set_config_value,
  )
  from fastapi_app.lib.utils.config_crypto import ConfigEncryptionError

  logger = logging.getLogger(__name__)


  def migrate_config(db_dir: Path, dry_run: bool) -> int:
      """Encrypt every masked config value still stored in plaintext. Returns exit code."""
      keys = find_unencrypted_masked_keys(db_dir)

      if not keys:
          logger.info("No plaintext masked config values found. Nothing to do.")
          return 0

      logger.info(
          f"Found {len(keys)} masked config value(s) still stored in plaintext: "
          f"{', '.join(keys)}"
      )

      if dry_run:
          logger.info("Dry run: no changes written.")
          return 0

      raw = load_raw_config(db_dir)
      for key in keys:
          plaintext = raw[key]
          try:
              success, message = set_config_value(key, plaintext, db_dir)
          except ConfigEncryptionError as e:
              logger.error(f"Cannot encrypt '{key}': {e}")
              return 1
          if not success:
              logger.error(f"Failed to re-save '{key}': {message}")
              return 1
          logger.info(f"Encrypted '{key}'")

      logger.info(f"Migration complete: {len(keys)} value(s) encrypted.")
      return 0


  def main() -> int:
      parser = argparse.ArgumentParser(
          description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
      )
      parser.add_argument("--dry-run", action="store_true", help="Show what would change without writing")
      parser.add_argument("-v", "--verbose", action="store_true", help="Enable debug logging")
      args = parser.parse_args()

      logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(message)s")

      db_dir = get_settings().db_dir
      return migrate_config(db_dir, dry_run=args.dry_run)


  if __name__ == "__main__":
      sys.exit(main())
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  uv run python fastapi_app/lib/core/migrations/tests/test_migrate_config_encrypt_secrets.py
  ```

  Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

  ```bash
  git add bin/migrate-config-encrypt-secrets.py fastapi_app/lib/core/migrations/tests/test_migrate_config_encrypt_secrets.py
  git commit -m "$(cat <<'EOF'
  feat(config): add one-off migration to encrypt legacy plaintext masked secrets

  bin/migrate-config-encrypt-secrets.py finds every masked config.json key
  whose stored value predates encryption-at-rest and re-saves it through
  set_config_value(), which now encrypts it transparently. Idempotent and
  --dry-run capable, following the bin/migrate-*.py one-off data migration
  pattern (config.json isn't part of the SQLite schema-migration framework).

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 6: Documentation — setup, rotation, and the key-loss recovery story

**Files:**

- Create: `docs/development/config-encryption.md`
- Modify: `.env`, `.env.development`, `.env.production` (add commented placeholder)
- Modify: `CLAUDE.md` (cross-reference)

- [ ] **Step 1: Write `docs/development/config-encryption.md`**

  Cover, in this order (prose, not code — no TDD steps for a docs-only task):

  1. **What is encrypted and why**: only config.json values flagged `masked=True` (API keys, passwords set via `get_plugin_config(..., masked=True)` or the admin config UI); the `.masked`/`.type`/`.values`/`.description` metadata and every non-masked value stay plaintext JSON, so the file remains diffable/inspectable except for the secret values themselves.
  2. **Setup**: generate a key with `uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`, add it to `.env` as `CONFIG_ENCRYPTION_KEY=...` (never commit it; `.env` is already covered by the `permissions.deny` rule in `.claude/settings.json` and the "Secret handling" rule in `CLAUDE.md`). Note that `.env.development`/`.env.production` ship a commented-out placeholder line, not a real key.
  3. **Existing deployments / migration**: run `uv run python bin/migrate-config-encrypt-secrets.py --dry-run` first, then without `--dry-run`, once `CONFIG_ENCRYPTION_KEY` is set. Safe to run repeatedly (idempotent).
  4. **Rotation** (explicitly **not implemented** by this plan — documented as a known gap): rotating the key requires decrypting every masked value with the old key and re-encrypting with the new one while both are available. A future `bin/rotate-config-encryption-key.py`, taking `CONFIG_ENCRYPTION_KEY_OLD` and `CONFIG_ENCRYPTION_KEY` (new), is the planned shape; until it exists, rotation is a manual, unsupported operation — don't rotate the key on a system with masked values set unless you're prepared to re-enter them.
  5. **Key loss / the recovery story (must be explicit, no happy-path-only)**: if `CONFIG_ENCRYPTION_KEY` is lost, rotated without a proper migration, or simply wrong, every masked config value becomes **permanently unrecoverable** — this is the intended behavior of encryption at rest, not a bug. `verify_config_encryption()` makes this failure loud and immediate at startup rather than a confusing runtime error later. There is no cryptographic recovery path. The documented remediation is: an admin re-enters each affected secret (e.g., re-pastes the KISSKI API key) through the config UI, which encrypts it fresh under the current key on save. Recommend backing up `CONFIG_ENCRYPTION_KEY` the same way other production secrets are backed up (a password manager / secrets vault), not solely as a line in the local `.env` file.
  6. **What stays unchanged from the frontend's perspective**: `/api/v1/config/list`, `/api/v1/config/get/{key}`, and `/api/v1/state` always return `MASKED_SENTINEL` ("****") for masked keys, exactly as before this feature — encryption is purely a disk-at-rest concern for the backend's own storage, and the client never receives a decrypted value.

- [ ] **Step 2: Add commented placeholders to the env template files**

  In `.env`, `.env.development`, and `.env.production`, near other secret-bearing entries (e.g. next to `KISSKI_API_KEY`), add:

  ```bash
  # Encrypts masked config.json values (API keys, passwords) at rest.
  # Generate with: uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
  # See docs/development/config-encryption.md. Losing this key makes masked
  # config values unrecoverable — back it up like any other production secret.
  # CONFIG_ENCRYPTION_KEY=
  ```

- [ ] **Step 3: Cross-reference from CLAUDE.md**

  In the root `CLAUDE.md`, extend the "Secret handling" bullet added in Part 2 of this session's work with a pointer to the new doc, e.g. append: `"See [docs/development/config-encryption.md](docs/development/config-encryption.md) for how masked config.json values (API keys, passwords) are encrypted at rest."`

- [ ] **Step 4: Commit**

  ```bash
  git add docs/development/config-encryption.md .env.development .env.production CLAUDE.md
  git commit -m "$(cat <<'EOF'
  docs(config): document config encryption setup, migration, and key-loss story

  Adds docs/development/config-encryption.md covering CONFIG_ENCRYPTION_KEY
  setup, the migration script, the (currently unimplemented) rotation story,
  and the explicit recovery path when the key is lost: masked values become
  unrecoverable by design, and the remediation is re-entering secrets through
  the config UI, not any form of cryptographic recovery.

  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  EOF
  )"
  ```

  (Do not modify the working `.env` file itself in this commit — it's git-ignored and holds this developer's real secrets; the placeholder line is for the template files only. Add it to local `.env` by hand, or note it needs adding, without staging `.env`.)

---

### Task 7: Full regression pass and manual verification (no code changes)

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend unit test suite**

  ```bash
  uv run python -m pytest tests/unit/fastapi/ -v
  ```

  Expected: all tests pass, including every test added in Tasks 1–4.

- [ ] **Step 2: Run the config migration's manual test file**

  ```bash
  uv run python fastapi_app/lib/core/migrations/tests/test_migrate_config_encrypt_secrets.py
  ```

  Expected: PASS (per `fastapi_app/CLAUDE.md`, this file is not part of the automatically-run suite, so it must be run manually here).

- [ ] **Step 3: Manual verification** — cannot be automated in this session; ask the user to confirm:

  - Generate a real `CONFIG_ENCRYPTION_KEY`, set it in the running dev server's `.env`, restart is not required per this project's rules (server auto-reloads) — but confirm the running server actually picked up the new env var (a code change to `.env` alone does not get re-read by an already-running process's `os.environ`; note this to the user rather than assuming it).
  - Through the config UI (admin), set `plugin.kisski.api.key` to a real (or dummy) value; confirm `data/db/config.json` on disk shows `enc:v1:...` for that key, not the plaintext.
  - Reload the config UI; confirm the field still shows the "(set but hidden)" placeholder behavior exactly as before — no plaintext or ciphertext ever appears in the browser.
  - Make a live KISSKI/OpenAI-compatible request (e.g. via the app's inference settings UI, or `node scripts/dev/debug-api.js`) and confirm the provider still authenticates successfully — i.e. `config.get()` is still handing the real decrypted key to `OpenAICompatibleProvider`.
  - Unset `CONFIG_ENCRYPTION_KEY` and attempt to start the server; confirm it refuses to start with a clear log message (rather than starting and failing confusingly on the first LLM request).
  - Run `uv run python bin/migrate-config-encrypt-secrets.py --dry-run` against a real (or copied) `data/db/config.json` that predates this feature, and confirm it correctly identifies legacy plaintext masked keys.

  No commit needed for this task.
