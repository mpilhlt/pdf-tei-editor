"""
Unit tests for run_annotation() — the core annotation pipeline in routes.py.

Tests use a mock call_fn to supply fixed webservice responses, covering:
- Single-bibl annotation (content preserved, lb preserved)
- Multi-bibl split (inter-bibl separator text preserved)
- Trailing <lb/> outside bibl span re-attached to last bibl
- Content mismatch triggers retry; falls back to original on exhaustion
- Document-level element tail not included in fallback fragment

@testCovers fastapi_app/plugins/tei_annotator/routes.py
@testCovers fastapi_app/plugins/tei_annotator/annotators/footnote.py
"""

from __future__ import annotations

import unittest
from lxml import etree

from fastapi_app.plugins.tei_annotator.annotators import FootnoteAnnotator
from fastapi_app.plugins.tei_annotator.config import LB_PLACEHOLDER, TEI_NS
from fastapi_app.plugins.tei_annotator.routes import run_annotation


def _bibl(inner_xml: str, tail: str | None = None) -> etree._Element:
    el = etree.fromstring(f'<bibl xmlns="{TEI_NS}">{inner_xml}</bibl>'.encode())
    el.tail = tail
    return el


def _make_call_fn(*responses: str):
    """
    Return an async call_fn that yields successive annotated_xml strings.
    Each response is wrapped in {"xml": ...}.
    """
    it = iter(responses)

    async def _call_fn(**_kwargs):
        return {"xml": next(it)}

    return _call_fn


class TestRunAnnotationSingleBibl(unittest.IsolatedAsyncioTestCase):
    """Single-reference bibl: annotation adds tags, text is preserved."""

    async def test_basic_annotation_accepted(self):
        """Annotated result with matching plain text is returned as a fragment."""
        annotator = FootnoteAnnotator()
        original = _bibl(f"<label>1</label> Doe, J. (2024). Paper.{LB_PLACEHOLDER} ")
        annotated_xml = f'<bibl><label>1</label> Doe, J. (2024). Paper.{LB_PLACEHOLDER} </bibl>'

        fragments = await run_annotation(original, annotator, _make_call_fn(annotated_xml))

        self.assertEqual(len(fragments), 1)
        self.assertIn("Doe, J.", fragments[0])
        self.assertIn("<label>1</label>", fragments[0])

    async def test_trailing_lb_preserved_when_inside_bibl_span(self):
        """<lb/> that is inside the bibl span is preserved in the fragment."""
        annotator = FootnoteAnnotator()
        original = _bibl(f"<label>1</label> Text.{LB_PLACEHOLDER} ")
        annotated_xml = f'<bibl><label>1</label> Text.{LB_PLACEHOLDER} </bibl>'

        fragments = await run_annotation(original, annotator, _make_call_fn(annotated_xml))

        self.assertEqual(len(fragments), 1)
        self.assertIn("<lb/>", fragments[0])

    async def test_trailing_lb_preserved_when_outside_bibl_span(self):
        """<lb/> that falls outside the bibl span boundary is re-attached to the bibl."""
        annotator = FootnoteAnnotator()
        original = _bibl(f"<label>16</label> Text.{LB_PLACEHOLDER} ")
        # Webservice places lb outside the bibl span
        annotated_xml = f'<bibl><label>16</label> Text.</bibl>{LB_PLACEHOLDER} '

        fragments = await run_annotation(original, annotator, _make_call_fn(annotated_xml))

        self.assertEqual(len(fragments), 1)
        self.assertIn("<lb/>", fragments[0])

    async def test_document_tail_not_included_in_fragment(self):
        """The stored-document tail (inter-element whitespace) is not part of the fragment."""
        annotator = FootnoteAnnotator()
        original = _bibl(f"<label>1</label> Text.{LB_PLACEHOLDER} ", tail="\n        ")
        annotated_xml = f'<bibl><label>1</label> Text.{LB_PLACEHOLDER} </bibl>'

        fragments = await run_annotation(original, annotator, _make_call_fn(annotated_xml))

        self.assertEqual(len(fragments), 1)
        self.assertFalse(fragments[0].endswith("\n        "))


