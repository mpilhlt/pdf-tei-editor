import os
import json
from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional
from . import BaseExtractor


class LLMBaseExtractor(BaseExtractor, ABC):
    """
    Abstract base class for LLM-based extractors.
    Generic text-to-text/json extractors for annotation tasks.
    """
    
    def __init__(self):
        self.client = None
        self._api_key = None
    
    @classmethod
    @abstractmethod
    def get_info(cls) -> Dict[str, Any]:
        """Return information about this extractor - must be implemented by subclasses"""
        pass
    
    @abstractmethod
    def get_models(self) -> List[str]:
        """Return list of available models for this extractor"""
        pass
    
    @abstractmethod
    def _get_api_key_env_var(self) -> str:
        """Return the environment variable name for the API key"""
        pass
    
    @abstractmethod
    def _initialize_client(self, api_key: str) -> Any:
        """Initialize the LLM client with the API key"""
        pass
    
    @abstractmethod
    def _call_llm(self, system_prompt: str, user_prompt: str, model: str = None, temperature: float = 0.1) -> str:
        """Call the LLM API and return the response text"""
        pass
    
    @classmethod
    def is_available(cls) -> bool:
        """Check if the extractor is available (API key configured)"""
        # Create a temporary instance to check availability
        try:
            instance = cls()
            env_var = instance._get_api_key_env_var()
            api_key = os.getenv(env_var)
            if not api_key:
                return False
            instance.client = instance._initialize_client(api_key)
            return True
        except Exception:
            return False
    
    def _get_system_prompt(self, extractor_id: str) -> str:
        return "You are an expert for metadata extraction from documents"
    
    def _get_user_prompt(self, instructions: str, text_input: str) -> str:
        """Create user prompt from instructions and text input"""
        return f"Instructions: {instructions}\n\nText to process:\n{text_input}"
    
    def extract(self, instructions: str = "", text_input: str = "", model: str = None, **kwargs) -> Dict[str, Any]:
        """
        Extract information from text using LLM API
        
        Args:
            instructions: instructions for the prompt
            text_input: text input to process
            model: specific model to use (optional)
            **kwargs: Additional parameters
        
        Returns:
            Dictionary containing extraction results
        """
        if not self.is_available():
            env_var = self._get_api_key_env_var()
            raise RuntimeError(f"LLM API is not available. Please set {env_var} environment variable.")
        
        if not text_input:
            raise ValueError("text_input is required")

        try:
            # Get system prompt 
            system_prompt = self._get_system_prompt(self.get_info()['id'])
            
            # Create user prompt
            user_prompt = self._get_user_prompt(instructions, text_input)
            
            # Call LLM API with optional model specification
            result_text = self._call_llm(system_prompt, user_prompt, model)
            
            return {
                'success': True,
                'content': result_text,
                'extractor': self.get_info()['id'],
                'model': model
            }
            
        except Exception as e:
            return {
                'success': False,
                'error': str(e),
                'extractor': self.get_info()['id']
            }