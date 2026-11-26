"""
@testCovers fastapi_app/lib/ocr/line_review.py
"""

import asyncio
import json
import unittest

from fastapi_app.lib.ocr.line_review import (
    ReviewLines,
    build_user_prompt,
    parse_corrections,
    review_lines_window,
)

LINES = ReviewLines(
    texts=["Zeile eins", "Zeile zwie", "Zeile drei", "Zeile vier", "Zeile fünf", "Zeile sechs"],
    windows=[range(0, 3), range(3, 6)],
    languages=["de"],
)


def answer(*items: tuple[str, str, str]) -> str:
    return json.dumps([{"line": line, "old": old, "new": new, "rationale": "OCR"} for line, old, new in items])


class FakeProvider:
    def __init__(self, responses: list[str]) -> None:
        self.responses = list(responses)
        self.user_prompts: list[str] = []

    async def chat_completion(self, model_id: str, system_prompt: str, user_prompt: str, temperature: float = 0.2) -> str:
        self.user_prompts.append(user_prompt)
        return self.responses.pop(0)


class LineReviewTest(unittest.TestCase):
    def test_prompt_numbers_global_lines_with_context(self) -> None:
        prompt = build_user_prompt(LINES, LINES.windows[1], (2, 2))
        self.assertIn("## Languages\n\nde", prompt)
        self.assertIn("## Context before (do not correct)\n\n0001 | Zeile eins\n0002 | Zeile zwie\n0003 | Zeile drei", prompt)
        self.assertIn("## Lines to proofread (part 2 of 2 of the document)\n\n0004 | Zeile vier\n0005 | Zeile fünf\n0006 | Zeile sechs", prompt)
        self.assertNotIn("Context after", prompt)

    def test_parse_rejects_context_lines(self) -> None:
        kept, dropped = parse_corrections(answer(("2", "zwie", "zwei"), ("5", "fünf", "fuenf")), LINES, LINES.windows[0], 0.5)
        self.assertEqual([c.line for c in kept], [1])
        self.assertEqual(len(dropped), 1)
        self.assertIn("outside the lines to proofread", dropped[0])

    def test_review_lines_window_retries(self) -> None:
        provider = FakeProvider([answer(("5", "fünf", "fuenf")), answer(("2", "zwie", "zwei"))])
        corrections, count, discarded = asyncio.run(review_lines_window(LINES, 0, provider, "m", 0.5))  # type: ignore[arg-type]
        self.assertEqual([c.line for c in corrections], [1])
        self.assertEqual((count, discarded), (2, 0))
        self.assertEqual(len(provider.user_prompts), 2)
        self.assertIn("Note on a previous attempt", provider.user_prompts[1])


if __name__ == "__main__":
    unittest.main()
