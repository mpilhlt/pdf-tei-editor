"""
Tests for the ExtractorRegistry.
"""

import unittest
from typing import Dict, Any, Optional

from fastapi_app.lib.extraction import (
    BaseExtractor,
    ExtractorRegistry,
    list_extractors,
    get_extractor,
    create_extractor
)


class MockTestExtractor(BaseExtractor):
    """Mock extractor for testing."""

    @classmethod
    def get_info(cls) -> Dict[str, Any]:
        return {
            "id": "mock-test",
            "name": "Mock Test Extractor",
            "description": "Test extractor for unit tests",
            "input": ["pdf"],
            "output": ["tei-document"],
            "options": {}
        }

    @classmethod
    def is_available(cls) -> bool:
        return True

    def extract(self, pdf_path: Optional[str] = None, xml_content: Optional[str] = None,
                options: Dict[str, Any] = None) -> str:
        return "<TEI>mock result</TEI>"


class UnavailableExtractor(BaseExtractor):
    """Mock extractor that is not available."""

    @classmethod
    def get_info(cls) -> Dict[str, Any]:
        return {
            "id": "unavailable-test",
            "name": "Unavailable Extractor",
            "description": "Test extractor that is unavailable",
            "input": ["xml"],
            "output": ["tei-document"],
            "options": {}
        }

    @classmethod
    def is_available(cls) -> bool:
        return False

    def extract(self, pdf_path: Optional[str] = None, xml_content: Optional[str] = None,
                options: Dict[str, Any] = None) -> str:
        raise RuntimeError("This extractor is not available")


class TestExtractorRegistry(unittest.TestCase):
    """Tests for ExtractorRegistry."""

    def setUp(self):
        """Reset registry before each test."""
        ExtractorRegistry.reset_instance()
        self.registry = ExtractorRegistry.get_instance()

    def tearDown(self):
        """Clean up after each test."""
        ExtractorRegistry.reset_instance()

    def test_singleton_instance(self):
        """Test that get_instance returns same instance."""
        instance1 = ExtractorRegistry.get_instance()
        instance2 = ExtractorRegistry.get_instance()
        self.assertIs(instance1, instance2)

    def test_reset_instance(self):
        """Test that reset_instance creates new instance."""
        instance1 = ExtractorRegistry.get_instance()
        ExtractorRegistry.reset_instance()
        instance2 = ExtractorRegistry.get_instance()
        self.assertIsNot(instance1, instance2)

    def test_register_extractor(self):
        """Test registering an extractor."""
        self.registry.register(MockTestExtractor)

        extractors = self.registry.list_extractors()
        self.assertEqual(len(extractors), 1)
        self.assertEqual(extractors[0]['id'], 'mock-test')

    def test_unregister_extractor(self):
        """Test unregistering an extractor."""
        self.registry.register(MockTestExtractor)
        self.registry.unregister('mock-test')

        extractors = self.registry.list_extractors()
        self.assertEqual(len(extractors), 0)

    def test_get_extractor(self):
        """Test getting an extractor class."""
        self.registry.register(MockTestExtractor)

        extractor_class = self.registry.get_extractor('mock-test')
        self.assertIs(extractor_class, MockTestExtractor)

    def test_get_extractor_not_found(self):
        """Test getting a non-existent extractor."""
        with self.assertRaises(KeyError) as context:
            self.registry.get_extractor('nonexistent')
        self.assertIn('not found', str(context.exception))

    def test_get_extractor_not_available(self):
        """Test getting an unavailable extractor."""
        self.registry.register(UnavailableExtractor)

        with self.assertRaises(RuntimeError) as context:
            self.registry.get_extractor('unavailable-test')
        self.assertIn('not available', str(context.exception))

    def test_create_extractor(self):
        """Test creating an extractor instance."""
        self.registry.register(MockTestExtractor)

        extractor = self.registry.create_extractor('mock-test')
        self.assertIsInstance(extractor, MockTestExtractor)

    def test_list_extractors_available_only(self):
        """Test listing only available extractors."""
        self.registry.register(MockTestExtractor)
        self.registry.register(UnavailableExtractor)

        # Default: available_only=True
        extractors = self.registry.list_extractors()
        self.assertEqual(len(extractors), 1)
        self.assertEqual(extractors[0]['id'], 'mock-test')

        # available_only=False
        extractors = self.registry.list_extractors(available_only=False)
        self.assertEqual(len(extractors), 2)

    def test_list_extractors_input_filter(self):
        """Test filtering extractors by input type."""
        self.registry.register(MockTestExtractor)  # input: ["pdf"]
        self.registry.register(UnavailableExtractor)  # input: ["xml"]

        # Filter by pdf input (available_only=False to include UnavailableExtractor)
        extractors = self.registry.list_extractors(input_filter=["pdf"], available_only=False)
        self.assertEqual(len(extractors), 1)
        self.assertEqual(extractors[0]['id'], 'mock-test')

        # Filter by xml input
        extractors = self.registry.list_extractors(input_filter=["xml"], available_only=False)
        self.assertEqual(len(extractors), 1)
        self.assertEqual(extractors[0]['id'], 'unavailable-test')


class TestConvenienceFunctions(unittest.TestCase):
    """Tests for module-level convenience functions."""

    def setUp(self):
        """Reset registry before each test."""
        ExtractorRegistry.reset_instance()
        registry = ExtractorRegistry.get_instance()
        registry.register(MockTestExtractor)

    def tearDown(self):
        """Clean up after each test."""
        ExtractorRegistry.reset_instance()

    def test_list_extractors_function(self):
        """Test list_extractors convenience function."""
        extractors = list_extractors()
        self.assertEqual(len(extractors), 1)

    def test_get_extractor_function(self):
        """Test get_extractor convenience function."""
        extractor_class = get_extractor('mock-test')
        self.assertIs(extractor_class, MockTestExtractor)

    def test_create_extractor_function(self):
        """Test create_extractor convenience function."""
        extractor = create_extractor('mock-test')
        self.assertIsInstance(extractor, MockTestExtractor)


if __name__ == '__main__':
    unittest.main()
