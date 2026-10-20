"""
Unit tests for npm-style semver range matching.

@testCovers fastapi_app/lib/utils/semver.py
"""

import unittest

from fastapi_app.lib.utils.semver import SemverError, parse_version, satisfies, validate_range

CASES: list[tuple[str, str, bool]] = [
    ("0.75.0", ">=0.75.0", True),
    ("0.74.9", ">=0.75.0", False),
    ("0.75.3", "^0.75.0", True),
    ("0.76.0", "^0.75.0", False),
    ("1.4.0", "^1.2", True),
    ("2.0.0", "^1.2", False),
    ("0.0.3", "^0.0.3", True),
    ("0.0.4", "^0.0.3", False),
    ("1.2.9", "~1.2.3", True),
    ("1.3.0", "~1.2.3", False),
    ("1.5.0", "1.x", True),
    ("2.0.0", "1.x || 2.x", True),
    ("3.0.0", "1.x || 2.x", False),
    ("1.0.0", "*", True),
    ("1.0.0", "", True),
    ("1.5.0", "1.2.3 - 2.0.0", True),
    ("2.1.0", "1.2.3 - 2.0.0", False),
    ("0.75.0", ">=0.74 <0.76", True),
    ("0.76.0", ">= 0.74 < 0.76", False),
    ("1.2.3", "=1.2.3", True),
    ("1.2.4", "1.2", True),
    ("1.3.0", "1.2", False),
    ("5.0.0", ">4", True),
    ("4.9.0", ">4", False),
    ("0.75.0-devel.3", ">=0.75.0", True),
    ("v0.75.0+build.5", "0.75.0", True),
]


class TestSemver(unittest.TestCase):
    def test_ranges(self):
        for version, range_text, expected in CASES:
            with self.subTest(version=version, range=range_text):
                self.assertEqual(satisfies(version, range_text), expected)

    def test_parse_version(self):
        self.assertEqual(parse_version("1.2.3"), (1, 2, 3))
        self.assertEqual(parse_version("v1.2.3-beta.1"), (1, 2, 3))
        for bad in ("1.2", "x.y.z", "", "1.2.3.4"):
            with self.subTest(bad=bad), self.assertRaises(SemverError):
                parse_version(bad)

    def test_invalid_ranges(self):
        for bad in (">=foo", "^", "1.2.3.4", ">=1.0 <"):
            with self.subTest(bad=bad), self.assertRaises(SemverError):
                validate_range(bad)


if __name__ == "__main__":
    unittest.main()
