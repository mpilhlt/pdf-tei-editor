"""Handler for GROBID processFulltextDocument API endpoint."""

import logging
from typing import Dict, Any
from urllib.parse import urlparse

from requests.exceptions import ConnectionError, RequestException  # type: ignore[import-untyped]

from fastapi_app.lib.extraction import get_retry_session
from fastapi_app.plugins.grobid.handlers.base import GrobidHandler

logger = logging.getLogger(__name__)


class FulltextHandler(GrobidHandler):
    """Handler for /api/processFulltextDocument endpoint."""

    def get_endpoint(self) -> str:
        return "/api/processFulltextDocument"

    def get_supported_variants(self) -> list[str]:
        return ["grobid.service.fulltext"]

    def fetch_tei(self, pdf_path: str, grobid_server_url: str,
                  variant_id: str, flavor: str, options: Dict[str, Any]) -> str:
        """
        Fetch full-text TEI from GROBID processFulltextDocument endpoint.

        Returns TEI XML representing header, body, and bibliographical section.
        """
        logger.info(f"Processing fulltext document: {pdf_path}")

        session = get_retry_session(retries=5, backoff_factor=2.0)
        url = f"{grobid_server_url}{self.get_endpoint()}"

        try:
            with open(pdf_path, 'rb') as pdf_file:
                files = {'input': pdf_file}
                # Use sensible defaults for service options
                data = {
                    'consolidateHeader': '0',
                    'consolidateCitations': '0',
                    'includeRawCitations': '1',
                    'includeRawAffiliations': '1',
                }

                response = session.post(url, files=files, data=data, timeout=300)
                response.raise_for_status()
                return response.text

        except (ConnectionError, RequestException) as e:
            logger.error(f"GROBID connection failed: {e}", exc_info=True)
            parsed_url = urlparse(grobid_server_url)
            hostname = parsed_url.netloc or parsed_url.path
            raise RuntimeError(f"Cannot connect to {hostname}")
