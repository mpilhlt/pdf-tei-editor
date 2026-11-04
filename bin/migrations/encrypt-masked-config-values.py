#!/usr/bin/env python3
"""
Encrypt the masked values in config.json that are still stored as plain text.

Introduced in release 0.81.0, which encrypts masked config values (plugin settings registered with
masked=True, such as shared API keys) at rest. New and changed values are encrypted automatically,
and plugins re-encrypt their settings when they register them on startup; this script encrypts the
remaining ones, e.g. of plugins that are not installed any more.

The values are encrypted with the key of the user secret store: the SECRETS_ENCRYPTION_KEY
environment variable or, without it, the key file data/db/secrets.key (created if missing). Run the
script with the same environment as the server, otherwise the server cannot decrypt the values.

Usage:
    uv run python bin/migrations/encrypt-masked-config-values.py [--db-dir data/db] [--dry-run]
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from fastapi_app.lib.utils.config_utils import (  # noqa: E402
    METADATA_SUFFIXES,
    ConfigSecretError,
    check_config_secrets,
    is_encrypted_value,
    set_config_value,
)
from fastapi_app.lib.utils.data_utils import get_data_file_path  # noqa: E402


def find_plaintext_masked_keys(config_data: dict[str, object]) -> list[str]:
    """Keys of masked values that are set and not encrypted."""
    return [
        key for key, value in config_data.items()
        if not key.endswith(METADATA_SUFFIXES)
        and config_data.get(f"{key}.masked") is True
        and value not in (None, "")
        and not is_encrypted_value(value)
    ]


def load_config_strict(config_file: Path) -> dict[str, object]:
    """
    Read config.json, failing on a malformed file instead of treating it as empty.

    Raises:
        ValueError: If the file is not valid JSON or not a JSON object
    """
    try:
        data = json.loads(config_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"{config_file} is not valid JSON: {e}") from e
    if not isinstance(data, dict):
        raise ValueError(f"{config_file} does not contain a JSON object")
    return data


def main(argv: list[str] | None = None) -> int:
    """Run the migration; returns the exit code."""
    parser = argparse.ArgumentParser(description="Encrypt the masked values in config.json that are stored as plain text")
    parser.add_argument("--db-dir", type=Path, default=Path("data/db"), help="Directory containing config.json (default: data/db)")
    parser.add_argument("--dry-run", action="store_true", help="Only list the values that would be encrypted")
    args = parser.parse_args(argv)

    config_file = get_data_file_path(args.db_dir, "config")
    if not config_file.exists():
        print(f"Error: {config_file} not found", file=sys.stderr)
        return 1
    try:
        config_data = load_config_strict(config_file)
        # Refuse to mix keys: values encrypted with another key would stay undecryptable
        check_config_secrets(args.db_dir)
    except (ValueError, ConfigSecretError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    keys = find_plaintext_masked_keys(config_data)
    if not keys:
        print("No plain-text masked values found")
        return 0
    for key in keys:
        if args.dry_run:
            print(f"Would encrypt {key}")
            continue
        # Setting the value again stores it encrypted, under the config file lock
        success, message = set_config_value(key, config_data[key], args.db_dir)
        if not success:
            print(f"Error: cannot encrypt {key}: {message}", file=sys.stderr)
            return 1
        print(f"Encrypted {key}")

    if not args.dry_run:
        remaining = find_plaintext_masked_keys(load_config_strict(config_file))
        if remaining:
            print(f"Error: still stored as plain text: {', '.join(remaining)}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
