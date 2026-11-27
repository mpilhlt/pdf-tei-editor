# Text corrections: dashes, quotation marks and respelled words

On a 71-page document, "Write text corrections to PDF" listed well over a hundred differences as unwritable ("different number of words"), such as `— II.` → `-II.`, `„rechts- und` → `"rechts-und` or `2021?) - es` → `20212) -es`. The TEI, which comes from GROBID, has ASCII hyphens and quotes where the OCR text layer has typographic ones, and often no space between a dash and the next word. These are no errors of the text recognition; writing them would also have replaced the PDF's em dashes with hyphens.

## Changes in `fastapi_app/lib/ocr/text_corrections.py`

- Words are compared in a folded form: dashes and the minus sign become `-`, typographic double and single quotes become `"` and `'` (`_FOLD`, `_fold()`). Differences that are only folding plus splitting or joining words are ignored.
- A correction keeps the layer's characters where they only differ by folding (`_merge()`): `„Regel’)“` corrected by `"Regel12)"` becomes `„Regel12)“`.
- A difference with another number of words is written if, without whitespace and after folding, it only replaces characters within single layer words and the texts are at least 75% similar (`_respell()`). `2021?) — es` → `20212) -es` corrects `2021?)` to `20212)` and keeps `—` and `es`. Inserted or deleted characters (such as a removed hyphen) and replacements across a word boundary of the layer stay unwritable.

A deliberate change from `-` to `—` in the TEI is no longer written, since the TEI cannot carry this distinction reliably.

Tests: `tests/unit/fastapi/test_text_corrections.py`.
