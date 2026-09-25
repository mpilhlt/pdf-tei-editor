"""
Unit tests for splitting <text> content into review chunks.

@testCovers fastapi_app/plugins/annotation_review/chunking.py
"""

import unittest

from fastapi_app.plugins.annotation_review.chunking import split_into_chunks


def _bibls(n: int) -> str:
    return "".join(f"<bibl>Author {i}, <title>Title {i}</title>.</bibl>\n" for i in range(n))


class TestSplitIntoChunks(unittest.TestCase):
    def test_short_text_is_a_single_chunk(self):
        text = "<text><body><p>hi</p></body></text>"
        self.assertEqual(split_into_chunks(text, 1000), [text])

    def test_chunks_concatenate_to_the_input(self):
        text = f"<text><body><listBibl>{_bibls(50)}</listBibl></body></text>"
        chunks = split_into_chunks(text, 400)
        self.assertGreater(len(chunks), 1)
        self.assertEqual("".join(chunks), text)

    def test_splits_between_units_not_inside_them(self):
        text = f"<text><body><listBibl>{_bibls(50)}</listBibl></body></text>"
        for chunk in split_into_chunks(text, 400)[1:-1]:
            self.assertTrue(chunk.startswith("<bibl>") or chunk.startswith("\n<bibl>"), chunk[:30])
            self.assertEqual(chunk.count("<bibl>"), chunk.count("</bibl>"))
            self.assertEqual(chunk.count("<title>"), chunk.count("</title>"))

    def test_chunks_respect_the_budget(self):
        text = f"<text><body><listBibl>{_bibls(50)}</listBibl></body></text>"
        for chunk in split_into_chunks(text, 400):
            self.assertLessEqual(len(chunk), 400)

    def test_uses_the_shallowest_depth_that_fits(self):
        paragraphs = "".join(f"<p>Paragraph {i} with <persName>Name {i}</persName> inside.</p>" for i in range(20))
        text = f"<text><body>{paragraphs}</body></text>"
        for chunk in split_into_chunks(text, 300):
            self.assertEqual(chunk.count("<p>"), chunk.count("</p>"))

    def test_an_oversize_unit_stays_whole(self):
        big = "<p>" + "x" * 1000 + "</p>"
        chunks = split_into_chunks(f"<text><body>{big}<p>small</p></body></text>", 200)
        self.assertTrue(any(big in c for c in chunks))

    def test_ignores_comments_and_gt_in_attribute_values(self):
        text = f'<text><body><!-- <p> not a tag --><note n="a>b">x</note>{_bibls(30)}</body></text>'
        chunks = split_into_chunks(text, 300)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(any('<note n="a>b">x</note>' in c for c in chunks))

    def test_self_closing_elements_do_not_change_depth(self):
        text = f"<text><body>{'<lb/>' * 5}{_bibls(30)}</body></text>"
        chunks = split_into_chunks(text, 300)
        self.assertEqual("".join(chunks), text)
        for chunk in chunks[1:-1]:
            self.assertEqual(chunk.count("<bibl>"), chunk.count("</bibl>"))
