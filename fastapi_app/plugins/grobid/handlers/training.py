"""Handler for GROBID createTraining API endpoint."""

import os
import time
import zipfile
import logging
from typing import Dict, Any
from urllib.parse import urlparse

from requests.exceptions import ConnectionError, RequestException  # type: ignore[import-untyped]

from fastapi_app.config import get_settings
from fastapi_app.lib.extraction import get_retry_session
from fastapi_app.plugins.grobid.handlers.base import GrobidHandler
from fastapi_app.plugins.grobid.config import get_supported_variants

logger = logging.getLogger(__name__)


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

            # Read the training file content
            with open(training_file, 'r', encoding='utf-8') as f:
                return f.read()

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

                response = session.post(url, files=files, timeout=300)  # 5 minute timeout
                response.raise_for_status()
        except (ConnectionError, RequestException) as e:
            # Log full error for debugging
            logger.error(f"GROBID connection failed: {e}", exc_info=True)

            # Extract hostname for user-friendly message
            parsed_url = urlparse(grobid_server_url)
            hostname = parsed_url.netloc or parsed_url.path

            # Raise user-friendly error
            raise RuntimeError(f"Cannot connect to {hostname}")

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
