"""
Shared utilities for updating TEI metadata with bibliographic information.

Provides functions for:
- Checking if TEI documents have biblStruct elements
- Extracting DOIs from TEI headers
- Updating biblStruct elements with complete metadata
- Batch updating TEI files with progress tracking and cancellation support
"""

import asyncio
import logging
from lxml import etree
from typing import Callable, Optional

from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.tei_utils import (
    serialize_tei_with_formatted_header,
    extract_processing_instructions
)
from fastapi_app.lib.metadata_extraction import get_metadata_for_document
from fastapi_app.lib.models import FileUpdate
from fastapi_app.lib.doi_utils import decode_filename, validate_doi

logger = logging.getLogger(__name__)


def has_biblstruct(tei_root: etree._Element) -> bool:
    """
    Check if TEI document already has biblStruct in sourceDesc.

    Args:
        tei_root: Root element of TEI document

    Returns:
        True if biblStruct exists, False otherwise
    """
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    biblStruct = tei_root.find('.//tei:sourceDesc/tei:biblStruct', ns)
    return biblStruct is not None


def extract_doi_from_tei(tei_root: etree._Element) -> str | None:
    """
    Extract DOI from TEI document (try biblStruct first, then publicationStmt).

    Args:
        tei_root: Root element of TEI document

    Returns:
        DOI string if found, None otherwise
    """
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}

    # Try biblStruct first
    doi_elem = tei_root.find('.//tei:sourceDesc/tei:biblStruct/tei:idno[@type="DOI"]', ns)
    if doi_elem is None or not doi_elem.text:
        # Fallback to publicationStmt
        doi_elem = tei_root.find('.//tei:publicationStmt/tei:idno[@type="DOI"]', ns)

    if doi_elem is not None and doi_elem.text:
        return doi_elem.text.strip()
    return None


