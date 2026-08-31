# TEI Flavor Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic `bin/` script that renames a GROBID processing flavor value in all stored TEI documents (re-queuing them for sync), and rename `article/dh-law-footnotes` → `article/footnotes-refs` in source, config, and docs.

**Architecture:** A standalone data-migration script (not the auto-run schema-migration framework) parses each TEI document with lxml, does a surgical string replace of the flavor value, writes the new content to content-addressed storage via `FileStorage.save_file`, and repoints the DB record with `FileRepository.update_file(old_id, FileUpdate(id=new_hash, ...))` — which auto-sets `sync_status='modified'`. Separately, the literal flavor string is renamed everywhere it is hardcoded so new extractions use the new name.

**Tech Stack:** Python 3.13, `uv`, lxml, FastAPI app libs (`FileRepository`, `FileStorage`, `DatabaseManager`), argparse.

**Spec:** `docs/superpowers/specs/2026-08-30-tei-flavor-rename-design.md`

---

## File Structure

- **Create** `bin/migrate-tei-flavor-rename.py` — the generic rename script. One responsibility: rewrite the flavor label value across stored TEI documents and re-queue affected records. Contains a pure transform (`rename_flavor_in_tei`) and an I/O runner (`run_migration`).
- **Modify** `fastapi_app/plugins/grobid/config/variants.py` — `PROCESSING_FLAVORS` list value.
- **Modify** `fastapi_app/lib/utils/tei_utils.py` — hardcoded literal in the (callerless, legacy) `create_encoding_desc_with_grobid`.
- **Modify** `fastapi_app/plugins/grobid/routes.py` — docstring example.
- **Modify** `fastapi_app/plugins/grobid/README.md` — supported-values line.
- **Modify** `docs/user-manual/batch-processing.md` — CLI example.
- **Modify** `docs/development/example.tei.xml` — sample flavor label value.

No automated tests (per spec — existing `bin/migrate-tei-*.py` scripts ship none; this is a one-off invocation of a generic tool).

---

## Task 1: Commit the approved spec

**Files:**
- Add: `docs/superpowers/specs/2026-08-30-tei-flavor-rename-design.md` (already written)
- Add: `docs/superpowers/plans/2026-08-31-tei-flavor-rename.md` (this file)

- [ ] **Step 1: Stage and commit the design + plan docs**

```bash
git add docs/superpowers/specs/2026-08-30-tei-flavor-rename-design.md docs/superpowers/plans/2026-08-31-tei-flavor-rename.md
git commit -m "docs: spec + plan for TEI flavor rename migration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Expected: one commit created on branch `feat/tei-flavor-rename`.

---

## Task 2: Create the generic flavor-rename script

**Files:**
- Create: `bin/migrate-tei-flavor-rename.py`

- [ ] **Step 1: Write the script**

Create `bin/migrate-tei-flavor-rename.py` with exactly this content:

```python
#!/usr/bin/env python3
"""
Rename a GROBID processing flavor value across all stored TEI documents.

Rewrites the text of
  TEI/teiHeader/encodingDesc/appInfo/application[@type="extractor"]/label[@type="flavor"]
from <old-flavor> to <new-flavor> in every TEI file in the database, saves the
rewritten content to content-addressed storage, and repoints the file records
at the new content hash. FileRepository.update_file() marks the affected
records sync_status='modified' so the sync engine re-uploads them.

This is a one-off data migration (see docs/development/migrations.md "Data
Migrations vs. Schema Migrations"), not part of the auto-run schema-migration
framework. It is idempotent: a second run reports already-migrated files and
changes nothing.

Usage:
    uv run python bin/migrate-tei-flavor-rename.py <old-flavor> <new-flavor> [options]

Options:
    --dry-run     Show what would change without writing
    --limit N     Process at most N distinct TEI content hashes (for testing)
    -v/--verbose  Enable debug logging

Example:
    uv run python bin/migrate-tei-flavor-rename.py \\
        article/dh-law-footnotes article/footnotes-refs --dry-run
"""

import sys
import argparse
import logging
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from lxml import etree

from fastapi_app.config import get_settings
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.models.models import FileUpdate
from fastapi_app.lib.storage.file_storage import FileStorage

TEI_NS = "http://www.tei-c.org/ns/1.0"

_FLAVOR_XPATHS = (
    ".//tei:application[@type='extractor']//tei:label[@type='flavor']",
    ".//application[@type='extractor']//label[@type='flavor']",
)


