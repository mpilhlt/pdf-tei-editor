"""
Unit tests for DOI utilities.

Tests:
- Filename encoding/decoding
- Legacy format compatibility
- Round-trip encoding
- Edge cases and error handling

@testCovers fastapi_app/lib/utils/doi_utils.py
"""

import unittest

from fastapi_app.lib.utils.doi_utils import (
    encode_filename,
    decode_filename,
    encode_for_xml_id,
    decode_from_xml_id,
    validate_doi,
    normalize_doi
)


class TestFilenameEncoding(unittest.TestCase):
    """Test filename encoding and decoding functions."""

    def test_encode_doi_with_slash(self):
        """Test encoding DOI with forward slash."""
        doi = "10.1111/1467-6478.00040"
        encoded = encode_filename(doi)
        self.assertEqual(encoded, "10.1111__1467-6478.00040")

    def test_encode_doi_with_multiple_slashes(self):
        """Test encoding DOI with multiple forward slashes."""
        doi = "10.1234/path/to/file"
        encoded = encode_filename(doi)
        self.assertEqual(encoded, "10.1234__path__to__file")

    def test_encode_special_chars(self):
        """Test encoding various special characters."""
        test_cases = [
            ("test:file", "test_x3A_file"),
            ("test<file>", "test_x3C_file_x3E_"),
            ('test"file"', "test_x22_file_x22_"),
            ("test*file", "test_x2A_file"),
            ("test?file", "test_x3F_file"),
            ("test|file", "test_x7C_file"),
            ("test\\file", "test_x5C_file"),
        ]

        for original, expected in test_cases:
            with self.subTest(original=original):
                encoded = encode_filename(original)
                self.assertEqual(encoded, expected)

    def test_encode_dollar_sign_not_escaped(self):
        """Dollar sign is no longer an escape character, passes through unchanged."""
        doc_id = "file$name"
        encoded = encode_filename(doc_id)
        self.assertEqual(encoded, "file$name")

    def test_encode_combined_special_chars(self):
        """Test encoding with multiple special characters."""
        doi = "10.1234/test:file<name>"
        encoded = encode_filename(doi)
        self.assertEqual(encoded, "10.1234__test_x3A_file_x3C_name_x3E_")

    def test_encode_empty_raises_error(self):
        """Test that encoding empty string raises ValueError."""
        with self.assertRaises(ValueError) as cm:
            encode_filename("")
        self.assertIn("cannot be empty", str(cm.exception))

    def test_decode_doi_with_slash(self):
        """Test decoding DOI with encoded forward slash."""
        encoded = "10.1111__1467-6478.00040"
        decoded = decode_filename(encoded)
        self.assertEqual(decoded, "10.1111/1467-6478.00040")

    def test_decode_new_encoding(self):
        """Test decoding current _xXX_ encoded filenames."""
        test_cases = [
            ("test_x3A_file", "test:file"),
            ("test_x3C_file_x3E_", "test<file>"),
            ("test_x22_file_x22_", 'test"file"'),
            ("test_x2A_file", "test*file"),
            ("test_x3F_file", "test?file"),
            ("test_x7C_file", "test|file"),
            ("test_x5C_file", "test\\file"),
        ]
        for encoded, expected in test_cases:
            with self.subTest(encoded=encoded):
                self.assertEqual(decode_filename(encoded), expected)

    def test_decode_legacy_dollar_encoding(self):
        """Test BC decoding of old $XX$ encoded filenames."""
        test_cases = [
            ("test$3A$file", "test:file"),
            ("test$3C$file$3E$", "test<file>"),
            ("test$24$name", "test$name"),  # old encoded dollar sign
        ]
        for encoded, expected in test_cases:
            with self.subTest(encoded=encoded):
                self.assertEqual(decode_filename(encoded), expected)

    def test_decode_dollar_sign_literal(self):
        """Dollar sign is now a literal character, not an escape prefix."""
        # A bare $ not part of a valid $XX$ pattern passes through unchanged
        self.assertEqual(decode_filename("file$name"), "file$name")

    def test_decode_empty_raises_error(self):
        """Test that decoding empty string raises ValueError."""
        with self.assertRaises(ValueError) as cm:
            decode_filename("")
        self.assertIn("cannot be empty", str(cm.exception))

    def test_encode_decode_roundtrip(self):
        """Test full round-trip encoding and decoding."""
        test_cases = [
            "10.1111/1467-6478.00040",
            "10.5771/2699-1284-2024-3-149",
            "10.1234/test:file<name>",
            "doc_id_with-dashes.and.dots",
            "file/with/multiple/slashes",
            'special"chars|test*file?name',
            "file$with$dollar",  # $ is no longer encoded, passes through
        ]

        for original in test_cases:
            with self.subTest(original=original):
                encoded = encode_filename(original)
                decoded = decode_filename(encoded)
                self.assertEqual(decoded, original)



