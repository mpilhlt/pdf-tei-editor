#!/usr/bin/env python3
"""
Quick script to inspect a TEI file structure.

Usage:
    uv run python bin/inspect-tei.py <stable_id>
"""

import sys
from pathlib import Path
from lxml import etree

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from fastapi_app.config import get_settings
from fastapi_app.lib.database import DatabaseManager
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.file_storage import FileStorage
import logging

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

def inspect_tei(stable_id: str):
    """Inspect TEI file structure."""
    settings = get_settings()

    # Initialize database and storage
    metadata_db_path = settings.db_dir / "metadata.db"
    db_manager = DatabaseManager(metadata_db_path)
    file_repo = FileRepository(db_manager)
    storage_root = settings.data_root / "files"
    file_storage = FileStorage(storage_root, db_manager, logger)

    # Get file info
    files = file_repo.list_files(file_type="tei")
    tei_file = None
    for f in files:
        if f.stable_id == stable_id:
            tei_file = f
            break

    if not tei_file:
        print(f"TEI file with stable_id '{stable_id}' not found")
        return

    print(f"Found TEI file: {tei_file.stable_id}")
    print(f"  File ID: {tei_file.id}")
    print(f"  Doc ID: {tei_file.doc_id}")
    print()

    # Read content
    content = file_storage.read_file(tei_file.id, "tei")
    if not content:
        print("Failed to read file content")
        return

    # Parse XML
    try:
        root = etree.fromstring(content)
    except Exception as e:
        print(f"Failed to parse XML: {e}")
        return

    # Show root element
    print(f"Root element: {root.tag}")
    print()

    # Check for fileDesc
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    file_desc = root.find('.//tei:fileDesc', ns)

    if file_desc is None:
        print("❌ No fileDesc element found!")
        print()
        print("Document structure:")
        for child in root:
            # Handle both string tags and lxml elements
            tag_str = str(child.tag)
            tag = tag_str.split('}')[-1] if '}' in tag_str else tag_str
            print(f"  - {tag}")
    else:
        print("✓ fileDesc element found")
        print()
        print("fileDesc structure:")
        for child in file_desc:
            # Handle both string tags and lxml elements
            tag_str = str(child.tag)
            tag = tag_str.split('}')[-1] if '}' in tag_str else tag_str
            print(f"  - {tag}")

    print()
    print("First 1000 characters of XML:")
    print(content.decode('utf-8')[:1000])


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: uv run python bin/inspect-tei.py <stable_id>")
        sys.exit(1)

    inspect_tei(sys.argv[1])
