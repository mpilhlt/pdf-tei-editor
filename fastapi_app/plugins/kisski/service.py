"""
KISSKI service implementation for structured data extraction.
"""

from typing import Any, Dict, Optional
from fastapi_app.lib.service_registry import ExtractionService, ExtractionParams, ExtractionResult
from .extractor import KisskiExtractor


class KisskiService(ExtractionService):
    """KISSKI service for structured data extraction."""
    
    def __init__(self):
        super().__init__(
            service_id="kisski-extractor",
            service_name="KISSKI Extractor",
            capabilities=["structured-data-extraction"]
        )
        self._extractor = KisskiExtractor()
    
    async def extract(self, **params: ExtractionParams) -> ExtractionResult:
        """
        Extract structured data using KISSKI with full type safety.
        
        Args:
            model: Model ID to use
            prompt: Extraction prompt
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
        if params.get("stable_id"):
            # For now, we'll let the extractor handle the stable_id to path conversion
            # or we can add a method to get the file path from stable_id
            pass
        
        result = await self._extractor.extract(
            model=params["model"],
            prompt=params["prompt"],
            pdf_path=pdf_path,
            text_input=params.get("text_input"),
            json_schema=params.get("json_schema"),
            temperature=params.get("temperature", 0.1),
            max_retries=params.get("max_retries", 2)
        )
        
        # Convert to typed result structure
        return ExtractionResult({
            "success": result.get("success", False),
            "data": result.get("data", {}),
            "model": result.get("model", params["model"]),
            "extractor": result.get("extractor", "kisski-extractor"),
            "retries": result.get("retries", 0)
        })
    
    @classmethod
    def is_available(cls) -> bool:
        """Check if KISSKI service is available."""
        return KisskiExtractor.is_available()