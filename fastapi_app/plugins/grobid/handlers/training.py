"""Handler for GROBID createTraining API endpoint."""

import os
import time
import zipfile
import logging
from typing import Dict, Any
from urllib.parse import urlparse

from requests.exceptions import ConnectionError, RequestException, RetryError  # type: ignore[import-untyped]

from fastapi_app.config import get_settings
from fastapi_app.lib.extraction import get_retry_session
from fastapi_app.plugins.grobid.handlers.base import GrobidHandler
from fastapi_app.plugins.grobid.config import get_grobid_extraction_timeout, get_supported_variants, get_variant_content_locations

logger = logging.getLogger(__name__)

_NS = "http://www.tei-c.org/ns/1.0"


def _get_element_at_path(root: "etree._Element", path: str) -> "etree._Element | None":
    """Find an element by a slash-separated tag path, trying namespaced and plain names."""
    from lxml import etree
    current = root
    for tag in path.split("/"):
        child = current.find(f"{{{_NS}}}{tag}") or current.find(tag)
        if child is None:
            return None
        current = child
    return current


def _ensure_element_at_path(root: "etree._Element", path: str) -> "etree._Element":
    """Find or create nested elements along a slash-separated tag path."""
    from lxml import etree
    current = root
    for tag in path.split("/"):
        child = current.find(f"{{{_NS}}}{tag}") or current.find(tag)
        if child is None:
            child = etree.SubElement(current, f"{{{_NS}}}{tag}")
        current = child
    return current


def normalize_grobid_content(xml_str: str, variant_id: str) -> str:
    """Move training content from its GROBID location to the annotation location.

    For variants whose GROBID output places content in a non-standard element
    (e.g. teiHeader instead of text), this moves the children of the source
    element into the annotation target path and removes the now-empty source.
    """
    from lxml import etree
    locations = get_variant_content_locations()
    if variant_id not in locations:
        return xml_str
    loc = locations[variant_id]
    grobid_path = loc["grobid_path"]
    annotation_path = loc["annotation_path"]
    if grobid_path == annotation_path:
        return xml_str

    parser = etree.XMLParser(recover=True)
    root = etree.fromstring(xml_str.encode("utf-8"), parser)

    source = _get_element_at_path(root, grobid_path)
    if source is None:
        return xml_str

    target = _ensure_element_at_path(root, annotation_path)
    for child in list(source):
        target.append(child)

    parent_path = "/".join(grobid_path.split("/")[:-1])
    if parent_path:
        parent = _get_element_at_path(root, parent_path)
        if parent is not None:
            parent.remove(source)
    else:
        root.remove(source)

    return etree.tostring(root, encoding="unicode", xml_declaration=False)


def denormalize_grobid_content(xml_str: str, variant_id: str) -> str:
    """Reverse normalization: move training content from annotation location back to GROBID location.

    Used during training export to reconstruct the original GROBID TEI structure
    expected by the GROBID trainer.
    """
    from lxml import etree
    locations = get_variant_content_locations()
    if variant_id not in locations:
        return xml_str
    loc = locations[variant_id]
    grobid_path = loc["grobid_path"]
    annotation_path = loc["annotation_path"]
    if grobid_path == annotation_path:
        return xml_str

    parser = etree.XMLParser(recover=True)
    root = etree.fromstring(xml_str.encode("utf-8"), parser)

    source = _get_element_at_path(root, annotation_path)
    if source is None:
        return xml_str

    # Remove the app-generated element at grobid_path top-level (e.g. teiHeader with metadata)
    top_grobid_tag = grobid_path.split("/")[0]
    for existing in root.findall(f"{{{_NS}}}{top_grobid_tag}") + root.findall(top_grobid_tag):
        root.remove(existing)

    target = _ensure_element_at_path(root, grobid_path)
    for child in list(source):
        target.append(child)

    # Move the reconstructed grobid_path root element to position 0
    grobid_root_elem = root.find(f"{{{_NS}}}{top_grobid_tag}") or root.find(top_grobid_tag)
    if grobid_root_elem is not None:
        root.remove(grobid_root_elem)
        root.insert(0, grobid_root_elem)

    # Remove the now-empty annotation path top-level element
    ann_top_tag = annotation_path.split("/")[0]
    for elem in root.findall(f"{{{_NS}}}{ann_top_tag}") + root.findall(ann_top_tag):
        root.remove(elem)

    return etree.tostring(root, encoding="unicode", xml_declaration=False)


