"""
Unit tests for KISSKI extractor with mocked inference endpoint.

Tests JSON parsing retries and schema validation retries.

@testCovers fastapi_app/plugins/kisski/extractor.py
"""

import unittest
from unittest.mock import MagicMock, patch


class TestKisskiExtractorRetries(unittest.TestCase):
    """Test retry behavior for invalid JSON and schema validation failures."""

    def setUp(self):
        """Set up test fixtures."""
        # Mock environment variable
        self.env_patcher = patch.dict(
            "os.environ", {"KISSKI_API_KEY": "test-api-key"}
        )
        self.env_patcher.start()

        # Mock the models cache to include a multimodal model
        self.models_cache = [
            {
                "id": "test-multimodal-model",
                "name": "Test Model",
                "input": ["text", "image"],
                "output": ["text"],
            },
            {
                "id": "test-text-model",
                "name": "Test Text Model",
                "input": ["text"],
                "output": ["text"],
            },
        ]

    def tearDown(self):
        """Clean up patches."""
        self.env_patcher.stop()
        # Reset the models cache
        from fastapi_app.plugins.kisski.extractor import KisskiExtractor

        KisskiExtractor._models_cache = None

    def _create_extractor_with_mock(self, responses: list[str]):
        """
        Create an extractor with mocked LLM responses.

        Args:
            responses: List of response strings to return in sequence
        """
        from fastapi_app.plugins.kisski.extractor import KisskiExtractor

        extractor = KisskiExtractor()
        extractor.client = "test-api-key"

        # Set up models cache
        KisskiExtractor._models_cache = self.models_cache

        # Create a mock that returns responses in sequence
        self.response_index = 0

        def mock_call_llm(system_prompt, user_prompt, model=None, temperature=0.1):
            response = responses[self.response_index]
            self.response_index = min(self.response_index + 1, len(responses) - 1)
            return response

        extractor._call_llm = MagicMock(side_effect=mock_call_llm)

        return extractor

    def test_valid_json_first_attempt(self):
        """Test successful extraction on first attempt with valid JSON."""
        extractor = self._create_extractor_with_mock(
            ['{"title": "Test Article", "year": "2024"}']
        )

        result = extractor.extract(
            model="test-text-model",
            prompt="Extract title and year",
            text_input="Some article text",
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["title"], "Test Article")
        self.assertEqual(result["data"]["year"], "2024")
        self.assertEqual(result["retries"], 0)
        self.assertEqual(extractor._call_llm.call_count, 1)

    def test_invalid_json_retry_success(self):
        """Test retry when first response is invalid JSON, second is valid."""
        extractor = self._create_extractor_with_mock(
            [
                "This is not valid JSON at all",
                '{"title": "Test Article", "year": "2024"}',
            ]
        )

        result = extractor.extract(
            model="test-text-model",
            prompt="Extract title and year",
            text_input="Some article text",
            max_retries=2,
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["title"], "Test Article")
        self.assertEqual(result["retries"], 1)
        self.assertEqual(extractor._call_llm.call_count, 2)

    def test_invalid_json_retry_with_markdown(self):
        """Test retry when response contains JSON in markdown code block."""
        extractor = self._create_extractor_with_mock(
            ['```json\n{"title": "Test Article", "year": "2024"}\n```']
        )

        result = extractor.extract(
            model="test-text-model",
            prompt="Extract title and year",
            text_input="Some article text",
        )

        # Should successfully parse JSON from markdown block
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["title"], "Test Article")
        self.assertEqual(result["retries"], 0)

    def test_invalid_json_max_retries_exceeded(self):
        """Test failure when all retries return invalid JSON."""
        extractor = self._create_extractor_with_mock(
            [
                "Not JSON 1",
                "Not JSON 2",
                "Not JSON 3",
            ]
        )

        result = extractor.extract(
            model="test-text-model",
            prompt="Extract title and year",
            text_input="Some article text",
            max_retries=2,
        )

        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "Invalid JSON in response")
        self.assertEqual(result["raw_response"], "Not JSON 3")
        self.assertEqual(result["retries"], 2)
        # Initial call + 2 retries = 3 calls
        self.assertEqual(extractor._call_llm.call_count, 3)

    def test_schema_validation_retry_success(self):
        """Test retry when first response doesn't match schema, second does."""
        extractor = self._create_extractor_with_mock(
            [
                '{"title": "Test"}',  # Missing required 'year' field
                '{"title": "Test Article", "year": "2024"}',
            ]
        )

        schema = {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "year": {"type": "string"},
            },
            "required": ["title", "year"],
        }

        result = extractor.extract(
            model="test-text-model",
            prompt="Extract title and year",
            text_input="Some article text",
            json_schema=schema,
            max_retries=2,
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["title"], "Test Article")
        self.assertEqual(result["data"]["year"], "2024")
        self.assertEqual(result["retries"], 1)

    def test_schema_validation_wrong_type_retry(self):
        """Test retry when field has wrong type according to schema."""
        extractor = self._create_extractor_with_mock(
            [
                '{"title": "Test", "year": 2024}',  # year should be string
                '{"title": "Test Article", "year": "2024"}',
            ]
        )

        schema = {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "year": {"type": "string"},
            },
            "required": ["title", "year"],
        }

        result = extractor.extract(
            model="test-text-model",
            prompt="Extract title and year",
            text_input="Some article text",
            json_schema=schema,
            max_retries=2,
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["year"], "2024")
        self.assertEqual(result["retries"], 1)

    def test_schema_validation_max_retries_exceeded(self):
        """Test failure when all retries fail schema validation."""
        extractor = self._create_extractor_with_mock(
            [
                '{"title": "Test"}',  # Missing year
                '{"year": "2024"}',  # Missing title
                '{"other": "field"}',  # Missing both
            ]
        )

        schema = {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "year": {"type": "string"},
            },
            "required": ["title", "year"],
        }

        result = extractor.extract(
            model="test-text-model",
            prompt="Extract title and year",
            text_input="Some article text",
            json_schema=schema,
            max_retries=2,
        )

        self.assertFalse(result["success"])
        self.assertIn("Schema validation failed", result["error"])
        self.assertEqual(result["retries"], 2)

    def test_correction_prompt_includes_original_request(self):
        """Test that retry prompt includes original request context."""
        extractor = self._create_extractor_with_mock(
            [
                "Invalid JSON",
                '{"title": "Test", "year": "2024"}',
            ]
        )

        result = extractor.extract(
            model="test-text-model",
            prompt="Extract the article title and publication year",
            text_input="Some article text",
            max_retries=1,
        )

        # Check that second call included correction context
        second_call_args = extractor._call_llm.call_args_list[1]
        user_prompt = second_call_args[0][1]  # Second positional arg

        self.assertIn("not valid JSON", user_prompt)
        self.assertIn("Original request", user_prompt)
        self.assertIn("Extract the article title", user_prompt)

    def test_schema_error_included_in_correction_prompt(self):
        """Test that schema validation errors are included in retry prompt."""
        call_prompts = []

        def capture_calls(system_prompt, user_prompt, model=None, temperature=0.1):
            call_prompts.append(user_prompt)
            if len(call_prompts) == 1:
                return '{"title": "Test"}'  # Missing year
            return '{"title": "Test", "year": "2024"}'

        from fastapi_app.plugins.kisski.extractor import KisskiExtractor

        extractor = KisskiExtractor()
        extractor.client = "test-api-key"
        KisskiExtractor._models_cache = self.models_cache
        extractor._call_llm = MagicMock(side_effect=capture_calls)

        schema = {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "year": {"type": "string"},
            },
            "required": ["title", "year"],
        }

        result = extractor.extract(
            model="test-text-model",
            prompt="Extract metadata",
            text_input="Some text",
            json_schema=schema,
            max_retries=1,
        )

        self.assertTrue(result["success"])
        # Check that second prompt mentions the schema error
        self.assertIn("'year' is a required property", call_prompts[1])

    def test_no_retries_when_max_retries_zero(self):
        """Test that no retries occur when max_retries is 0."""
        extractor = self._create_extractor_with_mock(
            [
                "Invalid JSON",
                '{"title": "Test"}',  # Would succeed but shouldn't be called
            ]
        )

        result = extractor.extract(
            model="test-text-model",
            prompt="Extract title",
            text_input="Some text",
            max_retries=0,
        )

        self.assertFalse(result["success"])
        self.assertEqual(result["retries"], 0)
        self.assertEqual(extractor._call_llm.call_count, 1)

    def test_valid_json_no_schema_validation(self):
        """Test that valid JSON passes without schema when none provided."""
        extractor = self._create_extractor_with_mock(
            ['{"any": "structure", "is": ["valid"]}']
        )

        result = extractor.extract(
            model="test-text-model",
            prompt="Extract data",
            text_input="Some text",
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["any"], "structure")
        self.assertEqual(result["retries"], 0)


