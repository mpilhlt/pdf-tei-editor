"""
Data restore utility for applying pending data directory restores at startup.

When a backup is restored via the backup-restore plugin, the ZIP contents are
extracted to ``data_restore/`` in the project root. On the next server startup,
this module detects the pending restore and swaps it in:

1. Renames ``data/`` → ``data_{YYYYMMDD_HHMMSS}/``
2. Renames ``data_restore/`` → ``data/``
"""

import shutil
from datetime import datetime
from pathlib import Path


def apply_pending_restore(
    project_root: Path,
    data_root: Path,
    logger,
) -> bool:
    """Apply a pending data restore if ``data_restore/`` exists.

    Args:
        project_root: Project root directory (parent of ``data/``).
        data_root: Current data directory path (typically ``data/``).
        logger: Logger instance.

    Returns:
        True if a restore was applied, False otherwise.
    """
    restore_dir = project_root / "data_restore"

    if not restore_dir.exists() or not restore_dir.is_dir():
        return False

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_name = f"data_{timestamp}"
    backup_dir = project_root / backup_name

    logger.info(f"Pending data restore detected at {restore_dir}")

    # Rename current data directory
    if data_root.exists():
        logger.info(f"Renaming {data_root} → {backup_dir}")
        data_root.rename(backup_dir)
    else:
        logger.warning(f"Current data directory {data_root} does not exist — skipping rename")

    # Move restore into place
    logger.info(f"Renaming {restore_dir} → {data_root}")
    restore_dir.rename(data_root)

    # Copy .gitignore into the archived directory so git ignores its contents
    gitignore = data_root / ".gitignore"
    if backup_dir.exists() and gitignore.exists():
        shutil.copy2(gitignore, backup_dir / ".gitignore")

    logger.info(
        f"Data restore complete. Previous data saved as {backup_name}/. "
        f"Delete it manually when no longer needed."
    )
    return True