def update_biblstruct_in_tei(tei_root: etree._Element, metadata: dict) -> bool:
    """
    Update or create biblStruct in TEI document with complete metadata.

    Args:
        tei_root: TEI root element
        metadata: Complete metadata dict from get_metadata_for_document()

    Returns:
        True if biblStruct was updated/created, False if no metadata available
    """
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}

    # Check if we have substantial metadata
    has_content = (
        metadata.get('title') or
        metadata.get('journal') or
        metadata.get('authors')
    )

    if not has_content:
        return False

    # Find or create sourceDesc
    file_desc = tei_root.find('.//tei:fileDesc', ns)
    if file_desc is None:
        return False

    source_desc = file_desc.find('.//tei:sourceDesc', ns)
    if source_desc is None:
        source_desc = etree.SubElement(file_desc, "{http://www.tei-c.org/ns/1.0}sourceDesc")

    # Remove existing biblStruct if present
    existing_biblstruct = source_desc.find('tei:biblStruct', ns)
    if existing_biblstruct is not None:
        source_desc.remove(existing_biblstruct)

    # Build new biblStruct
    biblStruct = etree.SubElement(source_desc, "{http://www.tei-c.org/ns/1.0}biblStruct")

    # Analytic section (article-level metadata)
    title = metadata.get('title')
    authors = metadata.get('authors', [])

    if title or authors:
        analytic = etree.SubElement(biblStruct, "{http://www.tei-c.org/ns/1.0}analytic")

        if title:
            title_elem = etree.SubElement(analytic, "{http://www.tei-c.org/ns/1.0}title")
            title_elem.set("level", "a")
            title_elem.text = title

        # Add authors to analytic section
        for author in authors:
            author_elem = etree.SubElement(analytic, "{http://www.tei-c.org/ns/1.0}author")
            persName = etree.SubElement(author_elem, "{http://www.tei-c.org/ns/1.0}persName")
            if author.get("given"):
                forename = etree.SubElement(persName, "{http://www.tei-c.org/ns/1.0}forename")
                forename.text = author["given"]
            if author.get("family"):
                surname = etree.SubElement(persName, "{http://www.tei-c.org/ns/1.0}surname")
                surname.text = author["family"]

    # Monograph section (journal-level metadata)
    journal = metadata.get('journal')
    volume = metadata.get('volume')
    issue = metadata.get('issue')
    pages = metadata.get('pages')
    date = metadata.get('date')
    publisher = metadata.get('publisher')

    if journal or publisher or date or volume or issue or pages:
        monogr = etree.SubElement(biblStruct, "{http://www.tei-c.org/ns/1.0}monogr")

        if journal:
            journal_elem = etree.SubElement(monogr, "{http://www.tei-c.org/ns/1.0}title")
            journal_elem.set("level", "j")
            journal_elem.text = journal

        # Imprint section
        imprint = etree.SubElement(monogr, "{http://www.tei-c.org/ns/1.0}imprint")

        if volume:
            vol_elem = etree.SubElement(imprint, "{http://www.tei-c.org/ns/1.0}biblScope")
            vol_elem.set("unit", "volume")
            vol_elem.text = volume

        if issue:
            issue_elem = etree.SubElement(imprint, "{http://www.tei-c.org/ns/1.0}biblScope")
            issue_elem.set("unit", "issue")
            issue_elem.text = issue

        if pages:
            pages_elem = etree.SubElement(imprint, "{http://www.tei-c.org/ns/1.0}biblScope")
            pages_elem.set("unit", "page")
            # Parse page range
            if "-" in pages:
                parts = pages.split("-")
                if len(parts) == 2:
                    pages_elem.set("from", parts[0].strip())
                    pages_elem.set("to", parts[1].strip())
            pages_elem.text = pages

        if date:
            date_elem = etree.SubElement(imprint, "{http://www.tei-c.org/ns/1.0}date")
            date_elem.set("when", str(date))
            date_elem.text = str(date)

        if publisher:
            pub_elem = etree.SubElement(imprint, "{http://www.tei-c.org/ns/1.0}publisher")
            pub_elem.text = publisher

    # Add identifiers and URLs at biblStruct level
    doi = metadata.get('doi')
    id_value = metadata.get('id')
    url = metadata.get('url')

    if doi:
        idno = etree.SubElement(biblStruct, "{http://www.tei-c.org/ns/1.0}idno")
        idno.set("type", "DOI")
        idno.text = doi
    elif id_value:
        idno = etree.SubElement(biblStruct, "{http://www.tei-c.org/ns/1.0}idno")
        if ":" in id_value:
            id_type = id_value.split(":")[0]
            idno.set("type", id_type)
            idno.text = id_value[len(id_type) + 1:]
        else:
            idno.text = id_value

    if url:
        ptr = etree.SubElement(biblStruct, "{http://www.tei-c.org/ns/1.0}ptr")
        ptr.set("target", url)

    # Add proper indentation to biblStruct
    try:
        etree.indent(biblStruct, space="  ", level=4)
    except (AttributeError, TypeError):
        # etree.indent not available in older lxml versions
        try:
            etree.indent(biblStruct, space="  ")
        except AttributeError:
            pass

    return True


