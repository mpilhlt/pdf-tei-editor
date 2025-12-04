#!/usr/bin/env python3
"""
Recursively scan files and perform replacements in both filenames and file contents.

Usage:
    python bin/fix-doc-ids.py <path>
    python bin/fix-doc-ids.py <path> --dry-run
"""

import argparse
import os
import sys
from pathlib import Path
from typing import List, Tuple

# Extensible replacement configuration
# Add new (old_string, new_string) tuples here
REPLACEMENTS: List[Tuple[str, str]] = [
    ("$1$", "__"),
]


def perform_replacements(text: str) -> Tuple[str, bool]:
    """
    Apply all configured replacements to text.

    Args:
        text: The text to process

    Returns:
        Tuple of (modified_text, was_modified)
    """
    modified = text
    changed = False

    for old, new in REPLACEMENTS:
        if old in modified:
            modified = modified.replace(old, new)
            changed = True

    return modified, changed


def fix_file_content(file_path: Path, dry_run: bool = False) -> bool:
    """
    Replace patterns in file content.

    Args:
        file_path: Path to the file
        dry_run: If True, only report what would be changed

    Returns:
        True if file was (or would be) modified
    """
    try:
        # Try to read as text file
        content = file_path.read_text(encoding='utf-8')
        modified_content, changed = perform_replacements(content)

        if changed:
            if dry_run:
                print(f"  [CONTENT] Would modify: {file_path}")
            else:
                file_path.write_text(modified_content, encoding='utf-8')
                print(f"  [CONTENT] Modified: {file_path}")
            return True
    except (UnicodeDecodeError, PermissionError) as e:
        # Skip binary files or files we can't read
        pass

    return False


def fix_filename(file_path: Path, dry_run: bool = False) -> Path:
    """
    Rename file if its name contains patterns to replace.

    Args:
        file_path: Path to the file
        dry_run: If True, only report what would be changed

    Returns:
        The new path (or original if unchanged)
    """
    original_name = file_path.name
    new_name, changed = perform_replacements(original_name)

    if changed:
        new_path = file_path.parent / new_name
        if dry_run:
            print(f"  [FILENAME] Would rename: {file_path} -> {new_path}")
        else:
            file_path.rename(new_path)
            print(f"  [FILENAME] Renamed: {file_path} -> {new_path}")
        return new_path

    return file_path


def process_directory(root_path: Path, dry_run: bool = False) -> Tuple[int, int]:
    """
    Recursively process all files in directory.

    Args:
        root_path: Root directory to process
        dry_run: If True, only report what would be changed

    Returns:
        Tuple of (files_modified, files_renamed)
    """
    files_modified = 0
    files_renamed = 0

    # Process files first, then directories (bottom-up for renaming)
    all_paths = sorted(root_path.rglob('*'), key=lambda p: (len(p.parts), str(p)), reverse=True)

    for path in all_paths:
        if path.is_file():
            # Fix content first
            if fix_file_content(path, dry_run):
                files_modified += 1

            # Then fix filename
            new_path = fix_filename(path, dry_run)
            if new_path != path:
                files_renamed += 1
        elif path.is_dir():
            # Fix directory names
            new_path = fix_filename(path, dry_run)
            if new_path != path:
                files_renamed += 1

    return files_modified, files_renamed


def main():
    parser = argparse.ArgumentParser(
        description='Fix document IDs by replacing patterns in filenames and file contents.'
    )
    parser.add_argument(
        'path',
        type=str,
        help='Path to directory to process'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Show what would be changed without making changes'
    )

    args = parser.parse_args()

    root_path = Path(args.path)

    if not root_path.exists():
        print(f"Error: Path does not exist: {root_path}", file=sys.stderr)
        sys.exit(1)

    if not root_path.is_dir():
        print(f"Error: Path is not a directory: {root_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Processing directory: {root_path}")
    if args.dry_run:
        print("DRY RUN MODE - No changes will be made")
    print(f"Configured replacements:")
    for old, new in REPLACEMENTS:
        print(f"  '{old}' -> '{new}'")
    print()

    files_modified, files_renamed = process_directory(root_path, args.dry_run)

    print()
    print("Summary:")
    print(f"  Files with content modified: {files_modified}")
    print(f"  Files/directories renamed: {files_renamed}")

    if args.dry_run:
        print("\nRun without --dry-run to apply changes")


if __name__ == '__main__':
    main()
