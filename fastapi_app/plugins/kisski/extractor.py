"""
KISSKI API-based text processing extractor.
"""

import base64
import json
import logging
import os
from pathlib import Path
from typing import Any

from fastapi_app.lib.extraction import LLMBaseExtractor, get_retry_session

logger = logging.getLogger(__name__)


class KisskiExtractor(LLMBaseExtractor):
    """
    Extractor that uses the KISSKI API for text processing tasks.
    Supports text and PDF (via image extraction) inputs with JSON output.
    """

    # Cache for model list to avoid repeated API calls
    _models_cache: list[dict[str, Any]] | None = None
    _pdf_support_available: bool | None = None

    @classmethod
    def get_info(cls) -> dict[str, Any]:
        """Return information about this extractor"""
        return {
            "id": "kisski-neural-chat",
            "name": "KISSKI API",
            "description": "Text processing using KISSKI Academic Cloud API",
            "input": ["text", "image"],
            "output": ["text", "json"],
            "requires_api_key": True,
            "api_key_env": "KISSKI_API_KEY",
        }

    @classmethod
    def check_pdf_support(cls) -> bool:
        """Check if PDF support (pdf2image/poppler) is available."""
        if cls._pdf_support_available is not None:
            return cls._pdf_support_available

        try:
            from .cache import check_pdf2image_available

            cls._pdf_support_available = check_pdf2image_available()
        except Exception:
            cls._pdf_support_available = False

        return cls._pdf_support_available

    def _fetch_models_from_api(self) -> list[dict[str, Any]]:
        """Fetch full model list with capabilities from KISSKI API."""
        env_var = self._get_api_key_env_var()
        api_key = os.getenv(env_var)
        if not api_key:
            raise RuntimeError(
                f"API key not available. Please set {env_var} environment variable."
            )

        url = "https://chat-ai.academiccloud.de/v1/models"
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        session = get_retry_session(retries=3, backoff_factor=1.0)
        response = session.get(url, headers=headers, timeout=30)
        response.raise_for_status()

        result = response.json()
        if "data" in result:
            return result["data"]

        raise RuntimeError("Could not retrieve model list from KISSKI API")

    def get_models_with_capabilities(self) -> list[dict[str, Any]]:
        """Return list of models with their capabilities (cached)."""
        if KisskiExtractor._models_cache is None:
            KisskiExtractor._models_cache = self._fetch_models_from_api()
        return KisskiExtractor._models_cache

    def get_models(self) -> list[str]:
        """Return list of available KISSKI model IDs."""
        models = self.get_models_with_capabilities()
        return [m.get("id", "") for m in models if m.get("id")]

    def _get_api_key_env_var(self) -> str:
        """Return the environment variable name for the API key"""
        return "KISSKI_API_KEY"

    def _initialize_client(self, api_key: str) -> Any:
        """Initialize the KISSKI client - just store the API key"""
        return api_key

    def _call_llm(
        self,
        system_prompt: str,
        user_prompt: str,
        model: str | None = None,
        temperature: float = 0.1,
    ) -> str:
        """Call the KISSKI API and return the response text with retry logic."""
        url = "https://chat-ai.academiccloud.de/v1/chat/completions"

        if not model or model == "":
            raise RuntimeError("No model given")

        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.client}",
            "Content-Type": "application/json",
        }

        data = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
        }

        session = get_retry_session(retries=3, backoff_factor=2.0)
        response = session.post(url, headers=headers, json=data, timeout=120)
        response.raise_for_status()

        result = response.json()
        if "choices" in result and len(result["choices"]) > 0:
            return result["choices"][0]["message"]["content"]

        return ""

    def _call_llm_multimodal(
        self,
        system_prompt: str,
        user_content: list[dict[str, Any]],
        model: str,
        temperature: float = 0.1,
    ) -> str:
        """Call the KISSKI API with multimodal content (text + images)."""
        url = "https://chat-ai.academiccloud.de/v1/chat/completions"

        if not model:
            raise RuntimeError("No model given")

        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.client}",
            "Content-Type": "application/json",
        }

        data = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            "temperature": temperature,
        }

        session = get_retry_session(retries=3, backoff_factor=2.0)
        response = session.post(url, headers=headers, json=data, timeout=300)
        response.raise_for_status()

        result = response.json()
        if "choices" in result and len(result["choices"]) > 0:
            return result["choices"][0]["message"]["content"]

        return ""

    def _build_image_content(self, image_paths: list[Path]) -> list[dict[str, Any]]:
        """Build multimodal content list from image paths."""
        content = []
        for img_path in image_paths:
            img_bytes = img_path.read_bytes()
            b64_image = base64.standard_b64encode(img_bytes).decode("utf-8")
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"},
                }
            )
        return content

    def _parse_json_response(self, text: str) -> dict[str, Any] | None:
        """Try to parse JSON from LLM response, handling markdown code blocks."""
        text = text.strip()

        # Try direct parse first
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        # Try extracting from markdown code block
        if "```" in text:
            # Find content between ```json and ``` or just ``` and ```
            import re

            match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
            if match:
                try:
                    return json.loads(match.group(1).strip())
                except json.JSONDecodeError:
                    pass

        return None

    def _validate_against_schema(
        self, data: dict[str, Any], schema: dict[str, Any]
    ) -> list[str]:
        """Validate data against JSON schema, return list of errors."""
        try:
            import jsonschema

            validator = jsonschema.Draft7Validator(schema)
            errors = list(validator.iter_errors(data))
            return [f"{e.json_path}: {e.message}" for e in errors]
        except ImportError:
            logger.warning("jsonschema not installed, skipping validation")
            return []

    def extract(
        self,
        model: str,
        prompt: str,
        pdf_path: str | None = None,
        text_input: str | None = None,
        json_schema: dict[str, Any] | None = None,
        temperature: float = 0.1,
        max_retries: int = 2,
        **kwargs,
    ) -> dict[str, Any]:
        """
        Extract structured JSON data from PDF or text using KISSKI LLM.

        Args:
            model: Model ID to use
            prompt: Extraction prompt/instructions
            pdf_path: Path to PDF file (requires image-capable model)
            text_input: Text input (alternative to pdf_path)
            json_schema: Optional JSON schema for output validation
            temperature: LLM temperature (default 0.1)
            max_retries: Max retries for JSON/schema correction (default 2)

        Returns:
            Dict with 'success', 'data' (parsed JSON), and metadata

        Raises:
            ValueError: If neither pdf_path nor text_input provided, or model
                       doesn't support images when pdf_path is given
            RuntimeError: If API key not set or PDF support unavailable
        """
        # Validate input
        if not pdf_path and not text_input:
            raise ValueError("Either pdf_path or text_input must be provided")

        # Initialize client if needed
        if not self.client:
            api_key = os.getenv(self._get_api_key_env_var())
            if not api_key:
                raise RuntimeError(
                    f"API key not available. Set {self._get_api_key_env_var()}"
                )
            self.client = self._initialize_client(api_key)

        # Build system prompt for JSON output
        system_prompt = (
            "You are an expert data extractor. Always respond with valid JSON only. "
            "Do not include any explanation or markdown formatting, just the JSON object."
        )
        if json_schema:
            system_prompt += (
                f"\n\nThe output must conform to this JSON schema:\n"
                f"{json.dumps(json_schema, indent=2)}"
            )

        # Track temp dir for cleanup
        temp_dir = None
        image_paths: list[Path] = []

        try:
            # Handle PDF input
            if pdf_path:
                if not self.check_pdf_support():
                    raise RuntimeError(
                        "PDF support not available. Install pdf2image and poppler."
                    )

                if not self.model_supports_images(model):
                    raise ValueError(
                        f"Model '{model}' does not support image input. "
                        f"Use a multimodal model for PDF extraction."
                    )

                # Extract images to temp directory
                from .cache import extract_pdf_to_images

                image_paths, temp_dir = extract_pdf_to_images(pdf_path)

                # Build multimodal content
                user_content = [{"type": "text", "text": prompt}]
                user_content.extend(self._build_image_content(image_paths))

                # Call LLM
                response_text = self._call_llm_multimodal(
                    system_prompt, user_content, model, temperature
                )
            else:
                # Text-only input
                user_prompt = f"{prompt}\n\nText to process:\n{text_input}"
                response_text = self._call_llm(
                    system_prompt, user_prompt, model, temperature
                )

            # Parse and validate JSON with retries
            retries = 0
            last_error = None

            while retries <= max_retries:
                parsed = self._parse_json_response(response_text)

                if parsed is None:
                    last_error = "Invalid JSON in response"
                    if retries < max_retries:
                        # Retry with correction prompt
                        correction_prompt = (
                            f"Your previous response was not valid JSON. "
                            f"Please provide only a valid JSON object. "
                            f"Original request: {prompt}"
                        )
                        if pdf_path:
                            user_content = [{"type": "text", "text": correction_prompt}]
                            user_content.extend(self._build_image_content(image_paths))
                            response_text = self._call_llm_multimodal(
                                system_prompt, user_content, model, temperature
                            )
                        else:
                            response_text = self._call_llm(
                                system_prompt,
                                f"{correction_prompt}\n\nText:\n{text_input}",
                                model,
                                temperature,
                            )
                        retries += 1
                        continue
                    break

                # Validate against schema if provided
                if json_schema:
                    errors = self._validate_against_schema(parsed, json_schema)
                    if errors:
                        last_error = f"Schema validation failed: {'; '.join(errors)}"
                        if retries < max_retries:
                            correction_prompt = (
                                f"Your JSON response did not match the required schema. "
                                f"Errors: {'; '.join(errors)}. "
                                f"Please correct and provide valid JSON. "
                                f"Original request: {prompt}"
                            )
                            if pdf_path:
                                user_content = [
                                    {"type": "text", "text": correction_prompt}
                                ]
                                user_content.extend(
                                    self._build_image_content(image_paths)
                                )
                                response_text = self._call_llm_multimodal(
                                    system_prompt, user_content, model, temperature
                                )
                            else:
                                response_text = self._call_llm(
                                    system_prompt,
                                    f"{correction_prompt}\n\nText:\n{text_input}",
                                    model,
                                    temperature,
                                )
                            retries += 1
                            continue
                        break

                # Success
                return {
                    "success": True,
                    "data": parsed,
                    "model": model,
                    "extractor": self.get_info()["id"],
                    "retries": retries,
                }

            # Failed after retries
            return {
                "success": False,
                "error": last_error,
                "raw_response": response_text,
                "model": model,
                "extractor": self.get_info()["id"],
                "retries": retries,
            }

        finally:
            # Clean up temp directory
            if temp_dir:
                from .cache import cleanup_temp_dir

                cleanup_temp_dir(temp_dir)