class TestXmlIdEncoding(unittest.TestCase):
    """Test encode_for_xml_id / decode_from_xml_id."""

    def test_prepend_underscore_for_digit_start(self):
        """Digit-leading file_ids get a leading _ to be NCName-safe."""
        self.assertEqual(encode_for_xml_id("10.5771__2699-1284-2024-3-149"), "_10.5771__2699-1284-2024-3-149")

    def test_no_prepend_for_letter_start(self):
        """Letter-leading file_ids are unchanged."""
        self.assertEqual(encode_for_xml_id("my-document"), "my-document")

    def test_new_xXX_pattern_unchanged(self):
        """New _xXX_ patterns are already NCName-safe, no transformation needed."""
        self.assertEqual(encode_for_xml_id("doc_x3A_file"), "doc_x3A_file")

    def test_legacy_dollar_pattern_converted(self):
        """BC: old $XX$ patterns are converted to _xXX_."""
        self.assertEqual(encode_for_xml_id("doc$3A$name"), "doc_x3A_name")

    def test_round_trip_new_format(self):
        """encode then decode returns the original file_id (new _xXX_ format)."""
        cases = [
            "10.5771__2699-1284-2024-3-149",
            "my-document",
            "doc_x3A_file",
        ]
        for file_id in cases:
            with self.subTest(file_id=file_id):
                self.assertEqual(decode_from_xml_id(encode_for_xml_id(file_id)), file_id)

    def test_decode_strips_leading_underscore_before_digit(self):
        """Leading _ is stripped only when followed by a digit."""
        self.assertEqual(decode_from_xml_id("_10.5771__abc"), "10.5771__abc")

    def test_decode_keeps_underscore_before_letter(self):
        """Leading _ before a letter is not stripped."""
        self.assertEqual(decode_from_xml_id("_my-doc"), "_my-doc")

    def test_decode_does_not_translate_xXX(self):
        """decode_from_xml_id no longer translates _xXX_ back — that is encode_filename format."""
        self.assertEqual(decode_from_xml_id("test_x3A_file"), "test_x3A_file")


class TestDOIValidation(unittest.TestCase):
    """Test DOI validation and normalization."""

    def test_validate_doi_valid(self):
        """Test validation of valid DOIs."""
        valid_dois = [
            "10.1111/1467-6478.00040",
            "10.5771/2699-1284-2024-3-149",
            "10.1234/abc-def_ghi:jkl(mno)",
            "10.12345/test",
        ]

        for doi in valid_dois:
            with self.subTest(doi=doi):
                self.assertTrue(validate_doi(doi))

    def test_validate_doi_invalid(self):
        """Test validation of invalid DOIs."""
        invalid_dois = [
            "",
            "not-a-doi",
            "10/missing-prefix",
            "10.123/too-short-prefix",  # Prefix must be 4-9 digits
            "11.1234/wrong-prefix",
        ]

        for doi in invalid_dois:
            with self.subTest(doi=doi):
                self.assertFalse(validate_doi(doi))

    def test_normalize_doi_removes_whitespace(self):
        """Test that normalization removes whitespace."""
        doi = "  10.1111/1467-6478.00040  "
        normalized = normalize_doi(doi)
        self.assertEqual(normalized, "10.1111/1467-6478.00040")

    def test_normalize_doi_removes_prefixes(self):
        """Test that normalization removes common prefixes."""
        test_cases = [
            ("doi:10.1111/test", "10.1111/test"),
            ("DOI:10.1111/test", "10.1111/test"),
            ("http://doi.org/10.1111/test", "10.1111/test"),
            ("https://doi.org/10.1111/test", "10.1111/test"),
            ("http://dx.doi.org/10.1111/test", "10.1111/test"),
            ("https://dx.doi.org/10.1111/test", "10.1111/test"),
        ]

        for original, expected in test_cases:
            with self.subTest(original=original):
                normalized = normalize_doi(original)
                self.assertEqual(normalized, expected)

    def test_normalize_doi_handles_empty(self):
        """Test that normalization handles empty string."""
        self.assertEqual(normalize_doi(""), "")
        self.assertEqual(normalize_doi(None), None)


if __name__ == '__main__':
    unittest.main()
