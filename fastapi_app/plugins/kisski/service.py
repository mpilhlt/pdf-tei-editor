"""
KISSKI service implementation for structured data extraction.
"""

import asyncio
import logging
from functools import partial
from typing import Any, Dict, Optional
from fastapi_app.lib.service_registry import ExtractionService, ExtractionResult, ModelCapabilityFilter
from .extractor import KisskiExtractor

logger = logging.getLogger(__name__)


class KisskiService(ExtractionService):
    """KISSKI service for structured data extraction."""

    def __init__(self):
        super().__init__(
            service_id="kisski-extractor",
            service_name="KISSKI Extractor",
            capabilities=["structured-data-extraction"]
        )
        self._extractor = KisskiExtractor()

    def _select_model(self, capabilities: ModelCapabilityFilter | None = None) -> str | None:
        """
        Select a model that satisfies the given capability requirements.

        Args:
            capabilities: Filter specifying required modalities per axis,
                e.g. {"input": ["image"]}.  None means any model is acceptable.

        Returns:
            Model ID of the first matching model, or None if none qualify.
        """
        models = self._extractor.get_models_with_capabilities()
        for m in models:
            if capabilities:
                matched = True
                for axis, required_caps in capabilities.items():
                    if not all(cap in m.get(axis, []) for cap in required_caps):
                        matched = False
                        break
                if not matched:
                    continue
            return m.get("id")
        return None

    async def extract(
        self,
        prompt: str,
        model: str | None = None,
        model_capabilities: ModelCapabilityFilter | None = None,
        stable_id: Optional[str] = None,
        text_input: Optional[str] = None,
        json_schema: Optional[Dict[str, Any]] = None,
        temperature: float = 0.1,
        max_retries: int = 2,
        **kwargs: Any,
    ) -> ExtractionResult:
        """
        Extract structured data using KISSKI with full type safety.

        Either *model* (exact ID) or *model_capabilities* (filter) must be
        provided.  When *model_capabilities* is given the service selects an
        appropriate model automatically.

        Args:
            prompt: Extraction prompt
            model: Exact model ID to use (optional if model_capabilities given)
            model_capabilities: Capability filter for automatic model selection
            stable_id: PDF file stable_id (optional)
            text_input: Plain text to extract from (optional)
            json_schema: JSON schema for validation (optional)
            temperature: LLM temperature
            max_retries: Maximum retries for validation

        Returns:
            Extraction result with typed structure
        """
        # Convert stable_id to pdf_path if provided
        pdf_path = None
        if stable_id:
            pdf_path = self._resolve_stable_id_to_path(stable_id)

        # Select model from capabilities filter when no exact model given
        if not model:
            resolved = self._select_model(model_capabilities)
            if resolved is None:
                return ExtractionResult({
                    "success": False,
                    "data": {},
                    "model": "",
                    "extractor": "kisski-extractor",
                    "retries": 0,
                })
            logger.debug(f"Auto-selected model: {resolved}")
            model = resolved

        # Run sync extractor in thread pool to avoid blocking event loop
        result = await asyncio.to_thread(
            partial(
                self._extractor.extract,
                model=model,
                prompt=prompt,
                pdf_path=pdf_path,
                text_input=text_input,
                json_schema=json_schema,
                temperature=temperature,
                max_retries=max_retries,
            )
        )

        # Convert to typed result structure
        return ExtractionResult({
            "success": result.get("success", False),
            "data": result.get("data", {}),
            "model": result.get("model", model),
            "extractor": result.get("extractor", "kisski-extractor"),
            "retries": result.get("retries", 0)
        })

    def _resolve_stable_id_to_path(self, stable_id: str) -> str | None:
        """
        Resolve stable_id to physical PDF path.

        Args:
            stable_id: The stable_id of the file

        Returns:
            Physical file path or None if not found
        """
        try:
            from fastapi_app.lib.dependencies import get_db
            from fastapi_app.lib.file_repository import FileRepository
            from fastapi_app.config import get_settings
            from fastapi_app.lib.hash_utils import get_storage_path

            db = get_db()
            repo = FileRepository(db)
            settings = get_settings()

            file_metadata = repo.get_file_by_stable_id(stable_id)
            if file_metadata and file_metadata.file_type == 'pdf':
                storage_root = settings.data_root / "files"
                file_path = get_storage_path(storage_root, file_metadata.id, 'pdf')
                if file_path.exists():
                    return str(file_path)
                else:
                    logger.warning(f"PDF file not found at path: {file_path}")
            else:
                logger.warning(f"No PDF file found for stable_id: {stable_id}")
        except Exception as e:
            logger.warning(f"Failed to resolve stable_id {stable_id}: {e}")
        return None

    @classmethod
    def is_available(cls) -> bool:
        """Check if KISSKI service is available."""
        return KisskiExtractor.is_available()