async def update_tei_metadata(
    file_repo: FileRepository,
    file_storage: FileStorage,
    limit: int | None = None,
    force: bool = False,
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
    cancellation_check: Optional[Callable[[], bool]] = None
) -> dict:
    """
    Update all TEI files with complete metadata from DOI lookup or LLM extraction.

    Workflow:
    1. Query all PDF entries (which have doc_metadata and doc_id)
    2. For each PDF, enrich metadata using DOI lookup or LLM extraction
    3. Find all TEI files linked via doc_id
    4. Update each TEI file's biblStruct with enriched metadata

    Args:
        file_repo: FileRepository instance for database operations
        file_storage: FileStorage instance for file operations
        limit: Maximum number of PDFs to process (for testing)
        force: If True, overwrite existing biblStruct elements
        progress_callback: Optional callback(current, total, label) for progress updates
        cancellation_check: Optional callback() -> bool to check if operation should be cancelled

    Returns:
        Statistics dict with keys: processed, updated, skipped, errors

    Raises:
        Exception: If operation is cancelled via cancellation_check
    """
    # Get all PDF files (these have doc_metadata and doc_id)
    try:
        all_pdfs = file_repo.list_files(file_type="pdf")
    except Exception as e:
        logger.error(f"Failed to query database: {e}")
        raise

    logger.info(f"Found {len(all_pdfs)} PDF files in database")

    if limit:
        all_pdfs = all_pdfs[:limit]
        logger.info(f"Limited to {limit} PDFs for testing")

    pdfs_processed = 0
    tei_files_updated = 0
    pdfs_skipped = 0
    errors = 0

    for pdf_obj in all_pdfs:
        # Check for cancellation
        if cancellation_check and cancellation_check():
            logger.info("Update cancelled by user")
            raise Exception("Update cancelled by user")

        pdfs_processed += 1
        pdf_stable_id = pdf_obj.stable_id
        doc_id = pdf_obj.doc_id

        logger.debug(f"Processing PDF {pdf_stable_id} (doc_id={doc_id})")

        # Update progress
        if progress_callback:
            progress_callback(
                pdfs_processed,
                len(all_pdfs),
                f"PDF {pdfs_processed}/{len(all_pdfs)}: {doc_id[:20] if doc_id else pdf_stable_id[:20]}..."
            )
            await asyncio.sleep(0)  # Yield to allow SSE event delivery

        try:
            # Find all TEI files linked to this PDF via doc_id
            all_tei_files = file_repo.list_files(file_type="tei")
            linked_tei_files = [f for f in all_tei_files if f.doc_id == doc_id]

            if not linked_tei_files:
                logger.debug(f"  No TEI files found for doc_id={doc_id}")
                pdfs_skipped += 1
                continue

            logger.debug(f"  Found {len(linked_tei_files)} linked TEI file(s)")

            # Check if any TEI already has biblStruct (unless force)
            if not force:
                already_has_biblstruct = False
                for tei_obj in linked_tei_files:
                    tei_content = file_storage.read_file(tei_obj.id, "tei")
                    if tei_content:
                        tei_root = etree.fromstring(tei_content)
                        if has_biblstruct(tei_root):
                            already_has_biblstruct = True
                            break

                if already_has_biblstruct:
                    logger.debug(f"  Skipping - TEI already has biblStruct (use --force to overwrite)")
                    pdfs_skipped += 1
                    continue

            # Extract DOI from multiple sources (in priority order)
            doi = None

            # 1. Try decoding doc_id as DOI (many doc_ids are encoded DOIs)
            if doc_id:
                try:
                    decoded_doc_id = decode_filename(doc_id)
                    if validate_doi(decoded_doc_id):
                        doi = decoded_doc_id
                        logger.debug(f"  DOI found from doc_id: {doi}")
                except Exception:
                    # Not an encoded DOI, that's fine
                    pass

            # 2. Fallback to first TEI file
            if not doi:
                first_tei_content = file_storage.read_file(linked_tei_files[0].id, "tei")
                if first_tei_content:
                    first_tei_root = etree.fromstring(first_tei_content)
                    doi = extract_doi_from_tei(first_tei_root)
                    if doi:
                        logger.debug(f"  DOI found in TEI header: {doi}")

            # 3. Fallback to PDF metadata if available
            if not doi and pdf_obj.doc_metadata:
                doi = pdf_obj.doc_metadata.get('doi')
                if doi:
                    logger.debug(f"  DOI found in PDF metadata: {doi}")

            if not doi:
                logger.debug(f"  DOI: not found")

            # Get complete metadata (DOI lookup or LLM extraction)
            extraction_method = "DOI lookup" if doi else "LLM extraction"
            logger.debug(f"  Attempting {extraction_method}...")
            try:
                metadata = await get_metadata_for_document(
                    doi=doi,
                    stable_id=pdf_stable_id if not doi else None  # Use PDF stable_id for LLM
                )
                logger.debug(f"  Metadata returned: {metadata}")
            except Exception as e:
                logger.error(f"Failed to fetch metadata for PDF {pdf_stable_id}: {e}", exc_info=True)
                errors += 1
                continue

            # Check if we got useful metadata
            has_useful_metadata = (
                metadata.get('title') or
                metadata.get('journal') or
                metadata.get('authors')
            )

            if not has_useful_metadata:
                logger.warning(f"Skipping PDF {pdf_stable_id} - {extraction_method} returned no useful metadata")
                logger.debug(f"  Empty/missing fields: title={'✓' if metadata.get('title') else '✗'}, "
                           f"journal={'✓' if metadata.get('journal') else '✗'}, "
                           f"authors={'✓' if metadata.get('authors') else '✗'}")
                pdfs_skipped += 1
                continue

            # Update all linked TEI files
            tei_updated_count = 0
            for tei_obj in linked_tei_files:
                tei_stable_id = tei_obj.stable_id
                tei_file_id = tei_obj.id

                try:
                    # Load TEI content
                    tei_content = file_storage.read_file(tei_file_id, "tei")
                    if not tei_content:
                        logger.warning(f"    TEI {tei_stable_id} not found in storage")
                        continue

                    # Parse TEI
                    tei_root = etree.fromstring(tei_content)

                    # Extract processing instructions
                    processing_instructions = extract_processing_instructions(tei_content.decode('utf-8'))

                    # Update biblStruct
                    updated = update_biblstruct_in_tei(tei_root, metadata)
                    if not updated:
                        logger.debug(f"    Skipped TEI {tei_stable_id} - insufficient metadata")
                        continue

                    # Serialize updated TEI
                    updated_xml = serialize_tei_with_formatted_header(tei_root, processing_instructions)

                    # Save to storage (gets new content hash)
                    new_tei_file_id, _ = file_storage.save_file(updated_xml.encode('utf-8'), "tei")

                    # Update database record
                    file_repo.update_file(tei_file_id, FileUpdate(id=new_tei_file_id))

                    logger.info(f"    Updated TEI {tei_stable_id}: {tei_file_id[:8]}... → {new_tei_file_id[:8]}...")
                    tei_updated_count += 1

                except Exception as e:
                    logger.error(f"    Error updating TEI {tei_stable_id}: {e}", exc_info=True)
                    continue

            if tei_updated_count == 0:
                pdfs_skipped += 1
                continue

            # Update PDF's doc_metadata with enriched metadata
            doc_metadata = {}
            for field in ['title', 'authors', 'date', 'journal', 'volume', 'issue', 'pages', 'publisher', 'doi', 'url']:
                if field in metadata and metadata[field]:
                    doc_metadata[field] = metadata[field]

            try:
                file_repo.update_file(pdf_obj.id, FileUpdate(
                    doc_metadata=doc_metadata  # Update with complete metadata
                ))
                logger.debug(f"  Updated PDF metadata: {len(doc_metadata)} fields")
            except ValueError as ve:
                logger.warning(f"  Failed to update PDF metadata: {ve}")

            logger.info(f"  Successfully updated {tei_updated_count} TEI file(s) for PDF {pdf_stable_id}")
            logger.debug(f"  Metadata: title={metadata.get('title', 'N/A')[:50]}, "
                       f"journal={metadata.get('journal', 'N/A')}, "
                       f"doi={metadata.get('doi', 'N/A')}")
            tei_files_updated += tei_updated_count

        except Exception as e:
            logger.error(f"Error processing PDF {pdf_stable_id}: {e}", exc_info=True)
            errors += 1

    # Return statistics
    return {
        'processed': pdfs_processed,
        'updated': tei_files_updated,
        'skipped': pdfs_skipped,
        'errors': errors
    }