class TrainingHandler(GrobidHandler):
    """Handler for /api/createTraining endpoint."""

    def get_endpoint(self) -> str:
        return "/api/createTraining"

    def get_supported_variants(self) -> list[str]:
        """Return training variants (those starting with 'grobid.training.')."""
        return [v for v in get_supported_variants() if v.startswith("grobid.training.")]

    def fetch_tei(self, pdf_path: str, grobid_server_url: str,
                  variant_id: str, flavor: str, options: Dict[str, Any]) -> str:
        """
        Fetch training data from GROBID createTraining endpoint.

        The createTraining endpoint returns a ZIP file containing multiple
        training data variants. This method extracts the specific variant
        file matching the requested variant_id.
        """
        import shutil

        settings = get_settings()
        temp_dir, extracted_files = self._fetch_training_package(pdf_path, grobid_server_url, flavor)

        try:
            # Find the file that corresponds to the variant
            training_file = None
            suffix = f'.{variant_id.removeprefix("grobid.")}.tei.xml'
            for filename in extracted_files:
                if filename.endswith(suffix):
                    training_file = os.path.join(temp_dir, filename)
                    break

            if not training_file:
                raise RuntimeError(f"Could not find '*{suffix}' file in GROBID output")

            # Read the training file content and normalize content location
            with open(training_file, 'r', encoding='utf-8') as f:
                content = f.read()
            return normalize_grobid_content(content, variant_id)

        finally:
            # Clean up temp directory in production mode
            if settings.application_mode == "production":
                shutil.rmtree(temp_dir, ignore_errors=True)

    def _fetch_training_package(self, pdf_path: str, grobid_server_url: str, flavor: str) -> tuple[str, list[str]]:
        """
        Fetch training data package from GROBID and extract to temp directory.

        Args:
            pdf_path: Path to the PDF file
            grobid_server_url: GROBID server URL
            flavor: Processing flavor

        Returns:
            Tuple of (temp_dir path, list of extracted filenames)
        """
        logger.info(f"Fetching training package from {pdf_path} via GROBID")

        # Create session with retry logic
        session = get_retry_session(retries=5, backoff_factor=2.0)

        # Create project temp directory for processing
        settings = get_settings()
        temp_base = settings.tmp_dir / "grobid"
        temp_base.mkdir(parents=True, exist_ok=True)

        timestamp = int(time.time() * 1000)
        temp_dir = temp_base / f"{timestamp}"
        temp_dir.mkdir(parents=True, exist_ok=True)

        # Call GROBID createTraining API
        url = f"{grobid_server_url}{self.get_endpoint()}"

        try:
            with open(pdf_path, 'rb') as pdf_file:
                files = {
                    'input': pdf_file,
                    'flavor': ('', flavor)
                }

                response = session.post(url, files=files, timeout=get_grobid_extraction_timeout())
                response.raise_for_status()
        except (ConnectionError, RetryError, RequestException) as e:
            reason = str(e.__cause__ or e).split('\n')[0]
            logger.error(f"GROBID request failed: {reason}")
            parsed_url = urlparse(grobid_server_url)
            hostname = parsed_url.netloc or parsed_url.path
            raise RuntimeError(f"GROBID request to {hostname} failed: {reason}") from None

        # Save ZIP file
        zip_path = temp_dir / "training.zip"
        with open(zip_path, 'wb') as f:
            f.write(response.content)

        # Extract ZIP file
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(temp_dir)

        # Get list of extracted files (excluding the zip itself)
        extracted_files = [f for f in os.listdir(temp_dir) if f != "training.zip"]

        return str(temp_dir), extracted_files
