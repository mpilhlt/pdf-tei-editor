"""Feature-token extraction and encodingDesc parsing for GROBID training sync."""

import re
import zipfile
from pathlib import Path

from lxml import etree

_NS = "http://www.tei-c.org/ns/1.0"

# Tokenizer that approximates GROBID's analyzer. A token is either a run of
# letters/digits (incl. extended Latin), optionally preceded by "<" and/or followed
# by ">" (GROBID keeps URL bracket chars attached to adjacent word tokens), or any
# single non-whitespace non-word character.
_TOKEN_RE = re.compile(r"<?[a-zA-Z0-9À-ɏ]+>?|[^\s\w]")


def parse_encoding_labels(xml_content: str) -> dict[str, str]:
    """
    Extract label values from the extractor application in encodingDesc.

    Returns a dict with whichever of these keys are present:
    ``model``, ``flavor``, ``variant-id``, ``revision``.
    """
    parser = etree.XMLParser(recover=True)
    try:
        root = etree.fromstring(xml_content.encode("utf-8"), parser)
    except etree.XMLSyntaxError:
        return {}

    app = root.find(".//encodingDesc/appInfo/application[@type='extractor']") or root.find(
        f".//{{{_NS}}}encodingDesc/{{{_NS}}}appInfo/{{{_NS}}}application[@type='extractor']"
    )
    if app is None:
        return {}

    result: dict[str, str] = {}
    for key in ("model", "flavor", "variant-id", "revision"):
        el = app.find(f"label[@type='{key}']") or app.find(f"{{{_NS}}}label[@type='{key}']")
        if el is not None and el.text:
            result[key] = el.text
    return result


def extract_feature_tokens(zip_path: Path, suffix: str) -> list[str] | None:
    """
    Read the feature file for *suffix* from *zip_path* and return its token list.

    The feature file is the entry whose name ends with ``.training.<suffix>`` but
    does **not** end with ``.tei.xml``.  Each non-blank line contributes its first
    whitespace-separated field as a token.

    *suffix* is the variant-id with the ``grobid.training.`` prefix stripped,
    e.g. ``references.referenceSegmenter`` or ``header``.

    Returns ``None`` if the zip does not exist or contains no matching entry.
    """
    if not zip_path.exists():
        return None

    entry_suffix = f".training.{suffix}"
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            entry = next(
                (n for n in zf.namelist() if n.endswith(entry_suffix) and not n.endswith(".tei.xml")),
                None,
            )
            if entry is None:
                return None
            raw = zf.read(entry).decode("utf-8", errors="replace")
    except (zipfile.BadZipFile, KeyError, OSError):
        return None

    tokens: list[str] = []
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped:
            parts = stripped.split()
            if parts:
                tokens.append(parts[0])
    return tokens
