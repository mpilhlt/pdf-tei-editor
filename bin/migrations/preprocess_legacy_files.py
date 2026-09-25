#!/usr/bin/env python3
"""
Preprocess legacy file structure for import into FastAPI application.

Transforms the old webdav-data structure with separate pdf/, tei/, and versions/
directories into a flattened structure organized by collection with proper
naming conventions for gold standard and version files.

Legacy structure:
    data/webdav-data/
    ├── pdf/
    │   ├── collection1/
    │   │   └── 10.1234__example.pdf
    │   └── collection2/
    ├── tei/
    │   ├── collection1/
    │   │   └── 10.1234__example.tei.xml (gold standard)
    │   └── collection2/
    └── versions/
        └── 10.1234__example/
            ├── 2025-09-23_17-58-04-10.1234__example.variant1.xml
            └── 2025-09-24_10-30-15-10.1234__example.variant2.xml

Target structure:
    data/webdav-data-preprocessed/
    ├── collection1/
    │   ├── 10.1234__example.pdf
    │   ├── 10.1234__example.tei.xml               (gold - no version marker)
    │   ├── 10.1234__example.variant1.v1.tei.xml   (version 1 with variant)
    │   └── 10.1234__example.variant1.v2.tei.xml   (version 2 with variant)
    └── collection2/

Usage:
    python bin/preprocess_legacy_files.py data/webdav-data data/webdav-data-preprocessed
    python bin/preprocess_legacy_files.py data/webdav-data data/webdav-data-preprocessed --dry-run
"""