class TestKisskiExtractorPdfRetries(unittest.TestCase):
    """Test retry behavior for PDF extraction with multimodal calls."""

    def setUp(self):
        """Set up test fixtures."""
        self.env_patcher = patch.dict(
            "os.environ", {"KISSKI_API_KEY": "test-api-key"}
        )
        self.env_patcher.start()

        self.models_cache = [
            {
                "id": "test-multimodal-model",
                "name": "Test Multimodal",
                "input": ["text", "image"],
                "output": ["text"],
            },
        ]

    def tearDown(self):
        """Clean up patches."""
        self.env_patcher.stop()
        from fastapi_app.plugins.kisski.extractor import KisskiExtractor

        KisskiExtractor._models_cache = None
        KisskiExtractor._pdf_support_available = None

    @patch("fastapi_app.plugins.kisski.extractor.KisskiExtractor.check_pdf_support")
    @patch("fastapi_app.plugins.kisski.cache.extract_pdf_to_images")
    @patch("fastapi_app.plugins.kisski.cache.cleanup_temp_dir")
    def test_pdf_extraction_retry_on_invalid_json(
        self, mock_cleanup, mock_extract_images, mock_pdf_support
    ):
        """Test PDF extraction retries when JSON is invalid."""
        from pathlib import Path
        import tempfile

        from fastapi_app.plugins.kisski.extractor import KisskiExtractor

        # Set up mocks
        mock_pdf_support.return_value = True

        temp_dir = Path(tempfile.mkdtemp())
        mock_image = temp_dir / "page_0000.jpg"
        mock_image.write_bytes(b"fake image data")
        mock_extract_images.return_value = ([mock_image], temp_dir)

        extractor = KisskiExtractor()
        extractor.client = "test-api-key"
        KisskiExtractor._models_cache = self.models_cache

        # Track multimodal calls
        call_count = [0]

        def mock_multimodal(system_prompt, user_content, model, temperature):
            call_count[0] += 1
            if call_count[0] == 1:
                return "Not valid JSON"
            return '{"title": "PDF Article", "year": "2024"}'

        extractor._call_llm_multimodal = MagicMock(side_effect=mock_multimodal)
        extractor._build_image_content = MagicMock(
            return_value=[{"type": "image_url", "image_url": {"url": "data:..."}}]
        )

        result = extractor.extract(
            model="test-multimodal-model",
            prompt="Extract from PDF",
            pdf_path="/fake/path.pdf",
            max_retries=2,
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["title"], "PDF Article")
        self.assertEqual(result["retries"], 1)
        self.assertEqual(call_count[0], 2)

        # Verify cleanup was called
        mock_cleanup.assert_called_once_with(temp_dir)

    @patch("fastapi_app.plugins.kisski.extractor.KisskiExtractor.check_pdf_support")
    @patch("fastapi_app.plugins.kisski.cache.extract_pdf_to_images")
    @patch("fastapi_app.plugins.kisski.cache.cleanup_temp_dir")
    def test_pdf_extraction_cleanup_on_failure(
        self, mock_cleanup, mock_extract_images, mock_pdf_support
    ):
        """Test that temp directory is cleaned up even on extraction failure."""
        from pathlib import Path
        import tempfile

        from fastapi_app.plugins.kisski.extractor import KisskiExtractor

        mock_pdf_support.return_value = True

        temp_dir = Path(tempfile.mkdtemp())
        mock_image = temp_dir / "page_0000.jpg"
        mock_image.write_bytes(b"fake image data")
        mock_extract_images.return_value = ([mock_image], temp_dir)

        extractor = KisskiExtractor()
        extractor.client = "test-api-key"
        KisskiExtractor._models_cache = self.models_cache

        # Always return invalid JSON
        extractor._call_llm_multimodal = MagicMock(return_value="Invalid JSON always")
        extractor._build_image_content = MagicMock(return_value=[])

        result = extractor.extract(
            model="test-multimodal-model",
            prompt="Extract from PDF",
            pdf_path="/fake/path.pdf",
            max_retries=1,
        )

        self.assertFalse(result["success"])
        # Cleanup should still be called
        mock_cleanup.assert_called_once_with(temp_dir)


