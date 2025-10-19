"""
Extractor discovery and management system
"""

import os
import importlib
import inspect
from typing import Dict, List, Any, Type
from pathlib import Path

from . import BaseExtractor


class ExtractorRegistry:
    """Registry for managing extraction engines."""
    
    def __init__(self):
        self._extractors: Dict[str, Type[BaseExtractor]] = {}
        self._discover_extractors()
    
    def _discover_extractors(self):
        """Automatically discover extractor classes in the extractors directory."""
        extractors_dir = Path(__file__).parent
        
        # Find all Python files in the extractors directory
        for py_file in extractors_dir.glob("*_extractor.py"):
            module_name = py_file.stem
            try:
                # Import the module
                module = importlib.import_module(f"fastapi_app.extractors.{module_name}")
                
                # Find extractor classes in the module
                for name, obj in inspect.getmembers(module, inspect.isclass):
                    # Check if it's a BaseExtractor subclass (but not BaseExtractor itself or LLMBaseExtractor)
                    if (issubclass(obj, BaseExtractor) and 
                        obj is not BaseExtractor and 
                        obj.__name__ != 'LLMBaseExtractor' and
                        hasattr(obj, 'get_info') and
                        not getattr(obj, '__abstractmethods__', None)):
                        
                        try:
                            extractor_info = obj.get_info()
                            if extractor_info is None:
                                print(f"Warning: {obj.__name__}.get_info() returned None")
                                continue
                            extractor_id = extractor_info.get('id')
                        except Exception as e:
                            print(f"Warning: Error calling {obj.__name__}.get_info(): {e}")
                            continue
                        
                        if extractor_id:
                            self._extractors[extractor_id] = obj
                            print(f"Discovered extractor: {extractor_id} ({obj.__name__})")
                        
            except Exception as e:
                print(f"Warning: Could not load extractor from {py_file}: {e}")
    
    def list_extractors(self, input_filter: List[str] = None, output_filter: List[str] = None,
                       available_only: bool = True) -> List[Dict[str, Any]]:
        """
        List available extractors with optional filtering.
        
        Args:
            input_filter: Only include extractors that support these input types
            output_filter: Only include extractors that support these output types
            available_only: Only include extractors that are currently available
            
        Returns:
            List of extractor info dictionaries
        """
        extractors = []
        
        for extractor_id, extractor_class in self._extractors.items():
            # Check availability if requested
            if available_only and not extractor_class.is_available():
                continue
            
            try:
                extractor_info = extractor_class.get_info()
                if extractor_info is None:
                    print(f"Warning: {extractor_class.__name__}.get_info() returned None in list_extractors")
                    continue
            except Exception as e:
                print(f"Warning: Error calling {extractor_class.__name__}.get_info() in list_extractors: {e}")
                continue
            
            # Apply input filter
            if input_filter:
                if not any(inp in extractor_info.get('input', []) for inp in input_filter):
                    continue
            
            # Apply output filter
            if output_filter:
                if not any(out in extractor_info.get('output', []) for out in output_filter):
                    continue
            
            extractors.append(extractor_info)
        
        return extractors
    
    def get_extractor(self, extractor_id: str) -> Type[BaseExtractor]:
        """
        Get an extractor class by ID.
        
        Args:
            extractor_id: The ID of the extractor
            
        Returns:
            The extractor class
            
        Raises:
            KeyError: If extractor is not found
            RuntimeError: If extractor is not available
        """
        if extractor_id not in self._extractors:
            raise KeyError(f"Extractor '{extractor_id}' not found")
        
        extractor_class = self._extractors[extractor_id]
        
        if not extractor_class.is_available():
            raise RuntimeError(f"Extractor '{extractor_id}' is not available")
        
        return extractor_class
    
    def create_extractor(self, extractor_id: str) -> BaseExtractor:
        """
        Create an instance of an extractor.
        
        Args:
            extractor_id: The ID of the extractor
            
        Returns:
            An instance of the extractor
        """
        extractor_class = self.get_extractor(extractor_id)
        return extractor_class()


# Global registry instance
registry = ExtractorRegistry()


def list_extractors(**kwargs) -> List[Dict[str, Any]]:
    """Convenience function to list extractors."""
    return registry.list_extractors(**kwargs)


def get_extractor(extractor_id: str) -> Type[BaseExtractor]:
    """Convenience function to get an extractor class."""
    return registry.get_extractor(extractor_id)


def create_extractor(extractor_id: str) -> BaseExtractor:
    """Convenience function to create an extractor instance."""
    return registry.create_extractor(extractor_id)