class TestRunAnnotationMultiBibl(unittest.IsolatedAsyncioTestCase):
    """Multi-reference bibl: footnote annotator splits into separate bibl elements."""

    async def test_split_produces_multiple_fragments(self):
        """Two references yield two fragments."""
        annotator = FootnoteAnnotator()
        original = _bibl(
            f"<label>15</label> SAAD-DINIZ, E. Book, 2015, p. 114-128; "
            f"BRAGATO, A. Thesis, 2017.{LB_PLACEHOLDER} "
        )
        annotated_xml = (
            f'<bibl><label>15</label> SAAD-DINIZ, E. Book, 2015, p. 114-128; </bibl>'
            f'<bibl>BRAGATO, A. Thesis, 2017.{LB_PLACEHOLDER} </bibl>'
        )

        fragments = await run_annotation(original, annotator, _make_call_fn(annotated_xml))

        self.assertEqual(len(fragments), 2)

    async def test_inter_bibl_separator_preserved_as_tail(self):
        """Separator text between split bibls is included in the first fragment's tail."""
        annotator = FootnoteAnnotator()
        original = _bibl(
            f"<label>15</label> SAAD-DINIZ, E. Book, 2015; BRAGATO, A. Thesis, 2017.{LB_PLACEHOLDER} "
        )
        annotated_xml = (
            f'<bibl><label>15</label> SAAD-DINIZ, E. Book, 2015;</bibl>'
            f' <bibl>BRAGATO, A. Thesis, 2017.{LB_PLACEHOLDER} </bibl>'
        )

        fragments = await run_annotation(original, annotator, _make_call_fn(annotated_xml))

        # The space separator " " is the tail of the first bibl and must appear
        # in the first fragment (with_tail=True for candidate elements).
        self.assertIn(" ", fragments[0][-5:])

    async def test_split_trailing_lb_outside_last_bibl_reattached(self):
        """Trailing <lb/> outside the last bibl span is moved into the last bibl."""
        annotator = FootnoteAnnotator()
        original = _bibl(
            f"<label>15</label> SAAD-DINIZ, E. Book, 2015; BRAGATO, A. Thesis, 2017.{LB_PLACEHOLDER} "
        )
        annotated_xml = (
            f'<bibl><label>15</label> SAAD-DINIZ, E. Book, 2015; </bibl>'
            f'<bibl>BRAGATO, A. Thesis, 2017.</bibl>{LB_PLACEHOLDER} '
        )

        fragments = await run_annotation(original, annotator, _make_call_fn(annotated_xml))

        self.assertEqual(len(fragments), 2)
        self.assertIn("<lb/>", fragments[1])


class TestRunAnnotationRetry(unittest.IsolatedAsyncioTestCase):
    """Retry and fallback behaviour when webservice drops content."""

    async def test_content_mismatch_retries_and_succeeds(self):
        """A bad first response is retried; a good second response is accepted."""
        annotator = FootnoteAnnotator()
        plain = f"<label>1</label> Text.{LB_PLACEHOLDER} "
        original = _bibl(plain)
        bad_response = f'<bibl><label>1</label> Text.</bibl>'   # lb dropped
        good_response = f'<bibl><label>1</label> Text.{LB_PLACEHOLDER} </bibl>'

        fragments = await run_annotation(
            original, annotator,
            _make_call_fn(bad_response, good_response),
            max_retries=1,
        )

        self.assertEqual(len(fragments), 1)
        self.assertIn("<lb/>", fragments[0])

    async def test_all_retries_exhausted_returns_original(self):
        """When every attempt drops content, the original element is returned unchanged."""
        annotator = FootnoteAnnotator()
        original = _bibl(f"<label>1</label> Text.{LB_PLACEHOLDER} ", tail="\n  ")
        bad = f'<bibl><label>1</label> Text.</bibl>'

        with self.assertLogs("fastapi_app.plugins.tei_annotator.routes", level="WARNING"):
            fragments = await run_annotation(
                original, annotator,
                _make_call_fn(bad, bad, bad),
                max_retries=2,
            )

        self.assertEqual(len(fragments), 1)
        self.assertIn("Text.", fragments[0])
        # Original element tail must NOT appear in fragment
        self.assertNotIn("\n  ", fragments[0])


if __name__ == "__main__":
    unittest.main()
