"""
File zip exporter for creating in-memory zip archives from exported files.

Creates zip archives from exported files using FileExporter and directory structure.
Supports streaming responses for large archives and XSLT transformations.
"""

from pathlib import Path
from typing import Optional, List, Dict
import tempfile
import zipfile
import logging
import shutil
import re

from fastapi_app.config import get_settings
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.storage.file_exporter import FileExporter

logger = logging.getLogger(__name__)

# Regex to validate plugin URLs (only allow /api/plugins/* URLs)
PLUGIN_URL_PATTERN = re.compile(r'^/api/plugins/[^/]+/static/')


class FileZipExporter:
    """
    Export files to in-memory zip archive.

    Usage:
        zip_exporter = FileZipExporter(db, storage, repo)
        zip_path = zip_exporter.export_to_zip(
            collections=["corpus1", "corpus2"],
            group_by="collection"
        )
        # Use zip_path for streaming response
        # Clean up with zip_exporter.cleanup()
    """

    def __init__(
        self,
        db: DatabaseManager,
        storage: FileStorage,
        repo: FileRepository
    ):
        """
        Initialize file zip exporter.

        Args:
            db: Database manager
            storage: File storage manager
            repo: File repository
        """
        self.db = db
        self.storage = storage
        self.repo = repo
        self.temp_dir: Optional[Path] = None

    def export_to_zip(
        self,
        collections: Optional[List[str]] = None,
        variants: Optional[List[str]] = None,
        regex: Optional[str] = None,
        include_versions: bool = False,
        group_by: str = "collection",
        filename_transforms: Optional[List[str]] = None,
        tei_only: bool = False,
        additional_formats: Optional[List[Dict[str, str]]] = None
    ) -> Path:
        """
        Export files to a zip archive.

        Args:
            collections: Filter by collection names (None = all collections)
            variants: Filter by variant names, supports glob patterns
            regex: Regular expression to filter filenames
            include_versions: If True, export versioned TEI files
            group_by: Grouping strategy: "type", "collection", or "variant"
            filename_transforms: List of sed-style transform patterns
            tei_only: If True, export only TEI files (no PDFs)
            additional_formats: Optional list of additional export formats 
                [{'id': format_id, 'url': xslt_url}, ...]

        Returns:
            Path to created zip file in temporary directory

        Raises:
            ValueError: If parameters are invalid
            RuntimeError: If export fails
        """
        # Create temporary directory for export
        self.temp_dir = Path(tempfile.mkdtemp(prefix="pdf-tei-export-"))
        export_dir = self.temp_dir / "export"
        export_dir.mkdir(parents=True)

        logger.info(f"Exporting files to temporary directory: {export_dir}")

        # Export files using FileExporter
        exporter = FileExporter(self.db, self.storage, self.repo, dry_run=False)

        try:
            stats = exporter.export_files(
                target_path=export_dir,
                collections=collections,
                variants=variants,
                regex=regex,
                include_versions=include_versions,
                group_by=group_by,
                filename_transforms=filename_transforms,
                tei_only=tei_only
            )

            logger.info(
                f"Exported {stats['files_exported']} files "
                f"({stats['files_skipped']} skipped, {len(stats['errors'])} errors)"
            )

            if stats['errors']:
                logger.warning(f"Export completed with {len(stats['errors'])} errors")

        except Exception as e:
            logger.error(f"Export failed: {e}")
            self.cleanup()
            raise RuntimeError(f"Export failed: {e}")

        # Apply additional XSLT transformations if requested
        if additional_formats:
            try:
                self._apply_xslt_transformations(export_dir, additional_formats)
            except Exception as e:
                logger.error(f"XSLT transformation failed: {e}")
                self.cleanup()
                raise RuntimeError(f"XSLT transformation failed: {e}")

        # Create zip file
        zip_path = self.temp_dir / "export.zip"

        logger.info(f"Creating zip archive: {zip_path}")

        try:
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
                # Walk the export directory and add all files
                for file_path in export_dir.rglob('*'):
                    if file_path.is_file():
                        # Store relative path in zip
                        arcname = file_path.relative_to(export_dir)
                        zipf.write(file_path, arcname=arcname)
                        logger.debug(f"Added to zip: {arcname}")

            logger.info(f"Zip archive created: {zip_path} ({zip_path.stat().st_size} bytes)")

        except Exception as e:
            logger.error(f"Failed to create zip archive: {e}")
            self.cleanup()
            raise RuntimeError(f"Failed to create zip archive: {e}")

        return zip_path

    def _apply_xslt_transformations(
        self,
        export_dir: Path,
        additional_formats: List[Dict[str, str]]
    ) -> None:
        """
        Apply XSLT transformations to TEI files for additional export formats.

        Args:
            export_dir: The export directory containing TEI files
            additional_formats: List of format specifications 
                [{'id': str, 'url': str, 'output': str, 'stripTags': bool}]
        """
        try:
            from lxml import etree
        except ImportError:
            logger.warning("lxml not available, skipping XSLT transformations")
            return

        for format_spec in additional_formats:
            format_id = format_spec.get('id')
            xslt_url = format_spec.get('url')
            output_type = format_spec.get('output', 'html')
            strip_tags = format_spec.get('stripTags', False)
            ext = format_spec.get('ext', format_id)  # Use ext field or fallback to format_id

            if not format_id or not xslt_url:
                logger.warning(f"Invalid format specification: {format_spec}")
                continue

            # Only allow plugin URLs for security
            if not PLUGIN_URL_PATTERN.match(xslt_url):
                logger.warning(f"Rejected non-plugin URL for XSLT: {xslt_url}")
                continue

            logger.info(f"Applying XSLT transformation for format: {format_id} (output={output_type}, stripTags={strip_tags}, ext={ext})")

            # Fetch the XSLT stylesheet
            try:
                from fastapi_app.config import get_settings
                settings = get_settings()
                # Map plugin URL to filesystem path
                xslt_path = self._url_to_path(xslt_url, settings)
                if not xslt_path or not xslt_path.exists():
                    logger.warning(f"XSLT file not found: {xslt_path}")
                    continue

                # Parse XSLT
                with open(xslt_path, 'rb') as f:
                    xslt_doc = etree.parse(f)
                    xslt_transform = etree.XSLT(xslt_doc)

                logger.debug(f"Loaded XSLT from: {xslt_path}")

            except Exception as e:
                logger.error(f"Failed to load XSLT from {xslt_url}: {e}")
                continue

            # Find all TEI XML files in the export directory
            # Only look for files ending in "tei.xml"
            # Exclude any format output directories (csv/, ris/, html/, etc.)
            tei_files = []
            for pattern in ['**/*.tei.xml']:
                for file_path in export_dir.glob(pattern):
                    # Skip files in format output directories
                    rel_path = file_path.relative_to(export_dir)
                    if rel_path.parts[0] in ['csv', 'ris', 'html', 'table']:
                        continue
                    tei_files.append(file_path)

            # Also look in tei/ subdirectories
            tei_dirs = list(export_dir.glob('*/tei')) + list(export_dir.glob('*/versions'))
            for tei_dir in tei_dirs:
                for pattern in ['**/*.tei.xml']:
                    for file_path in tei_dir.glob(pattern):
                        tei_files.append(file_path)

            # Remove duplicates
            tei_files = list(set(tei_files))

            if not tei_files:
                logger.debug("No TEI files found for XSLT transformation")
                continue

            logger.info(f"Found {len(tei_files)} TEI files to transform with {format_id}")

            # Group TEI files by their parent collection/type folder
            # This ensures format folders are placed within the same collection structure
            tei_files_by_path: Dict[Path, List[Path]] = {}
            for tei_file in tei_files:
                # Find the top-level collection folder for this file
                # Files are in structure like: export_dir/collection/tei/file.tei.xml
                # We want: export_dir/collection/csv/file.csv
                rel_path = tei_file.relative_to(export_dir)
                parts = rel_path.parts
                
                # Determine the collection/type folder (first part after export_dir)
                if len(parts) >= 2:
                    # e.g., "grobid-batch-1/tei/file.xml" -> collection = "grobid-batch-1"
                    collection_folder = parts[0]
                    parent_folder = export_dir / collection_folder
                elif len(parts) == 1:
                    # File is directly in export_dir
                    collection_folder = export_dir
                    parent_folder = export_dir
                else:
                    parent_folder = export_dir
                
                if parent_folder not in tei_files_by_path:
                    tei_files_by_path[parent_folder] = []
                tei_files_by_path[parent_folder].append(tei_file)

            # Apply transformation to files in each collection/type folder
            for parent_folder, files in tei_files_by_path.items():
                # Create format folder within the collection/type folder
                format_dir = parent_folder / format_id
                format_dir.mkdir(parents=True, exist_ok=True)

                for tei_file in files:
                    try:
                        # Read and parse the TEI file
                        with open(tei_file, 'rb') as f:
                            doc = etree.parse(f)

                        # Apply XSLT transformation
                        result = xslt_transform(doc)

                        # Convert result to string
                        result_str = str(result) if not isinstance(result, str) else result

                        # Strip HTML tags if requested
                        if strip_tags:
                            result_str = self._strip_html_tags(result_str)

                        # Use the ext field for output extension (with leading period)
                        output_ext = f'.{ext}' if ext else '.txt'

                        # Determine output filename - strip ".tei" from the stem
                        # e.g., "doc.tei.xml" -> "doc"
                        output_filename = tei_file.stem
                        if output_filename.endswith('.tei'):
                            output_filename = output_filename[:-4]  # Remove ".tei"

                        # Write output file in the format folder
                        output_file = format_dir / f"{output_filename}{output_ext}"
                        with open(output_file, 'w', encoding='utf-8') as f:
                            f.write(result_str)

                        logger.debug(f"Transformed {tei_file.name} -> {output_file.name}")

                    except Exception as e:
                        logger.error(f"Failed to transform {tei_file}: {e}")

    @staticmethod
    def _strip_html_tags(html_content: str) -> str:
        """
        Strip all HTML tags from the content, preserving newlines in <pre> tags.

        Args:
            html_content: HTML content with tags

        Returns:
            Plain text content without HTML tags, with preserved newlines
        """
        import re
        import uuid

        # Replace <br> and <br/> with newline
        text = re.sub(r'<br\s*/?>', "\n", html_content, flags=re.IGNORECASE)

        # Handle <pre> tags - extract content and replace with a placeholder that preserves newlines
        pre_content_map = {}

        def replace_pre(match):
            # Get the content inside <pre> tags
            content = match.group(1)
            # Create a unique placeholder
            placeholder = f"__PRE_CONTENT_{uuid.uuid4().hex}__"
            # Store the content with newlines preserved
            pre_content_map[placeholder] = content
            return placeholder

        # Find all <pre>...</pre> patterns (non-greedy)
        text = re.sub(r'<pre[^>]*>(.*?)</pre>', replace_pre, text, flags=re.DOTALL | re.IGNORECASE)

        # Remove remaining HTML tags
        text = re.sub(r'<[^>]+>', '', text)

        # Restore <pre> content (with preserved newlines)
        for placeholder, content in pre_content_map.items():
            text = text.replace(placeholder, content)

        # Normalize remaining whitespace (but preserve intentional newlines)
        # Split by newlines, normalize each line, then rejoin
        lines = text.split('\n')
        normalized_lines = [re.sub(r'\s+', ' ', line).strip() for line in lines]
        text = '\n'.join(line for line in normalized_lines if line)

        return text

    def _url_to_path(self, url: str, settings) -> Optional[Path]:
        """
        Convert a plugin static file URL to an absolute filesystem path.

        Args:
            url: URL like /api/plugins/{plugin_id}/static/{path}
            settings: Application settings

        Returns:
            Absolute Path to the file, or None if conversion fails
        """
        logger.debug(f"Converting URL to path: {url}")

        # Extract the plugin path from the URL
        # URL format: /api/plugins/{plugin_id}/static/{path}
        # The {path} is relative to the plugin's static/ directory
        match = re.match(r'^/api/plugins/([^/]+)/static/(.+)$', url)
        if not match:
            logger.debug(f"URL does not match plugin pattern: {url}")
            return None

        plugin_id = match.group(1)
        relative_path = match.group(2)
        logger.debug(f"Plugin ID: {plugin_id}, Relative path: {relative_path}")

        # Get the app's plugins directory
        app_plugins_dir = get_settings().plugins_code_dir
        logger.debug(f"App plugins directory: {app_plugins_dir}")

        # The static URL maps to the plugin's static/ directory
        # So if URL is /api/plugins/xslt_export/static/biblstruct-to-csv.xslt
        # The path should be: .../plugins/xslt_export/static/biblstruct-to-csv.xslt
        static_path = app_plugins_dir / plugin_id / 'static' / relative_path
        logger.debug(f"Checking standard path: {static_path} (exists: {static_path.exists()})")

        if static_path.exists():
            return static_path

        # Also check FASTAPI_PLUGIN_PATHS environment variable
        plugin_paths_env = getattr(settings, 'fastapi_plugin_paths', None)
        if plugin_paths_env:
            for base_path in plugin_paths_env.split(':'):
                alt_path = Path(base_path) / plugin_id / 'static' / relative_path
                logger.debug(f"Checking alt path: {alt_path} (exists: {alt_path.exists()})")
                if alt_path.exists():
                    return alt_path

        logger.debug(f"Could not resolve URL {url} to filesystem path")
        return None

    def cleanup(self):
        """
        Clean up temporary directory and files.

        Should be called after the zip file has been sent to the client.
        """
        if self.temp_dir and self.temp_dir.exists():
            logger.info(f"Cleaning up temporary directory: {self.temp_dir}")
            shutil.rmtree(self.temp_dir)
            self.temp_dir = None
