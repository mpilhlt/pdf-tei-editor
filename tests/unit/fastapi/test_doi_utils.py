"""
Unit tests for DOI utilities.

Tests:
- Filename encoding/decoding
- Legacy format compatibility
- Round-trip encoding
- Edge cases and error handling
"""

import unittest
import warnings

from fastapi_app.lib.doi_utils import (
    encode_filename,
    decode_filename,
    decode_filename_legacy,
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
            ("test:file", "test$3A$file"),
            ("test<file>", "test$3C$file$3E$"),
            ('test"file"', "test$22$file$22$"),
            ("test*file", "test$2A$file"),
            ("test?file", "test$3F$file"),
            ("test|file", "test$7C$file"),
            ("test\\file", "test$5C$file"),
        ]

        for original, expected in test_cases:
            with self.subTest(original=original):
                encoded = encode_filename(original)
                self.assertEqual(encoded, expected)

    def test_encode_dollar_sign(self):
        """Test that dollar sign itself is encoded to avoid ambiguity."""
        doc_id = "file$name"
        encoded = encode_filename(doc_id)
        self.assertEqual(encoded, "file$24$name")

    def test_encode_combined_special_chars(self):
        """Test encoding with multiple special characters."""
        doi = "10.1234/test:file<name>"
        encoded = encode_filename(doi)
        self.assertEqual(encoded, "10.1234__test$3A$file$3C$name$3E$")

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

    def test_decode_special_chars(self):
        """Test decoding various special characters."""
        test_cases = [
            ("test$3A$file", "test:file"),
            ("test$3C$file$3E$", "test<file>"),
            ("test$22$file$22$", 'test"file"'),
            ("test$2A$file", "test*file"),
            ("test$3F$file", "test?file"),
            ("test$7C$file", "test|file"),
            ("test$5C$file", "test\\file"),
        ]

        for encoded, expected in test_cases:
            with self.subTest(encoded=encoded):
                decoded = decode_filename(encoded)
                self.assertEqual(decoded, expected)

    def test_decode_dollar_sign(self):
        """Test decoding dollar sign encoding."""
        encoded = "file$24$name"
        decoded = decode_filename(encoded)
        self.assertEqual(decoded, "file$name")

    def test_decode_empty_raises_error(self):
        """Test that decoding empty string raises ValueError."""
        with self.assertRaises(ValueError) as cm:
            decode_filename("")
        self.assertIn("cannot be empty", str(cm.exception))

    def test_decode_invalid_hex_raises_error(self):
        """Test that invalid hex encoding raises ValueError."""
        with self.assertRaises(ValueError) as cm:
            decode_filename("test$ZZ$file")
        self.assertIn("Invalid hex encoding", str(cm.exception))

    def test_decode_incomplete_encoding_raises_error(self):
        """Test that incomplete $XX$ pattern raises ValueError."""
        with self.assertRaises(ValueError) as cm:
            decode_filename("test$3file")
        self.assertIn("incomplete $XX$ pattern", str(cm.exception))

    def test_encode_decode_roundtrip(self):
        """Test full round-trip encoding and decoding."""
        test_cases = [
            "10.1111/1467-6478.00040",
            "10.5771/2699-1284-2024-3-149",
            "10.1234/test:file<name>",
            "doc_id_with-dashes.and.dots",
            "file/with/multiple/slashes",
            'special"chars|test*file?name',
        ]

        for original in test_cases:
            with self.subTest(original=original):
                encoded = encode_filename(original)
                decoded = decode_filename(encoded)
                self.assertEqual(decoded, original)

    def test_decode_legacy_format(self):
        """Test decoding legacy encoded filenames."""
        test_cases = [
            ("10.1111$1$1467-6478.00040", "10.1111/1467-6478.00040"),
            ("test$2$file", "test:file"),
            ("test$3$file", "test?file"),
            ("test$4$file", "test*file"),
            ("test$5$file", "test|file"),
            ("test$6$file", "test<file"),
            ("test$7$file", "test>file"),
            ("test$8$file", 'test"file'),
            ("test$9$file", "test\\file"),
        ]

        for encoded, expected in test_cases:
            with self.subTest(encoded=encoded):
                # Suppress deprecation warning in tests
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", DeprecationWarning)
                    decoded = decode_filename_legacy(encoded)
                self.assertEqual(decoded, expected)

    def test_decode_legacy_raises_deprecation_warning(self):
        """Test that legacy decoder raises deprecation warning."""
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            decode_filename_legacy("10.1111$1$test")

            self.assertEqual(len(w), 1)
            self.assertTrue(issubclass(w[0].category, DeprecationWarning))
            self.assertIn("deprecated", str(w[0].message).lower())

    def test_decode_legacy_empty_raises_error(self):
        """Test that legacy decoder raises error on empty string."""
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            with self.assertRaises(ValueError):
                decode_filename_legacy("")


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
