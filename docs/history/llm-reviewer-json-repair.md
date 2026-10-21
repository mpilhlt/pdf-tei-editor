# LLM reviewer: repair malformed JSON responses

## Problem

The annotation review failed with "The model did not return a JSON list of findings" although the response was a JSON list. The model had copied XML into the `"old"` string without escaping the attribute quotes:

```text
"old": "supra note <biblScope unit="issue">3</biblScope>",
```

`_extract_json_list()` already tolerated markdown fences, surrounding prose and truncated lists, but any string-level syntax error made every candidate fail.

## Change

In `fastapi_app/plugins/annotation_review/prompts.py`:

- `_find_json_list()` holds the existing "try every `[`" search; decoding uses `strict=False`, so raw newlines inside strings are accepted.
- `_repair_json_strings()` runs only when the plain parse fails. From the first `[{` on, it walks the text with an in-string flag. A `"` inside a string closes it only if followed by `:`, `}`, `]`, the end of the text, or a `,` that starts the next key or object; otherwise it is escaped. Invalid escapes (`\'`, `\<`) get their backslash doubled. Prose before the array is left untouched so its quotes cannot shift string boundaries.
- Truncation salvage runs on the raw and then on the repaired text.
- The final error now says the response could not be repaired.

## Limits

A quote followed by `,` and then a `"` (e.g. `"a "b", "c" d"`) is still taken as a string end; such responses fall back to salvage or the error.

## Tests

`fastapi_app/plugins/annotation_review/tests/test_prompts.py`: the reported response, invalid escapes and raw newlines, quoted prose before a fenced array, and a truncated response with unescaped quotes.
