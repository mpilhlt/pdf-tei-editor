#!/usr/bin/env python3

# Maintenance script for data/db/metadata.db.
# Usage:
#   python bin/update-metadata.py run <function_name>
#   python bin/update-metadata.py revert

import sys
import sqlite3
import shutil
from pathlib import Path
from datetime import datetime

project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project_root))

from fastapi_app.lib.utils.server_startup import (
    load_environment,
    check_port_in_use,
    get_host_and_port,
    kill_server_on_port,
)

DB_PATH = project_root / 'data' / 'db' / 'metadata.db'

_runnable_functions: dict[str, callable] = {}


def runnable(fn):
    """Decorator that registers a function as callable via `run <name>`."""
    _runnable_functions[fn.__name__] = fn
    return fn


def print_help() -> None:
    names = list(_runnable_functions)
    functions_list = '\n'.join(f'  {n}  -  {_runnable_functions[n].__doc__ or ""}' for n in names)
    print(
        "Usage:\n"
        "  python bin/update-metadata.py run <function_name>\n"
        "  python bin/update-metadata.py revert\n"
        "\n"
        "Commands:\n"
        "  run <function_name>  Create a timestamped backup, then run the named function\n"
        "  revert               Stop the server (if running) and restore the latest backup\n"
        "\n"
        f"Available functions:\n{functions_list}"
    )


def backup_db() -> Path:
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_path = DB_PATH.parent / f'metadata_backup_{timestamp}.db'
    shutil.copy2(DB_PATH, backup_path)
    print(f"Backup created: {backup_path}")
    return backup_path


def get_latest_backup() -> Path | None:
    backups = sorted(DB_PATH.parent.glob('metadata_backup_*.db'))
    return backups[-1] if backups else None


def run_function(name: str) -> None:
    if name not in _runnable_functions:
        print(f"Unknown function: {name}")
        print(f"Available functions: {', '.join(_runnable_functions)}")
        sys.exit(1)
    backup_db()
    _runnable_functions[name]()


def revert() -> None:
    load_environment(project_root)
    _, port = get_host_and_port()
    if check_port_in_use(port):
        print(f"Server running on port {port}, stopping...")
        kill_server_on_port(port)
    backup = get_latest_backup()
    if not backup:
        print("No backup found.")
        sys.exit(1)
    shutil.copy2(backup, DB_PATH)
    print(f"Reverted to: {backup}")
    print("Restart the server to apply the reverted database.")


@runnable
def repopulate_status() -> None:
    """Repopulate the status column from the last revisionDesc/change/@status in each TEI file."""
    import sys
    sys.path.insert(0, str(project_root))
    from fastapi_app.lib.core.migrations.utils import repopulate_column_from_tei_files, get_file_storage_paths
    from fastapi_app.lib.utils.tei_utils import extract_last_revision_status
    import logging
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    logger = logging.getLogger(__name__)
    with sqlite3.connect(DB_PATH) as conn:
        _, files_dir = get_file_storage_paths(conn)
        stats = repopulate_column_from_tei_files(
            conn=conn,
            files_dir=files_dir,
            column_name="status",
            extract_function=extract_last_revision_status,
            logger=logger,
            column_description="status",
        )
        conn.commit()
    print(f"Done: updated={stats['updated']}, skipped={stats['skipped']}, errors={stats['errors']}, total={stats['total']}")


@runnable
def remove_gold_from_extraction_tei() -> None:
    """Remove gold standard status from TEI files whose label contains 'Extraction'."""
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.execute(
            """
            UPDATE files
            SET is_gold_standard = 0
            WHERE file_type = 'tei'
              AND is_gold_standard = 1
              AND label LIKE '%Extraction%'
              AND deleted = 0
            """
        )
        conn.commit()
    print(f"Updated {cursor.rowcount} file(s).")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print_help()
        sys.exit(0)

    command = sys.argv[1]

    if command == 'run':
        if len(sys.argv) < 3:
            print_help()
            sys.exit(1)
        run_function(sys.argv[2])
    elif command == 'revert':
        revert()
    else:
        print(f"Unknown command: {command}\n")
        print_help()
        sys.exit(1)
