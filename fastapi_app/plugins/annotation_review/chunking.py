"""
Split a TEI <text> element's raw XML into review-sized chunks.

Chunks are contiguous raw substrings (concatenating them yields the input
exactly), so a finding's "old" snippet copied from a chunk still matches the
live editor text byte-for-byte. Split points are element boundaries at the
shallowest depth where every unit fits the size budget, so units such as a
<bibl> or <note> are not cut in half.
"""

import re

CHUNK_MAX_CHARS = 8000

_TAG_RE = re.compile(
    r"<!--.*?-->|<!\[CDATA\[.*?\]\]>|<\?.*?\?>|<(/?)[\w:.-]+(?:\"[^\"]*\"|'[^']*'|[^>\"'])*?(/?)>",
    re.DOTALL,
)


def split_into_chunks(text: str, max_chars: int = CHUNK_MAX_CHARS) -> list[str]:
    """Split raw XML into chunks of at most max_chars where element boundaries allow; oversize units stay whole."""
    if len(text) <= max_chars:
        return [text]

    boundaries: list[tuple[int, int]] = []
    depth = 0
    for match in _TAG_RE.finditer(text):
        closing, self_closing = match.group(1), match.group(2)
        if closing is None:
            continue
        if closing:
            depth -= 1
        elif not self_closing:
            depth += 1
            continue
        boundaries.append((match.end(), depth))

    max_depth = max((d for _, d in boundaries), default=0)
    segments: list[str] = [text]
    for limit in range(1, max_depth + 1):
        cuts = sorted({pos for pos, d in boundaries if d <= limit} | {len(text)})
        segments = [text[start:end] for start, end in zip([0, *cuts], cuts) if end > start]
        if max(len(s) for s in segments) <= max_chars:
            break

    chunks: list[str] = []
    current = ""
    for segment in segments:
        if current and len(current) + len(segment) > max_chars:
            chunks.append(current)
            current = ""
        current += segment
    if current:
        chunks.append(current)
    return chunks