def _find_flavor_labels(root: "etree._Element") -> list["etree._Element"]:  # type: ignore[name-defined]
    """Return every extractor flavor <label> element, namespaced or not."""
    for xpath in _FLAVOR_XPATHS:
        try:
            found = root.xpath(xpath, namespaces={"tei": TEI_NS})
        except etree.XPathEvalError:
            found = []
        if found:
            return list(found)
    return []


def rename_flavor_in_tei(
    xml_bytes: bytes, old_flavor: str, new_flavor: str
) -> tuple[bytes | None, str]:
    """
    Rewrite the flavor label value in a single TEI document.

    Returns (new_bytes, status) where status is one of:
      - "updated"                     flavor label held old_flavor; new_bytes set
      - "updated:extra-occurrences:N" as "updated", plus N occurrences of the
                                      old_flavor token outside the flavor
                                      label(s) were rewritten too (the
                                      "<variant> [<flavor>]" note that
                                      revisionDesc/change carries)
      - "already_migrated"            flavor label already holds new_flavor
      - "skipped:no-flavor-label"     no extractor flavor label present
      - "skipped:other-flavor:X"      flavor label holds unrelated value(s) X
      - "error:<message>"             parse error

    The old_flavor token is a specific compound string that only ever names
    this one flavor, so a whole-document text replacement is safe.
    """
    parser = etree.XMLParser(recover=True)
    try:
        root = etree.fromstring(xml_bytes, parser)
    except etree.XMLSyntaxError as exc:
        return None, f"error:parse failed: {exc}"
    if root is None:
        return None, "error:parse failed: empty tree"

    labels = _find_flavor_labels(root)
    if not labels:
        return None, "skipped:no-flavor-label"

    values = {(lbl.text or "").strip() for lbl in labels}
    if values == {new_flavor}:
        return None, "already_migrated"
    if old_flavor not in values:
        return None, "skipped:other-flavor:" + ",".join(sorted(v for v in values if v))

    xml_text = xml_bytes.decode("utf-8")
    literal_count = xml_text.count(old_flavor)
    labels_with_old = sum(
        1 for lbl in labels if (lbl.text or "").strip() == old_flavor
    )

    new_bytes = xml_text.replace(old_flavor, new_flavor).encode("utf-8")
    extra = literal_count - labels_with_old
    if extra > 0:
        return new_bytes, f"updated:extra-occurrences:{extra}"
    return new_bytes, "updated"