import argparse
import shutil
import re
from pathlib import Path
from typing import Dict, List, Tuple, Set
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def extract_doc_id_from_filename(filename: str) -> str:
    """
    Extract doc_id from filename by removing extensions and variant suffixes.

    Examples:
        '10.1234__example.pdf' -> '10.1234__example'
        '10.1234__example.tei.xml' -> '10.1234__example'
        '10.1234__example.variant1.tei.xml' -> '10.1234__example'
        '2025-09-23_17-58-04-10.1234__example.variant1.xml' -> '10.1234__example'
    """
    # Remove timestamp prefix if present (YYYY-MM-DD_HH-MM-SS-)
    if re.match(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-', filename):
        filename = re.sub(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-', '', filename)

    # Remove file extensions
    filename = filename.replace('.tei.xml', '').replace('.xml', '').replace('.pdf', '')

    # Remove variant suffixes (anything after the last period)
    # This handles cases like 'doc.variant1' -> 'doc'
    # But preserves DOI periods like '10.1234__example'
    if '.' in filename:
        # Split and check if last part looks like a variant (non-numeric after first char)
        parts = filename.rsplit('.', 1)
        if len(parts) == 2:
            last_part = parts[1]
            # If last part is not all digits and doesn't start with a digit (not part of DOI)
            # then it's likely a variant suffix
            if not last_part.isdigit() and not (last_part[0].isdigit() if last_part else False):
                filename = parts[0]

    return filename


def extract_variant_from_filename(filename: str) -> str:
    """
    Extract variant from filename.

    Examples:
        '10.1234__example.grobid.training.segmentation.tei.xml' -> 'grobid.training.segmentation'
        '10.1234__example.llamore-default.tei.xml' -> 'llamore-default'
        '10.1234__example.tei.xml' -> '' (no variant)
    """
    # Remove timestamp prefix if present
    if re.match(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-', filename):
        filename = re.sub(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-', '', filename)

    # Remove extensions
    stem = filename.replace('.tei.xml', '.xml').replace('.xml', '')

    # Extract doc_id part (everything before first variant indicator)
    doc_id = extract_doc_id_from_filename(filename)

    # Variant is what remains after removing doc_id
    if stem.startswith(doc_id + '.'):
        variant = stem[len(doc_id)+1:]
        return variant

    return ''


def find_collection_for_file(file_path: Path, base_dir: Path, category: str) -> str:
    """
    Determine collection name from file path.

    Args:
        file_path: Full path to file
        base_dir: Base directory (e.g., data/webdav-data)
        category: 'pdf' or 'tei'

    Returns:
        Collection name or '__inbox' if no collection
    """
    # Get relative path from category directory
    category_dir = base_dir / category
    try:
        rel_path = file_path.relative_to(category_dir)
    except ValueError:
        return '__inbox'

    # Get first directory component as collection
    parts = rel_path.parts
    if len(parts) > 1:
        return parts[0]

    return '__inbox'


def process_legacy_structure(
    source_dir: Path,
    target_dir: Path,
    dry_run: bool = False
) -> Dict[str, int]:
    """
    Transform legacy file structure to new structure.

    Returns:
        Statistics dict with counts of processed files
    """
    stats = {
        'pdfs_copied': 0,
        'gold_files_copied': 0,
        'versions_copied': 0,
        'errors': 0
    }

    # Validate source structure
    pdf_dir = source_dir / 'pdf'
    tei_dir = source_dir / 'tei'
    versions_dir = source_dir / 'versions'

    if not pdf_dir.exists():
        logger.error(f"PDF directory not found: {pdf_dir}")
        return stats

    if not tei_dir.exists():
        logger.error(f"TEI directory not found: {tei_dir}")
        return stats

    # Create target directory
    if not dry_run:
        target_dir.mkdir(parents=True, exist_ok=True)

    # Track processed doc_ids and their collections
    doc_collections: Dict[str, str] = {}

    # Step 1: Process PDFs
    logger.info("Processing PDF files...")
    for pdf_path in pdf_dir.rglob('*.pdf'):
        if '.deleted' in pdf_path.name:
            continue

        collection = find_collection_for_file(pdf_path, source_dir, 'pdf')
        doc_id = extract_doc_id_from_filename(pdf_path.name)

        # Track collection for this doc_id
        doc_collections[doc_id] = collection

        # Copy to target
        target_path = target_dir / collection / pdf_path.name

        if dry_run:
            logger.info(f"[DRY RUN] Would copy PDF: {pdf_path.name} -> {target_path}")
        else:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(pdf_path, target_path)
            logger.debug(f"Copied PDF: {pdf_path.name} -> {target_path}")

        stats['pdfs_copied'] += 1

    # Step 2: Process gold standard TEI files
    logger.info("Processing gold standard TEI files...")
    for tei_path in tei_dir.rglob('*.xml'):
        if '.deleted' in tei_path.name:
            continue

        collection = find_collection_for_file(tei_path, source_dir, 'tei')
        doc_id = extract_doc_id_from_filename(tei_path.name)
        variant = extract_variant_from_filename(tei_path.name)

        # Use collection from PDF if available, otherwise use TEI collection
        if doc_id in doc_collections:
            collection = doc_collections[doc_id]
        else:
            doc_collections[doc_id] = collection

        # Create gold filename: doc_id.variant.tei.xml (or doc_id.tei.xml if no variant)
        # Gold files have NO version marker (.vN.)
        if variant:
            target_filename = f"{doc_id}.{variant}.tei.xml"
        else:
            target_filename = f"{doc_id}.tei.xml"
        target_path = target_dir / collection / target_filename

        if dry_run:
            logger.info(f"[DRY RUN] Would copy gold TEI: {tei_path.name} -> {target_path}")
        else:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(tei_path, target_path)
            logger.debug(f"Copied gold TEI: {tei_path.name} -> {target_path}")

        stats['gold_files_copied'] += 1

    # Step 3: Process versions
    if versions_dir.exists():
        logger.info("Processing version files...")

        # Track version numbers per (doc_id, variant) combination
        version_counters: Dict[Tuple[str, str], int] = {}

        for version_dir in sorted(versions_dir.iterdir()):
            if not version_dir.is_dir():
                continue

            # Directory name is the doc_id
            dir_doc_id = version_dir.name

            # Process all version files in this directory
            version_files = sorted(version_dir.glob('*.xml'))

            for version_file in version_files:
                if '.deleted' in version_file.name:
                    continue

                # Extract doc_id and variant from filename
                doc_id = extract_doc_id_from_filename(version_file.name)
                variant = extract_variant_from_filename(version_file.name)

                # Get collection from previously processed files
                collection = doc_collections.get(doc_id, '__inbox')

                # Get or initialize version counter for this (doc_id, variant)
                key = (doc_id, variant)
                if key not in version_counters:
                    version_counters[key] = 1
                else:
                    version_counters[key] += 1

                version_num = version_counters[key]

                # Create target filename: doc_id.variant.vN.tei.xml (or doc_id.vN.tei.xml if no variant)
                if variant:
                    target_filename = f"{doc_id}.{variant}.v{version_num}.tei.xml"
                else:
                    target_filename = f"{doc_id}.v{version_num}.tei.xml"
                target_path = target_dir / collection / target_filename

                if dry_run:
                    logger.info(f"[DRY RUN] Would copy version: {version_file.name} -> {target_path}")
                else:
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(version_file, target_path)
                    logger.debug(f"Copied version: {version_file.name} -> {target_path}")

                stats['versions_copied'] += 1

    return stats


def main():
    parser = argparse.ArgumentParser(
        description='Preprocess legacy file structure for import',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument('source_dir',
                       help='Source directory (e.g., data/webdav-data)')
    parser.add_argument('target_dir',
                       help='Target directory (e.g., data/webdav-data-preprocessed)')
    parser.add_argument('--dry-run', action='store_true',
                       help='Preview without copying files')
    parser.add_argument('--verbose', '-v', action='store_true',
                       help='Enable verbose logging')

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    source_dir = Path(args.source_dir)
    target_dir = Path(args.target_dir)

    # Validate source directory
    if not source_dir.exists():
        logger.error(f"Source directory does not exist: {source_dir}")
        return 1

    if not source_dir.is_dir():
        logger.error(f"Source path is not a directory: {source_dir}")
        return 1

    # Warn if target exists
    if target_dir.exists() and not args.dry_run:
        logger.warning(f"Target directory already exists: {target_dir}")
        response = input("Continue? (y/N): ")
        if response.lower() != 'y':
            logger.info("Aborted")
            return 0

    # Process files
    logger.info(f"Preprocessing files from {source_dir} to {target_dir}")
    if args.dry_run:
        logger.info("[DRY RUN MODE - No files will be copied]")

    stats = process_legacy_structure(source_dir, target_dir, args.dry_run)

    # Report
    print("\n" + "="*60)
    print("Preprocessing Summary")
    print("="*60)
    print(f"  PDFs copied:        {stats['pdfs_copied']}")
    print(f"  Gold files copied:  {stats['gold_files_copied']}")
    print(f"  Versions copied:    {stats['versions_copied']}")
    print(f"  Errors:             {stats['errors']}")
    print("="*60)

    if not args.dry_run:
        print(f"\nPreprocessed files written to: {target_dir}")
        print("\nNext step: Import using:")
        print(f"  python bin/import_files.py {target_dir} --recursive-collections")
        print("\nNote: Default patterns are used:")
        print("  - Gold: files without .vN. marker")
        print("  - Version: .v1., .v2., etc.")

    return 0


if __name__ == '__main__':
    exit(main())
