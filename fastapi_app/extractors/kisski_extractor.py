import os
from typing import Dict, Any, List
import json
from .llm_base_extractor import LLMBaseExtractor
from .http_utils import get_retry_session

class KisskiExtractor(LLMBaseExtractor):
    """
    Extractor that uses the KISSKI API for text processing tasks.
    """
    
    @classmethod
    def get_info(cls) -> Dict[str, Any]:
        """Return information about this extractor"""
        return {
            "id": "kisski-neural-chat",
            "name": "KISSKI API",
            "description": "Text processing using KISSKI Academic Cloud API",
            "input": ["text"],
            "output": ["text"],
            "requires_api_key": True,
            "api_key_env": "KISSKI_API_KEY"
        }
    
    def get_models(self) -> List[str]:
        """Return list of available KISSKI models from API with retry logic"""
        # Ensure we have access to the API
        env_var = self._get_api_key_env_var()
        api_key = os.getenv(env_var)
        if not api_key:
            raise RuntimeError(f"API key not available. Please set {env_var} environment variable.")

        url = "https://chat-ai.academiccloud.de/v1/models"
        headers = {
            'Accept': 'application/json',
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        }

        session = get_retry_session(retries=3, backoff_factor=1.0)
        response = session.post(url, headers=headers, timeout=30)
        response.raise_for_status()

        result = response.json()

        # Extract model IDs from the response
        if 'data' in result:
            models = [model.get('id', '') for model in result['data'] if model.get('id')]
            if models:
                return models

        raise RuntimeError("Could not retrieve model list from KISSKI API")
    
    def _get_api_key_env_var(self) -> str:
        """Return the environment variable name for the API key"""
        return "KISSKI_API_KEY"
    
    def _initialize_client(self, api_key: str) -> Any:
        """Initialize the KISSKI client - just store the API key"""
        return api_key
    
    def _call_llm(self, system_prompt: str, user_prompt: str, model: str = None, temperature: float = 0.1) -> str:
        """Call the KISSKI API and return the response text with retry logic"""
        url = "https://chat-ai.academiccloud.de/v1/chat/completions"

        # Use specified model or default
        if not model or model == "":
            raise RuntimeError("No model given")

        headers = {
            'Accept': 'application/json',
            'Authorization': f'Bearer {self.client}',
            'Content-Type': 'application/json'
        }

        data = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "temperature": temperature
        }

        session = get_retry_session(retries=3, backoff_factor=2.0)
        response = session.post(url, headers=headers, json=data, timeout=120)
        response.raise_for_status()

        result = response.json()
        if 'choices' in result and len(result['choices']) > 0:
            return result['choices'][0]['message']['content']

        return ""