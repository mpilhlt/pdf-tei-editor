"""
Unit tests for editorialDecl generation in the GROBID extractor.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_extractor_editorial_decl.py -v

@testCovers fastapi_app/plugins/grobid/extractor.py
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from fastapi_app.plugins.grobid.extractor import GrobidTrainingExtractor


class TestBuildEncodingDesc(unittest.TestCase):
    """
    Exercises GrobidTrainingExtractor._build_encoding_desc() - the method
    extract() calls to assemble encodingDesc, including the editorialDecl
    wiring added on top of create_encoding_desc_with_extractor(). Patches
    build_editorial_decl_entries at its import site inside extractor.py
    (not inside annotation_rules.py) so the test observes exactly what the
    extractor itself passes.
    """

    @patch("fastapi_app.plugins.grobid.extractor.build_editorial_decl_entries")
    def test_training_variant_uses_local_variant_id_not_enc_variant_id(self, mock_build):
        """
        For GROBID training variants, `enc_variant_id` passed to
        create_encoding_desc_with_extractor() is None (their variant-id label
        is emitted via additional_labels instead). build_editorial_decl_entries
        must still be called with the extractor's own `variant_id` local (e.g.
        "grobid.training.segmentation"), not with `enc_variant_id`/None -
        this is the exact regression this test guards against.
        """
        mock_build.return_value = []

        extractor = GrobidTrainingExtractor()
        extractor._build_encoding_desc(
            timestamp="2026-01-01T00:00:00Z",
            grobid_version="0.8.0",
            grobid_revision="rev-1",
            variant_id="grobid.training.segmentation",
            flavor="default",
        )

        mock_build.assert_called_once()
        call_args = mock_build.call_args
        # variant_id is the first positional argument to build_editorial_decl_entries
        self.assertEqual(call_args[0][0], "grobid.training.segmentation")

    @patch("fastapi_app.plugins.grobid.extractor.build_editorial_decl_entries")
    def test_returned_entries_are_wired_into_encoding_desc(self, mock_build):
        """
        The entries build_editorial_decl_entries() returns must actually reach
        create_encoding_desc_with_extractor() via the editorial_decl_entries
        kwarg - not be dropped - and show up as an editorialDecl in the
        resulting encodingDesc element.
        """
        mock_build.return_value = [
            {"category": "general", "refs": [
                {"target": "https://example.org/guide", "content_type": "markdown", "subtype": "human"},
            ]},
        ]

        extractor = GrobidTrainingExtractor()
        encoding_desc = extractor._build_encoding_desc(
            timestamp="2026-01-01T00:00:00Z",
            grobid_version="0.8.0",
            grobid_revision="rev-1",
            variant_id="grobid.training.segmentation",
            flavor="default",
        )

        editorial_decl = encoding_desc.find("editorialDecl")
        self.assertIsNotNone(editorial_decl)
        ref = editorial_decl.find(".//ref")
        self.assertIsNotNone(ref)
        self.assertEqual(ref.get("target"), "https://example.org/guide")

    @patch("fastapi_app.plugins.grobid.extractor.build_editorial_decl_entries")
    def test_non_training_variant_also_uses_variant_id_for_guide_lookup(self, mock_build):
        """
        Non-training variants pass variant_id through as enc_variant_id too,
        so this doesn't distinguish enc_variant_id from variant_id on its own -
        but it does confirm the lookup isn't accidentally skipped or passed
        something else (e.g. None) for non-training variants.
        """
        mock_build.return_value = []

        extractor = GrobidTrainingExtractor()
        extractor._build_encoding_desc(
            timestamp="2026-01-01T00:00:00Z",
            grobid_version="0.8.0",
            grobid_revision="rev-1",
            variant_id="grobid.service.fulltext",
            flavor="default",
        )

        mock_build.assert_called_once()
        self.assertEqual(mock_build.call_args[0][0], "grobid.service.fulltext")


if __name__ == "__main__":
    unittest.main()
