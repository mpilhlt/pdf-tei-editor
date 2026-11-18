"""
The XPath expressions of the node navigation in the XML editor statusbar, stored in `data/db/navigation_xpath.json`.

The file has the shape of the `navigation_xpath` property of the extractors: a mapping of variant ids to lists
of entries `{"value": <xpath>, "label": <HTML-escaped label>}`. The entries that the extractors provide are
merged into the file on every read and carry `"edit": false`: they cannot be changed or deleted. The other
entries are added by users in the navigation XPath dialog.
"""

import html
import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Iterable, NotRequired, TypedDict

from lxml import etree

NAVIGATION_XPATH_FILE = "navigation_xpath.json"

# Namespace prefixes that navigation XPath expressions can use, as resolved by the XML editor
XPATH_NAMESPACES: dict[str, str] = {
    "tei": "http://www.tei-c.org/ns/1.0",
    "xml": "http://www.w3.org/XML/1998/namespace",
}

_lock = threading.Lock()


class NavigationXpathEntry(TypedDict):
    """A navigable XPath target shown in the navigation dropdown."""

    value: str
    label: str
    edit: NotRequired[bool]


NavigationXpath = dict[str, list[NavigationXpathEntry]]


class InvalidXpathError(ValueError):
    """The XPath expression cannot be used for the node navigation."""


def validate_navigation_xpath(xpath: str) -> None:
    """Check that `xpath` is an absolute XPath 1.0 expression that selects nodes.

    Only the namespace prefixes in `XPATH_NAMESPACES` can be used.

    Raises:
        InvalidXpathError: with a message that can be shown to the user
    """
    if not xpath.startswith("/"):
        raise InvalidXpathError("The XPath expression must start with '/'")
    try:
        result = etree.XPath(xpath, namespaces=XPATH_NAMESPACES)(etree.fromstring("<TEI/>"))
    except etree.XPathSyntaxError as e:
        raise InvalidXpathError(f"Invalid XPath expression: {e}") from e
    except etree.XPathEvalError as e:
        raise InvalidXpathError(f"Invalid XPath expression: {e}") from e
    if not isinstance(result, list):
        raise InvalidXpathError("The XPath expression must select elements")


def extractor_defaults(extractors: Iterable[dict[str, Any]]) -> NavigationXpath:
    """The navigation XPath entries that the extractors provide, by variant, without duplicates.

    Args:
        extractors: extractor infos as returned by `list_extractors()`
    """
    defaults: NavigationXpath = {}
    for extractor in extractors:
        for variant, entries in (extractor.get("navigation_xpath") or {}).items():
            variant_entries = defaults.setdefault(variant, [])
            for entry in entries or []:
                value = entry.get("value")
                if not value or any(e["value"] == value for e in variant_entries):
                    continue
                variant_entries.append({"value": value, "label": entry.get("label") or html.escape(value), "edit": False})
    return defaults


def merge_navigation_xpath(stored: NavigationXpath, defaults: NavigationXpath) -> NavigationXpath:
    """Merge the extractor defaults into the stored entries.

    The defaults come first and replace all stored entries with `"edit": false`, so that defaults of removed
    extractors disappear. User entries whose expression is also a default are dropped.
    """
    merged: NavigationXpath = {}
    for variant in [*defaults, *(v for v in stored if v not in defaults)]:
        default_entries = defaults.get(variant, [])
        default_values = {e["value"] for e in default_entries}
        custom = [
            {"value": e["value"], "label": e.get("label") or html.escape(e["value"])}
            for e in stored.get(variant, [])
            if e.get("edit", True) is not False and e.get("value") and e["value"] not in default_values
        ]
        if default_entries or custom:
            merged[variant] = [*default_entries, *custom]  # type: ignore[list-item]
    return merged


def _path(db_dir: Path) -> Path:
    return db_dir / NAVIGATION_XPATH_FILE


def _read(db_dir: Path) -> NavigationXpath:
    path = _path(db_dir)
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else {}


def _write(db_dir: Path, data: NavigationXpath) -> None:
    db_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=db_dir, prefix=".navigation_xpath.", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, _path(db_dir))
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def load_navigation_xpath(db_dir: Path, extractors: Iterable[dict[str, Any]]) -> NavigationXpath:
    """The navigation XPath entries of all variants, with the extractor defaults merged in.

    Writes the merged entries back to the file if they differ from its content.
    """
    defaults = extractor_defaults(extractors)
    with _lock:
        stored = _read(db_dir)
        merged = merge_navigation_xpath(stored, defaults)
        if merged != stored:
            _write(db_dir, merged)
    return merged


def save_custom_entries(
    db_dir: Path, extractors: Iterable[dict[str, Any]], variant: str, entries: list[tuple[str, str]]
) -> list[NavigationXpathEntry]:
    """Replace the user entries of a variant.

    Args:
        db_dir: the db directory
        extractors: extractor infos as returned by `list_extractors()`
        variant: the variant id
        entries: `(xpath, plain-text label)` pairs; an empty label defaults to the expression

    Returns:
        All entries of the variant, defaults first

    Raises:
        InvalidXpathError: if an expression is invalid, a duplicate or one of the defaults
    """
    defaults = extractor_defaults(extractors)
    default_values = {e["value"] for e in defaults.get(variant, [])}
    custom: list[NavigationXpathEntry] = []
    for xpath, label in entries:
        xpath = xpath.strip()
        validate_navigation_xpath(xpath)
        if xpath in default_values:
            raise InvalidXpathError(f"'{xpath}' is already a default expression")
        if any(e["value"] == xpath for e in custom):
            raise InvalidXpathError(f"'{xpath}' is entered more than once")
        custom.append({"value": xpath, "label": html.escape(label.strip() or xpath)})
    with _lock:
        stored = _read(db_dir)
        stored[variant] = custom
        merged = merge_navigation_xpath(stored, defaults)
        _write(db_dir, merged)
    return merged.get(variant, [])