class TestKisskiExtractorJsonParsing(unittest.TestCase):
    """Test JSON parsing from various response formats."""

    def test_parse_plain_json(self):
        """Test parsing plain JSON response."""
        from fastapi_app.plugins.kisski.extractor import KisskiExtractor

        extractor = KisskiExtractor()

        result = extractor._parse_json_response('{"key": "value"}')

        self.assertEqual(result, {"key": "value"})

    def test_parse_json_with_whitespace(self):
        """Test parsing JSON with leading/trailing whitespace."""
        from fastapi_app.plugins.kisski.extractor import KisskiExtractor

        extractor = KisskiExtractor()

        result = extractor._parse_json_response('  \n{"key": "value"}\n  ')

        self.assertEqual(result, {"key": "value"})

    def test_parse_json_in_markdown_code_block(self):
        """Test parsing JSON from markdown code block."""
        from fastapi_app.plugins.kisski.extractor import KisskiExtractor

        extractor = KisskiExtractor()

        result = extractor._parse_json_response(
            '```json\n{"key": "value"}\n```'
        )

        self.assertEqual(result, {"key": "value"})

    def test_parse_json_in_plain_code_block(self):
        """Test parsing JSON from plain code block without language."""
        from fastapi_app.plugins.kisski.extractor import KisskiExtractor

        extractor = KisskiExtractor()

        result = extractor._parse_json_response('```\n{"key": "value"}\n```')

        self.assertEqual(result, {"key": "value"})

    def test_parse_invalid_json_returns_none(self):
        """Test that invalid JSON returns None."""
        from fastapi_app.plugins.kisski.extractor import KisskiExtractor

        extractor = KisskiExtractor()

        result = extractor._parse_json_response("This is not JSON")

        self.assertIsNone(result)

    def test_parse_json_with_text_before_code_block(self):
        """Test parsing when there's text before the code block."""
        from fastapi_app.plugins.kisski.extractor import KisskiExtractor

        extractor = KisskiExtractor()

        result = extractor._parse_json_response(
            'Here is the extracted data:\n```json\n{"key": "value"}\n```'
        )

        self.assertEqual(result, {"key": "value"})


if __name__ == "__main__":
    unittest.main()
