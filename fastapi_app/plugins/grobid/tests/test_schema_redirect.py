"""
Unit tests for the GROBID plugin's schema URL redirect registration.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_schema_redirect.py -v

@testCovers fastapi_app/plugins/grobid/config/__init__.py
"""

import unittest

from fastapi_app.lib.core.schema_validator import (
    resolve_schema_location,
    unregister_schema_redirect,
)
from fastapi_app.plugins.grobid.config import init_plugin_config

OLD_SCHEMA_BASE_URL = "https://mpilhlt.github.io/grobid-footnote-flavour/"


class TestGrobidSchemaRedirect(unittest.TestCase):
    """
    The mpilhlt/grobid-footnote-flavour repo was renamed to mpilhlt/fossil (#477),
    which also moved its GitHub Pages schema site without leaving a redirect.
    Documents extracted before the rename still embed the old schema URL, so
    init_plugin_config() must register a redirect to the new location.
    """

    def setUp(self):
        init_plugin_config()
        self.addCleanup(unregister_schema_redirect, OLD_SCHEMA_BASE_URL)

    def test_old_schema_url_redirects_to_new_repo(self):
        self.assertEqual(
            resolve_schema_location(
                f"{OLD_SCHEMA_BASE_URL}schema/grobid.training.segmentation.rng"
            ),
            "https://mpilhlt.github.io/fossil/schema/grobid.training.segmentation.rng"
        )


if __name__ == '__main__':
    unittest.main()
