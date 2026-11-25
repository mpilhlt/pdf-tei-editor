# Footnote marker repair for markers without parenthesis

Follow-up to PR #912 (issue #904). The first version only repaired markers followed by a closing parenthesis (`tut³¹²⁾` → `tut?!?)`). This style is the exception in German legal literature; most publications set plain superscript numbers (`Regel¹²`), often after punctuation (`vor.¹⁴`, `Bundesgerichtshof,¹⁵`), and many also set the footnote numbers at the start of the footnotes as superscripts.

## What Tesseract makes of them

Measured with Tesseract 5.3 (`deu`) on a generated page in Liberation Serif at 300 and 400 dpi (now the fixture `footnote-markers-plain.pdf`):

| Printed | Recognized |
| --- | --- |
| `Regel¹²` | `Regel"`, `Regel”` |
| `persönlich¹³.` | `persönlich".` |
| `vor.¹⁴` | `vor.'`, `vor.'*` |
| `Bundesgerichtshof,¹⁵` | `Bundesgerichtshof,'`, `Bundesgerichtshof,"` |
| `„Doppelverpflichtung“¹⁶` | `„Doppelverpflichtung“'` (300 dpi), `„Doppelverpflichtung“` (400 dpi, marker dropped) |
| `streng¹⁸;` | `streng”;`, `streng’;` |
| `¹² Vgl. …` (footnote) | `» Vgl.`, `“Vgl.`, `® Vgl.`, `"® Vgl.` |

Without the footnote numbers at the start of the footnotes, the first version found no numbering and repaired nothing on such pages.

## Change

- Words ending in non-letters without `)` are candidates if the image shows raised glyphs at their end. Punctuation directly after the letters (`.,;:)`) and the closing quotation mark of a quoted word stay part of the text. Raised words of their own (judged against the hOCR line baseline) are candidates too.
- These candidates have less evidence than parenthesized ones, so they only get a number at most three ahead of the previous marker and not below the first footnote number of their page.
- Lines that start with raised non-letters are recognized again as footnote starts. They enter the sequence fit with a third of the score of numbers read as digits, and they are repaired (`» Vgl.` → `12 Vgl.`) if the fit took them and a reading contains the fitted number.
- `fit_footnote_starts()` returns the fitted number of every start; `fit_footnote_numbers()` is built on it.

On the new fixture (OCRmyPDF, 400 dpi), all 8 markers and 8 footnote numbers are repaired, and quotation marks and apostrophes without markers in the same text are left alone.

## Not covered

- Markers that Tesseract drops entirely or reads as letters.
- The 71-page example document of #904 was not available in the session, so its result (286 of 313 markers) was not measured again. The parenthesized path is unchanged.
