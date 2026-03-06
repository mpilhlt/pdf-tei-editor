"""
Tests for XML entity encoding configuration.

Verifies that apply_entity_encoding_from_config() respects
xml.encode-entities.server and xml.encode-quotes configuration options.
"""

import unittest
from unittest.mock import patch

from fastapi_app.lib.utils.xml_utils import apply_entity_encoding_from_config


class TestEntityEncodingConfiguration(unittest.TestCase):
    """Test XML entity encoding configuration behavior."""

    @patch('fastapi_app.lib.utils.config_utils.get_config')
    def test_entity_encoding_disabled(self, mock_get_config):
        """Test that entity encoding can be disabled."""
        # Mock config to return False for server encoding
        mock_config = mock_get_config.return_value
        mock_config.get.side_effect = lambda key, default=None: {
            "xml.encode-entities.server": False,
            "xml.encode-quotes": False
        }.get(key, default)

        xml_input = '<p>Test with "quotes" and \'apostrophes\' and &amp;</p>'

        result = apply_entity_encoding_from_config(xml_input)

        # Encoding disabled - input should be unchanged
        self.assertEqual(result, xml_input)

    @patch('fastapi_app.lib.utils.config_utils.get_config')
    def test_entity_encoding_with_server_encoding_enabled(self, mock_get_config):
        """Test entity encoding when xml.encode-entities.server is enabled."""
        # Mock config to enable server encoding but not quotes
        mock_config = mock_get_config.return_value
        mock_config.get.side_effect = lambda key, default=None: {
            "xml.encode-entities.server": True,
            "xml.encode-quotes": False
        }.get(key, default)

        # Input with characters that need encoding in text content
        xml_input = '<p>Test with &lt; and &gt; and &amp; already encoded</p>'

        result = apply_entity_encoding_from_config(xml_input)

        # Already-encoded entities should remain encoded
        self.assertIn('&lt;', result)
        self.assertIn('&gt;', result)
        self.assertIn('&amp;', result)

        # But quotes should NOT be encoded (encode_quotes=False)
        xml_with_quotes = '<p>Test with "quotes"</p>'
        result_quotes = apply_entity_encoding_from_config(xml_with_quotes)
        self.assertIn('"quotes"', result_quotes)
        self.assertNotIn('&quot;', result_quotes)

    @patch('fastapi_app.lib.utils.config_utils.get_config')
    def test_entity_encoding_with_quotes_enabled(self, mock_get_config):
        """Test entity encoding with both server encoding and quote encoding enabled."""
        # Mock config to enable both options
        mock_config = mock_get_config.return_value
        mock_config.get.side_effect = lambda key, default=None: {
            "xml.encode-entities.server": True,
            "xml.encode-quotes": True
        }.get(key, default)

        xml_input = '<p>He said "hello" and she replied \'hi\'</p>'

        result = apply_entity_encoding_from_config(xml_input)

        # Quotes and apostrophes should be encoded
        self.assertIn('&quot;', result)
        self.assertIn('&apos;', result)

        # Unencoded quotes should NOT appear in text content
        self.assertNotIn('"hello"', result)
        self.assertNotIn("'hi'", result)


if __name__ == '__main__':
    unittest.main()