def run_migration(
    old_flavor: str,
    new_flavor: str,
    dry_run: bool = False,
    limit: int | None = None,
) -> None:
    logger = logging.getLogger(__name__)
    settings = get_settings()

    db = DatabaseManager(settings.db_dir / "metadata.db")
    file_repo = FileRepository(db)
    file_storage = FileStorage(settings.data_root / "files", db, logger)

    tei_files = file_repo.list_files(file_type="tei")

    # Deduplicate by content hash; keep one record per hash for logging context.
    by_hash: dict[str, object] = {}
    for fm in tei_files:
        by_hash.setdefault(fm.id, fm)

    hashes = list(by_hash.items())
    if limit:
        hashes = hashes[:limit]

    stats = {"updated": 0, "already_migrated": 0, "skipped": 0, "errors": 0}

    for old_id, fm in hashes:
        label = (
            f"{getattr(fm, 'doc_id', '?')} "
            f"(stable_id={getattr(fm, 'stable_id', '?')}, hash={old_id[:8]})"
        )

        xml_bytes = file_storage.read_file(old_id, "tei")
        if xml_bytes is None:
            logger.warning("Could not read TEI content: %s", label)
            stats["errors"] += 1
            continue

        new_bytes, status = rename_flavor_in_tei(xml_bytes, old_flavor, new_flavor)

        if status == "already_migrated":
            logger.debug("Already migrated: %s", label)
            stats["already_migrated"] += 1
        elif status == "updated" or status.startswith("updated:extra-occurrences:"):
            if status != "updated":
                extra = status.rsplit(":", 1)[1]
                logger.info(
                    "Renaming flavor (+%s occurrence(s) outside the flavor label, "
                    "e.g. revisionDesc note): %s",
                    extra,
                    label,
                )
            else:
                logger.info("Renaming flavor: %s", label)
            if not dry_run:
                assert new_bytes is not None
                new_hash, _ = file_storage.save_file(
                    new_bytes, "tei", increment_ref=False
                )
                try:
                    file_repo.update_file(
                        old_id, FileUpdate(id=new_hash, file_size=len(new_bytes))
                    )
                except Exception as exc:  # noqa: BLE001 - report and continue
                    logger.error("DB update failed for %s: %s", label, exc)
                    stats["errors"] += 1
                    continue
            stats["updated"] += 1
        elif status.startswith("skipped"):
            logger.debug("Skipped (%s): %s", status, label)
            stats["skipped"] += 1
        else:
            logger.error("Error (%s): %s", status, label)
            stats["errors"] += 1

    print("=" * 60)
    if dry_run:
        print("DRY RUN - no files written")
    print(f"Flavor rename       : {old_flavor!r} -> {new_flavor!r}")
    print(f"Distinct TEI hashes : {len(hashes)}")
    print(f"  Updated           : {stats['updated']}")
    print(f"  Already migrated  : {stats['already_migrated']}")
    print(f"  Skipped           : {stats['skipped']}")
    print(f"  Errors            : {stats['errors']}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Rename a GROBID processing flavor value in all stored TEI documents"
    )
    parser.add_argument("old_flavor", help="Current flavor value to search for")
    parser.add_argument("new_flavor", help="Replacement flavor value")
    parser.add_argument(
        "--dry-run", action="store_true", help="Show changes without writing"
    )
    parser.add_argument(
        "--limit", type=int, help="Process at most N distinct TEI content hashes"
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Enable debug logging"
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    run_migration(
        old_flavor=args.old_flavor,
        new_flavor=args.new_flavor,
        dry_run=args.dry_run,
        limit=args.limit,
    )


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Smoke-test argument parsing**

Run: `uv run python bin/migrate-tei-flavor-rename.py --help`
Expected: usage text listing positional `old_flavor` / `new_flavor` and `--dry-run`, `--limit`, `-v` options. Exit code 0.

- [ ] **Step 3: Verify imports resolve (no DB mutation)**

Run: `uv run python -c "import importlib.util, pathlib, sys; sys.path.insert(0, 'bin'); spec = importlib.util.spec_from_file_location('m', 'bin/migrate-tei-flavor-rename.py'); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); print(mod.rename_flavor_in_tei(b'<TEI xmlns=\"http://www.tei-c.org/ns/1.0\"><teiHeader><encodingDesc><appInfo><application type=\"extractor\"><label type=\"flavor\">article/dh-law-footnotes</label></application></appInfo></encodingDesc></teiHeader></TEI>', 'article/dh-law-footnotes', 'article/footnotes-refs'))"`
Expected: prints a tuple whose second element is `'updated'` and whose first element is `bytes` containing `article/footnotes-refs` and not `article/dh-law-footnotes`.

- [ ] **Step 4: Verify the no-op / other-flavor / no-label branches**

Run:
```bash
uv run python -c "
import importlib.util, sys
spec = importlib.util.spec_from_file_location('m', 'bin/migrate-tei-flavor-rename.py')
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
f = mod.rename_flavor_in_tei
ns = 'xmlns=\"http://www.tei-c.org/ns/1.0\"'
mk = lambda v: (f'<TEI {ns}><teiHeader><encodingDesc><appInfo><application type=\"extractor\"><label type=\"flavor\">{v}</label></application></appInfo></encodingDesc></teiHeader></TEI>').encode()
print(f(mk('article/footnotes-refs'), 'article/dh-law-footnotes', 'article/footnotes-refs')[1])
print(f(mk('default'), 'article/dh-law-footnotes', 'article/footnotes-refs')[1])
print(f(f'<TEI {ns}><teiHeader/></TEI>'.encode(), 'article/dh-law-footnotes', 'article/footnotes-refs')[1])
"
```
Expected output (three lines):
```text
already_migrated
skipped:other-flavor:default
skipped:no-flavor-label
```

- [ ] **Step 5: Commit**

```bash
git add bin/migrate-tei-flavor-rename.py
git commit -m "feat: add bin/migrate-tei-flavor-rename.py

Generic one-off data migration: rewrites the extractor flavor <label>
value across all stored TEI documents and repoints the DB records at the
new content hash, which marks them sync_status='modified' for re-sync.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Rename the flavor literal in source and config

**Files:**
- Modify: `fastapi_app/plugins/grobid/config/variants.py`
- Modify: `fastapi_app/lib/utils/tei_utils.py`
- Modify: `fastapi_app/plugins/grobid/routes.py`

- [ ] **Step 1: Update `PROCESSING_FLAVORS`**

In `fastapi_app/plugins/grobid/config/variants.py`, change:

```python
PROCESSING_FLAVORS: list[str] = [
    "default",
    "article/dh-law-footnotes",
]
```

to:

```python
PROCESSING_FLAVORS: list[str] = [
    "default",
    "article/footnotes-refs",
]
```

- [ ] **Step 2: Update the legacy hardcoded literal in `tei_utils.py`**

In `fastapi_app/lib/utils/tei_utils.py`, inside `create_encoding_desc_with_grobid` (around line 281), change:

```python
    flavor_label = etree.SubElement(grobid_app, "label", type="flavor")
    flavor_label.text = "article/dh-law-footnotes"
```

to:

```python
    flavor_label = etree.SubElement(grobid_app, "label", type="flavor")
    flavor_label.text = "article/footnotes-refs"
```

(This function has no callers; updated for consistency.)

- [ ] **Step 3: Update the docstring example in `routes.py`**

In `fastapi_app/plugins/grobid/routes.py` (around line 373), change the docstring line:

```text
        flavor: GROBID processing flavor (e.g. "default", "article/dh-law-footnotes")
```

to:

```text
        flavor: GROBID processing flavor (e.g. "default", "article/footnotes-refs")
```

- [ ] **Step 4: Verify no stray code references remain**

Run: `grep -rn "dh-law-footnotes" fastapi_app/`
Expected: no output (exit code 1).

- [ ] **Step 5: Type-check the touched backend modules**

Run: `uv run mypy fastapi_app/plugins/grobid/config/variants.py fastapi_app/lib/utils/tei_utils.py fastapi_app/plugins/grobid/routes.py`
Expected: no new errors introduced by these edits (pre-existing errors unrelated to the one-line string changes are acceptable; the string edits themselves cannot introduce type errors).

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/plugins/grobid/config/variants.py fastapi_app/lib/utils/tei_utils.py fastapi_app/plugins/grobid/routes.py
git commit -m "refactor: rename GROBID flavor article/dh-law-footnotes to article/footnotes-refs

Renames the selectable PROCESSING_FLAVORS value (sent verbatim to the
GROBID server and used for training-corpus export paths), the legacy
hardcoded literal in tei_utils, and a docstring example.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Rename the flavor literal in docs

**Files:**
- Modify: `fastapi_app/plugins/grobid/README.md`
- Modify: `docs/user-manual/batch-processing.md`
- Modify: `docs/development/example.tei.xml`

- [ ] **Step 1: Update the GROBID plugin README**

In `fastapi_app/plugins/grobid/README.md` (line 38), change:

```text
Flavors map to custom GROBID model variants. Supported values: `default`, `article/dh-law-footnotes`.
```

to:

```text
Flavors map to custom GROBID model variants. Supported values: `default`, `article/footnotes-refs`.
```

- [ ] **Step 2: Update the batch-processing manual**

In `docs/user-manual/batch-processing.md` (line 97), change:

```text
     --option flavor=article/dh-law-footnotes \
```

to:

```text
     --option flavor=article/footnotes-refs \
```

- [ ] **Step 3: Update the example TEI document**

In `docs/development/example.tei.xml` (line 63), change:

```xml
        <label type="flavor">article/dh-law-footnotes</label>
```

to:

```xml
        <label type="flavor">article/footnotes-refs</label>
```

- [ ] **Step 4: Verify only intentional references remain**

Run: `grep -rn "dh-law-footnotes" docs/ fastapi_app/ | grep -v "docs/history/" | grep -v "docs/api/" | grep -v "docs/superpowers/"`
Expected: no output (exit code 1). Note: `docs/history/**` (historical record) and `docs/api/**` (generated) are intentionally left untouched; `docs/superpowers/**` specs/plans quote the rename and are expected to mention both strings.

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/plugins/grobid/README.md docs/user-manual/batch-processing.md docs/development/example.tei.xml
git commit -m "docs: rename GROBID flavor article/dh-law-footnotes to article/footnotes-refs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Execute the data migration (dry-run, then real run)

**Files:** none (runs the script from Task 2 against the live `data/db/metadata.db` and content storage).

> This task mutates the local database and content-addressed storage. It is
> idempotent and the migration framework's callers create DB backups on
> startup, but the real run in Step 3 requires explicit user confirmation
> before proceeding.

- [ ] **Step 1: Dry run**

Run: `uv run python bin/migrate-tei-flavor-rename.py article/dh-law-footnotes article/footnotes-refs --dry-run -v`
Expected (dry run against the current metadata DB): `DRY RUN - no files written` banner, `Distinct TEI hashes : 816`, `Updated : 739`, `Already migrated : 0`, `Skipped : 77`, `Errors : 0`. Two of the updated docs (`10.16995__olh.13`, `10.1111__1467-6478.00046`) log an INFO `updated:extra-occurrences:1` line — expected, not an error. If `Errors` is non-zero, stop and report the `error:` lines.

- [ ] **Step 2: Present dry-run results and get confirmation**

Report the counts from Step 1 to the user and ask for explicit approval to run the real migration against `data/db/metadata.db`.

- [ ] **Step 3: Real run (only after approval)**

Run: `uv run python bin/migrate-tei-flavor-rename.py article/dh-law-footnotes article/footnotes-refs -v`
Expected: summary with `Updated` matching the dry-run count, `Errors: 0`.

- [ ] **Step 4: Verify content was rewritten**

Run:
```bash
uv run python -c "
import sqlite3
from fastapi_app.config import get_settings
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
import logging
s = get_settings()
db = DatabaseManager(s.db_dir / 'metadata.db')
fr = FileRepository(db)
fs = FileStorage(s.data_root / 'files', db, logging.getLogger('verify'))
old = new = 0
for fm in fr.list_files(file_type='tei'):
    b = fs.read_file(fm.id, 'tei') or b''
    old += b.count(b'article/dh-law-footnotes')
    new += b.count(b'article/footnotes-refs')
print('remaining old-flavor occurrences:', old)
print('new-flavor occurrences         :', new)
"
```
Expected: `remaining old-flavor occurrences: 0`; `new-flavor occurrences` equals the number of migrated documents (or more, if some already had it).

- [ ] **Step 5: Verify affected records are queued for re-sync**

Run:
```bash
uv run python -c "
import sqlite3
from fastapi_app.config import get_settings
s = get_settings()
c = sqlite3.connect(str(s.db_dir / 'metadata.db'))
for row in c.execute(\"SELECT sync_status, COUNT(*) FROM files WHERE file_type='tei' AND deleted=0 GROUP BY sync_status\"):
    print(row)
"
```
Expected: a `('modified', N)` row where `N` is at least the migrated-document count.

- [ ] **Step 6: Re-run to confirm idempotency**

Run: `uv run python bin/migrate-tei-flavor-rename.py article/dh-law-footnotes article/footnotes-refs --dry-run`
Expected: `Updated: 0`; every previously-migrated hash now reported under `Already migrated`.

- [ ] **Step 7: No commit**

This task changes only local runtime data (`data/db/`, content storage), which is not tracked in git. Nothing to commit.

---

## Self-Review

**Spec coverage:**

- Spec Part A (generic script, `rename_flavor_in_tei` signature + status table, dedup-by-hash runner, `update_file` re-sync, CLI, idempotency) → Task 2. ✅
- Spec Part B table (variants.py, tei_utils.py, routes.py, README.md, batch-processing.md, example.tei.xml) → Tasks 3 & 4. ✅
- Spec "left untouched" (`docs/history/**`, `docs/api/**`) → enforced by the grep filters in Task 3 Step 4 and Task 4 Step 4. ✅
- Spec Testing section (no automated test; manual dry-run then real run then spot-check `sync_status`) → Task 5. ✅
- Spec behavioural consequences (flavor sent to GROBID, corpus paths) → captured in Task 3 commit message; no code action required. ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". All code shown in full. ✅

**Type consistency:** `rename_flavor_in_tei(xml_bytes, old_flavor, new_flavor) -> tuple[bytes | None, str]` used identically in Task 2 Step 1 (definition), Step 3/4 (smoke tests), and `run_migration` call site. `FileUpdate(id=..., file_size=...)`, `FileStorage.save_file(bytes, "tei", increment_ref=False)`, `FileStorage.read_file(id, "tei")`, `FileRepository.list_files(file_type="tei")`, `DatabaseManager(path)` — all match the signatures used in the reference script `bin/migrate-tei-fileref-to-xml-id.py`. ✅
