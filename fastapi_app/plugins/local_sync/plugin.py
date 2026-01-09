"""
Local Sync Plugin - Synchronize collection documents with local filesystem.
"""

from fastapi_app.lib.plugin_base import Plugin
from typing import Any
from pathlib import Path
import hashlib
from datetime import datetime
from lxml import etree


class LocalSyncPlugin(Plugin):
    """Plugin for synchronizing TEI documents between collection and filesystem."""

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "local-sync",
            "name": "Local Sync",
            "description": "Synchronize collection documents with local filesystem",
            "category": "sync",
            "version": "1.0.0",
            "required_roles": ["reviewer"],
            "endpoints": [
                {
                    "name": "sync",
                    "label": "Sync with Local Folder",
                    "description": "Synchronize current collection with local filesystem",
                    "state_params": ["collection", "variant"]
                }
            ]
        }

    @classmethod
    def is_available(cls) -> bool:
        """Only available if enabled, repo path configured, and user has reviewer role."""
        from fastapi_app.lib.plugin_tools import get_plugin_config

        # Check if enabled
        enabled = get_plugin_config(
            "plugin.local-sync.enabled",
            "PLUGIN_LOCAL_SYNC_ENABLED",
            default=False,
            value_type="boolean"
        )

        if not enabled:
            return False

        # Check if repo path is configured
        repo_path = get_plugin_config(
            "plugin.local-sync.repo.path",
            "PLUGIN_LOCAL_SYNC_REPO_PATH",
            default=None
        )

        if not repo_path:
            return False

        return True

    def get_endpoints(self) -> dict[str, Any]:
        return {
            "sync": self.sync
        }

    async def sync(self, context, params: dict) -> dict:
        """
        Synchronize collection with local filesystem.

        Returns URLs for preview and execute endpoints.
        """
        collection_id = params.get("collection")
        variant = params.get("variant", "all")

        if not collection_id:
            return {"html": "<p>Error: No collection selected</p>"}

        # Build URLs for preview and execute
        variant_param = f"&variant={variant}" if variant != "all" else ""
        preview_url = f"/api/plugins/local-sync/preview?collection={collection_id}{variant_param}"
        execute_url = f"/api/plugins/local-sync/execute?collection={collection_id}{variant_param}"

        return {
            "outputUrl": preview_url,
            "executeUrl": execute_url,
            "collection": collection_id,
            "variant": variant
        }

    async def _sync_collection(
        self,
        collection_id: str,
        variant: str,
        repo_path: Path,
        backup_enabled: bool,
        dry_run: bool,
        context
    ) -> dict:
        """
        Perform bidirectional sync between collection and filesystem.

        Returns:
            Dictionary with sync statistics and details
        """
        from fastapi_app.lib.dependencies import get_db, get_file_storage
        from fastapi_app.lib.file_repository import FileRepository
        from fastapi_app.lib.config_utils import get_config

        results: dict[str, list[dict[str, Any]]] = {
            "skipped": [],
            "updated_fs": [],
            "updated_collection": [],
            "errors": []
        }

        db = get_db()
        file_repo = FileRepository(db)
        file_storage = get_file_storage()

        # Get filter patterns from config
        config = get_config()
        include_pattern = config.get("plugin.local-sync.repo.include")
        exclude_pattern = config.get("plugin.local-sync.repo.exclude")

        # 1. Scan filesystem for TEI files
        fs_docs = self._scan_filesystem(repo_path, include_pattern, exclude_pattern)

        # 2. Get ALL gold standard documents in the collection (any variant) for doc_id filtering
        all_collection_docs = file_repo.list_files(
            collection=collection_id,
            file_type="tei"
        )
        all_collection_docs = [d for d in all_collection_docs if d.is_gold_standard]
        collection_doc_ids = {doc.doc_id for doc in all_collection_docs}

        # Get gold standard collection documents for the specific variant (if specified)
        if variant != "all":
            collection_docs = file_repo.list_files(
                collection=collection_id,
                variant=variant,
                file_type="tei"
            )
        else:
            collection_docs = file_repo.list_files(
                collection=collection_id,
                file_type="tei"
            )

        # Filter for gold standard only
        collection_docs = [d for d in collection_docs if d.is_gold_standard]

        # 3. Build lookup maps
        # Key: (doc_id, variant) -> FileMetadata
        # Use doc.id (content hash) for comparison, no need to read file
        collection_map = {}
        for doc in collection_docs:
            key = (doc.doc_id, doc.variant or "")
            collection_map[key] = doc

        # Key: (fileref, variant) -> (path, content, hash, timestamp)
        fs_map = {}
        for path, content in fs_docs.items():
            try:
                from fastapi_app.lib.tei_utils import (
                    extract_fileref,
                    extract_variant_id,
                    extract_revision_timestamp
                )

                content_hash = hashlib.sha256(content).hexdigest()
                timestamp = extract_revision_timestamp(content)
                fileref = extract_fileref(content)
                fs_variant = extract_variant_id(content)

                if fileref:
                    key = (fileref, fs_variant or "")
                    fs_map[key] = (path, content, content_hash, timestamp)
                else:
                    results["errors"].append({
                        "fileref": f"filesystem:{path.name}",
                        "error": "No fileref found in TEI document"
                    })
            except Exception as e:
                results["errors"].append({
                    "fileref": f"filesystem:{path.name}",
                    "error": f"Error reading filesystem document: {str(e)}"
                })

        # Filter filesystem map by variant if specified
        if variant != "all":
            fs_map = {k: v for k, v in fs_map.items() if k[1] == variant}

        # Filter filesystem map to only include docs that exist in target collection
        # This prevents importing documents that belong to other collections or are completely new
        fs_map = {k: v for k, v in fs_map.items() if k[0] in collection_doc_ids}

        # Build a cache of doc_id -> metadata for display labels
        metadata_cache = {}
        for doc_id in collection_doc_ids:
            try:
                # Get PDF file for this document to extract metadata
                pdf_file = file_repo.get_pdf_for_document(doc_id)
                if pdf_file:
                    metadata_cache[doc_id] = pdf_file.doc_metadata or {}
                else:
                    metadata_cache[doc_id] = {}
            except Exception:
                metadata_cache[doc_id] = {}

        # 4. Compare and sync
        all_keys = set(collection_map.keys()) | set(fs_map.keys())

        for key in all_keys:
            doc_id, var = key
            display_ref = self._format_display_label(doc_id, var, metadata_cache.get(doc_id, {}))

            try:
                if key in collection_map and key in fs_map:
                    # Both exist - check for differences
                    col_doc = collection_map[key]
                    fs_path, fs_content, fs_hash, fs_timestamp = fs_map[key]

                    if col_doc.id == fs_hash:
                        results["skipped"].append({
                            "fileref": display_ref,
                            "reason": "identical"
                        })
                        continue

                    # Content differs - check timestamps
                    # Need to read collection file to get timestamp
                    col_content = file_storage.read_file(col_doc.id, "tei")
                    if col_content is None:
                        results["errors"].append({
                            "fileref": display_ref,
                            "error": "Collection file content is None"
                        })
                        continue

                    from fastapi_app.lib.tei_utils import extract_revision_timestamp
                    col_timestamp = extract_revision_timestamp(col_content)

                    if col_timestamp and fs_timestamp:
                        if col_timestamp > fs_timestamp:
                            # Collection newer - update filesystem
                            if not dry_run:
                                self._update_filesystem(fs_path, col_content, backup_enabled)
                            results["updated_fs"].append({
                                "fileref": display_ref,
                                "path": str(fs_path),
                                "col_timestamp": col_timestamp,
                                "fs_timestamp": fs_timestamp
                            })
                        elif fs_timestamp > col_timestamp:
                            # Filesystem newer - create new version
                            if not dry_run:
                                self._create_new_version(file_repo, file_storage, col_doc, fs_content, context.user)
                            results["updated_collection"].append({
                                "fileref": display_ref,
                                "stable_id": col_doc.stable_id,
                                "col_timestamp": col_timestamp,
                                "fs_timestamp": fs_timestamp
                            })
                        else:
                            # Same timestamp but different content - import as new version
                            # This can happen if files were edited externally without updating timestamps
                            if not dry_run:
                                self._create_new_version(file_repo, file_storage, col_doc, fs_content, context.user)
                            results["updated_collection"].append({
                                "fileref": display_ref,
                                "stable_id": col_doc.stable_id,
                                "col_timestamp": col_timestamp,
                                "fs_timestamp": fs_timestamp
                            })
                    else:
                        results["errors"].append({
                            "fileref": display_ref,
                            "error": "Missing timestamp in one or both documents"
                        })

                elif key in collection_map:
                    # Only in collection - skip
                    results["skipped"].append({
                        "fileref": display_ref,
                        "reason": "only_in_collection"
                    })

                else:
                    # Only in filesystem - import as new gold standard
                    # doc_id (fileref) is already in encoded form, ready to use
                    fs_path, fs_content, fs_hash, fs_timestamp = fs_map[key]
                    if not dry_run:
                        self._import_from_filesystem(file_repo, file_storage, doc_id, var, fs_content, context.user, collection_id)
                    results["updated_collection"].append({
                        "fileref": display_ref,
                        "stable_id": "(new)",
                        "fs_timestamp": fs_timestamp or "(unknown)",
                        "source": "filesystem"
                    })

            except Exception as e:
                results["errors"].append({
                    "fileref": display_ref,
                    "error": str(e)
                })

        return results

    def _format_display_label(self, doc_id: str, variant: str, metadata: dict) -> str:
        """
        Format a human-readable display label for a document.

        Args:
            doc_id: Document ID (fileref)
            variant: Variant identifier
            metadata: PDF metadata dictionary with authors, date, etc.

        Returns:
            Formatted label: "Lastname (Year) [doc_id:variant]" or fallback to doc_id:variant
        """
        # Try to extract author lastname and year
        author_name = None
        year = None

        # Extract first author's lastname
        if metadata and "authors" in metadata and len(metadata["authors"]) > 0:
            first_author = metadata["authors"][0]
            # Authors can be stored as dict with 'family' key or as string
            if isinstance(first_author, dict):
                author_name = first_author.get("family") or first_author.get("name")
            elif isinstance(first_author, str):
                # If it's a string, try to extract last name
                parts = first_author.split()
                author_name = parts[-1] if parts else first_author

        # Extract year from date
        if metadata and "date" in metadata and metadata["date"]:
            date_str = metadata["date"]
            # Try to extract 4-digit year
            import re
            year_match = re.search(r'\b(19|20)\d{2}\b', str(date_str))
            if year_match:
                year = year_match.group(0)

        # Build the label
        variant_part = f":{variant}" if variant else ""
        doc_ref = f"[{doc_id}{variant_part}]"

        if author_name and year:
            return f"{author_name} ({year}) {doc_ref}"
        elif author_name:
            return f"{author_name} {doc_ref}"
        elif year:
            return f"({year}) {doc_ref}"
        else:
            # Fallback to just doc_id:variant
            return f"{doc_id}{variant_part}"

    def _scan_filesystem(self, repo_path: Path, include_pattern: str | None = None, exclude_pattern: str | None = None) -> dict[Path, bytes]:
        """
        Recursively scan directory for *.tei.xml files with optional filtering.

        Args:
            repo_path: Root directory to scan
            include_pattern: Optional regex pattern - only include paths matching this pattern
            exclude_pattern: Optional regex pattern - exclude paths matching this pattern

        Returns:
            Dict mapping file paths to content bytes
        """
        import re

        docs = {}

        # Compile regex patterns if provided
        include_regex = re.compile(include_pattern) if include_pattern else None
        exclude_regex = re.compile(exclude_pattern) if exclude_pattern else None

        for tei_file in repo_path.rglob("*.tei.xml"):
            if not tei_file.is_file():
                continue

            # Convert path to string for regex matching
            path_str = str(tei_file)

            # Apply include filter if specified
            if include_regex and not include_regex.search(path_str):
                continue

            # Apply exclude filter if specified
            if exclude_regex and exclude_regex.search(path_str):
                continue

            docs[tei_file] = tei_file.read_bytes()

        return docs

    def _update_filesystem(self, fs_path: Path, content: bytes, backup_enabled: bool):
        """
        Update filesystem file with collection content.

        Creates timestamped backup if enabled.
        """
        if backup_enabled and fs_path.exists():
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_path = fs_path.with_suffix(f".{timestamp}.backup")
            fs_path.rename(backup_path)

        fs_path.write_bytes(content)

    def _import_from_filesystem(self, file_repo, file_storage, doc_id: str, variant: str, content: bytes, user, collection_id: str):
        """
        Import a new gold standard TEI file from the filesystem.

        Args:
            file_repo: File repository instance
            file_storage: File storage instance
            doc_id: Document ID (fileref)
            variant: Variant identifier
            content: TEI content as bytes
            user: User dict with username and fullname
            collection_id: Collection ID to add the file to
        """
        import logging
        from fastapi_app.lib.models import FileCreate
        from fastapi_app.lib.tei_utils import extract_tei_metadata

        logger = logging.getLogger(__name__)
        logger.debug(f"Importing from filesystem: doc_id={doc_id}, variant={variant}")

        # Calculate content hash
        content_hash = hashlib.sha256(content).hexdigest()
        logger.debug(f"Content hash: {content_hash[:16]}")

        # Parse and extract metadata
        root = etree.fromstring(content)
        tei_metadata = extract_tei_metadata(root)

        # Write file to storage
        saved_hash, storage_path = file_storage.save_file(content, "tei", increment_ref=True)
        logger.debug(f"Saved to storage: {saved_hash[:16]}, path: {storage_path}")

        # Build filename
        filename = f"{doc_id}.{variant}.tei.xml" if variant else f"{doc_id}.tei.xml"
        logger.debug(f"Creating gold standard file: {filename}")

        # Use the target collection being synced
        doc_collections = [collection_id]
        logger.debug(f"Adding file to collection: {collection_id}")

        # Create file record as gold standard
        try:
            created_file = file_repo.insert_file(
                FileCreate(
                    id=content_hash,
                    stable_id=None,  # Auto-generate
                    doc_id=doc_id,
                    filename=filename,
                    file_type="tei",
                    file_size=len(content),
                    variant=variant or None,
                    version=None,  # Gold standard has no version
                    label=None,  # Gold standard has no label
                    doc_collections=doc_collections,
                    file_metadata={},
                    is_gold_standard=True  # Import as gold standard
                )
            )
            logger.debug(f"Created gold standard with stable_id: {created_file.stable_id}")
            return created_file
        except Exception as e:
            logger.error(f"Failed to insert file: {e}", exc_info=True)
            raise

    def _create_new_version(self, file_repo, file_storage, doc, content: bytes, user):
        """
        Create new annotation version from filesystem content.

        Adds a revision change to the TEI document before saving to ensure unique content.
        """
        import logging
        from fastapi_app.lib.models import FileCreate
        from fastapi_app.lib.tei_utils import (
            extract_tei_metadata,
            extract_fileref,
            extract_last_revision_status,
            add_revision_change
        )

        logger = logging.getLogger(__name__)
        logger.debug(f"Creating new version for doc_id={doc.doc_id}, variant={doc.variant}")

        # Parse TEI content
        root = etree.fromstring(content)

        # Format current date
        import_timestamp = datetime.now().isoformat()
        import_date = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        version_name = f"Imported at {import_date}"

        # Get previous status (maintain same status)
        previous_status = extract_last_revision_status(root) or "draft"

        # Add revision change to make content unique
        # This also creates respStmt if needed
        add_revision_change(
            root=root,
            when=import_timestamp,
            status=previous_status,
            who=user['username'],
            desc=f"Imported from local filesystem at {import_date}",
            full_name=user.get('fullname')
        )

        # Update edition title to mark as imported
        ns = {'tei': 'http://www.tei-c.org/ns/1.0'}
        edition_title_elems = root.xpath('//tei:editionStmt/tei:edition/tei:title', namespaces=ns)
        if edition_title_elems:
            edition_title_elem = edition_title_elems[0]
            original_title = edition_title_elem.text or ""
            edition_title_elem.text = f"{original_title} (imported at {import_date})"

        # Serialize modified content with pretty-printing
        from fastapi_app.lib.tei_utils import serialize_tei_with_formatted_header
        content_str = serialize_tei_with_formatted_header(root)
        content = content_str.encode('utf-8')

        # Calculate hash of modified content
        content_hash = hashlib.sha256(content).hexdigest()
        logger.debug(f"Content hash (after revision): {content_hash[:16]}")

        # Extract metadata from TEI
        root = etree.fromstring(content)
        tei_metadata = extract_tei_metadata(root)

        # Get next version number
        latest_version = file_repo.get_latest_tei_version(doc.doc_id, doc.variant)
        next_version = ((latest_version.version or 0) + 1) if latest_version else 1
        logger.debug(f"Next version number: {next_version}")

        # Write file to storage (save_file handles deduplication)
        saved_hash, storage_path = file_storage.save_file(content, "tei", increment_ref=True)
        logger.debug(f"Saved to storage: {saved_hash[:16]}, path: {storage_path}")

        # Create file record in database as annotation version
        # Note: stable_id will be auto-generated (new version gets new stable_id)
        # Use doc.doc_id to ensure version is linked to same document as gold standard
        filename = f"{doc.doc_id}.{doc.variant}.v{next_version}.tei.xml" if doc.variant else f"{doc.doc_id}.v{next_version}.tei.xml"
        logger.debug(f"Creating file record with filename: {filename}")

        created_file = file_repo.insert_file(
            FileCreate(
                id=content_hash,
                stable_id=None,  # Auto-generate new stable_id for new version
                doc_id=doc.doc_id,  # Use gold standard's doc_id
                filename=filename,
                file_type="tei",
                file_size=len(content),
                variant=doc.variant,
                version=next_version,  # Assign version number
                label=version_name,  # Use import timestamp as label
                doc_collections=doc.doc_collections or [],
                file_metadata={},
                is_gold_standard=False  # Import as annotation version, not gold standard
            )
        )
        logger.debug(f"Created version with stable_id: {created_file.stable_id}")
        return created_file

    def _generate_detailed_report_html(self, results: dict, collection: str, variant: str, is_preview: bool) -> str:
        """Generate detailed HTML report for preview mode."""
        from fastapi_app.lib.plugin_tools import escape_html

        total = len(results["skipped"]) + len(results["updated_fs"]) + len(results["updated_collection"]) + len(results["errors"])

        skipped_identical = [s for s in results['skipped'] if s['reason'] == 'identical']
        skipped_collection_only = [s for s in results['skipped'] if s['reason'] == 'only_in_collection']
        skipped_filesystem_only = [s for s in results['skipped'] if s['reason'] == 'only_in_filesystem']

        html_parts = [
            "<!DOCTYPE html><html><head>",
            "<meta charset='utf-8'>",
            "<title>Local Sync Preview</title>",
            "<style>",
            "body { font-family: sans-serif; padding: 20px; max-width: 1000px; margin: 0 auto; }",
            "h2 { color: #333; border-bottom: 2px solid #ddd; padding-bottom: 10px; }",
            "h3 { color: #555; margin-top: 20px; }",
            ".preview-notice { background: #fff3cd; border: 1px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 4px; }",
            ".preview-notice strong { color: #856404; }",
            ".stats { background: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0; }",
            ".stats ul { list-style: none; padding: 0; }",
            ".stats li { padding: 5px 0; }",
            "ul { line-height: 1.6; }",
            ".timestamp { color: #666; font-size: 0.9em; }",
            "</style>",
            "</head><body>",
            f"<h2>Local Sync Preview - {escape_html(collection)}</h2>"
        ]

        if is_preview:
            html_parts.append(
                "<div class='preview-notice'>"
                "<strong>Preview Mode</strong> - No changes will be applied. "
                "Click the <strong>Execute</strong> button to apply these changes."
                "</div>"
            )

        html_parts.append(
            "<div class='stats'>"
            f"<p><strong>Total documents processed:</strong> {total}</p>"
            "<ul>"
            f"<li><strong>Skipped (identical):</strong> {len(skipped_identical)}</li>"
            f"<li><strong>Skipped (only in collection):</strong> {len(skipped_collection_only)}</li>"
            f"<li><strong>Skipped (only in filesystem):</strong> {len(skipped_filesystem_only)}</li>"
            f"<li><strong>Will update filesystem:</strong> {len(results['updated_fs'])}</li>"
            f"<li><strong>Will update collection:</strong> {len(results['updated_collection'])}</li>"
            f"<li><strong>Errors:</strong> {len(results['errors'])}</li>"
            "</ul>"
            "</div>"
        )

        # Show details for filesystem updates
        if results["updated_fs"]:
            html_parts.append("<h3>Filesystem Updates</h3><ul>")
            for item in results["updated_fs"]:
                html_parts.append(
                    f"<li><strong>{escape_html(item['fileref'])}</strong> - {escape_html(item['path'])}<br>"
                    f"<span class='timestamp'>Collection: {escape_html(item['col_timestamp'])} → Filesystem: {escape_html(item['fs_timestamp'])}</span></li>"
                )
            html_parts.append("</ul>")

        # Show details for collection updates
        if results["updated_collection"]:
            html_parts.append("<h3>Collection Updates</h3><ul>")
            for item in results["updated_collection"]:
                # Handle different update types
                if item.get("source") == "filesystem":
                    # Import from filesystem (no collection timestamp)
                    html_parts.append(
                        f"<li><strong>{escape_html(item['fileref'])}</strong> - {escape_html(item['stable_id'])}<br>"
                        f"<span class='timestamp'>Imported from filesystem: {escape_html(str(item['fs_timestamp']))}</span></li>"
                    )
                else:
                    # Update existing document (has both timestamps)
                    html_parts.append(
                        f"<li><strong>{escape_html(item['fileref'])}</strong> - {escape_html(item['stable_id'])}<br>"
                        f"<span class='timestamp'>Filesystem: {escape_html(str(item.get('fs_timestamp', 'unknown')))} → Collection: {escape_html(str(item.get('col_timestamp', 'unknown')))}</span></li>"
                    )
            html_parts.append("</ul>")

        # Show details for skipped identical
        if skipped_identical:
            html_parts.append("<h3>Skipped (Identical)</h3><ul>")
            for item in skipped_identical:
                html_parts.append(f"<li>{escape_html(item['fileref'])}</li>")
            html_parts.append("</ul>")

        # Show details for skipped (only in collection)
        if skipped_collection_only:
            html_parts.append("<h3>Skipped (Only in Collection)</h3><ul>")
            for item in skipped_collection_only:
                html_parts.append(f"<li>{escape_html(item['fileref'])}</li>")
            html_parts.append("</ul>")

        # Show details for skipped (only in filesystem)
        if skipped_filesystem_only:
            html_parts.append("<h3>Skipped (Only in Filesystem)</h3><ul>")
            for item in skipped_filesystem_only:
                html_parts.append(f"<li>{escape_html(item['fileref'])}</li>")
            html_parts.append("</ul>")

        # Show errors
        if results["errors"]:
            html_parts.append("<h3>Errors</h3><ul>")
            for item in results["errors"]:
                html_parts.append(f"<li>{escape_html(item.get('fileref', 'unknown'))}: {escape_html(item['error'])}</li>")
            html_parts.append("</ul>")

        html_parts.append("</body></html>")

        return "".join(html_parts)

    def _generate_summary_report_html(self, results: dict, is_preview: bool) -> str:
        """Generate summary HTML report for execute mode (statistics only)."""
        from fastapi_app.lib.plugin_tools import escape_html

        total = len(results["skipped"]) + len(results["updated_fs"]) + len(results["updated_collection"]) + len(results["errors"])

        skipped_identical = [s for s in results['skipped'] if s['reason'] == 'identical']
        skipped_collection_only = [s for s in results['skipped'] if s['reason'] == 'only_in_collection']
        skipped_filesystem_only = [s for s in results['skipped'] if s['reason'] == 'only_in_filesystem']

        html_parts = [
            "<!DOCTYPE html><html><head>",
            "<meta charset='utf-8'>",
            "<title>Local Sync Complete</title>",
            "<style>",
            "body { font-family: sans-serif; padding: 20px; max-width: 600px; margin: 0 auto; }",
            "h2 { color: #333; border-bottom: 2px solid #ddd; padding-bottom: 10px; }",
            ".success-notice { background: #d4edda; border: 1px solid #28a745; padding: 15px; margin: 20px 0; border-radius: 4px; color: #155724; }",
            ".stats { background: #f8f9fa; padding: 15px; border-radius: 4px; margin: 20px 0; }",
            ".stats ul { list-style: none; padding: 0; }",
            ".stats li { padding: 5px 0; }",
            "</style>",
            "</head><body>",
            "<h2>Local Sync Complete</h2>",
            "<div class='success-notice'>",
            "Synchronization completed successfully.",
            "</div>",
            "<div class='stats'>",
            f"<p><strong>Total documents processed:</strong> {total}</p>",
            "<ul>",
            f"<li><strong>Skipped (identical):</strong> {len(skipped_identical)}</li>",
            f"<li><strong>Skipped (only in collection):</strong> {len(skipped_collection_only)}</li>",
            f"<li><strong>Skipped (only in filesystem):</strong> {len(skipped_filesystem_only)}</li>",
            f"<li><strong>Updated filesystem:</strong> {len(results['updated_fs'])}</li>",
            f"<li><strong>Updated collection:</strong> {len(results['updated_collection'])}</li>",
            f"<li><strong>Errors:</strong> {len(results['errors'])}</li>",
            "</ul>",
            "</div>"
        ]

        # Show errors if any
        if results["errors"]:
            html_parts.append("<h3>Errors</h3><ul>")
            for item in results["errors"]:
                html_parts.append(f"<li>{escape_html(item.get('fileref', 'unknown'))}: {escape_html(item['error'])}</li>")
            html_parts.append("</ul>")

        html_parts.append("</body></html>")

        return "".join(html_parts)
