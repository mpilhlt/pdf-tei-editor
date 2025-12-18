"""
Utility functions for XML diff operations.
"""

import copy
from typing import cast
from lxml import etree


def preprocess_for_diff(
    elem: etree._Element,
    ignore_tags: frozenset,
    ignore_attrs: frozenset,
    inject_line_markers: bool = False
) -> etree._Element:
    """
    Create a copy of element tree with ignored tags removed, ignored attributes stripped,
    and text content whitespace normalized.

    Args:
        elem: Root element to preprocess
        ignore_tags: Set of tag names to remove
        ignore_attrs: Set of attribute names to remove
        inject_line_markers: If True, add data-line attribute with sourceline to each element

    Returns:
        Preprocessed copy of element tree
    """
    # Deep copy to avoid modifying original
    elem_copy = copy.deepcopy(elem)

    # Remove ignored tags
    for tag_name in ignore_tags:
        ignored_elems = cast(list[etree._Element], elem_copy.xpath(f'.//*[local-name()="{tag_name}"]'))
        for ignored_elem in ignored_elems:
            parent = ignored_elem.getparent()
            if parent is not None:
                parent.remove(ignored_elem)

    # Strip ignored attributes and normalize text content
    for el in elem_copy.iter():
        if not isinstance(el.tag, str):
            continue

        # Inject line marker if requested
        if inject_line_markers and hasattr(el, 'sourceline') and el.sourceline:
            el.set('data-line', str(el.sourceline))

        # Normalize text content (collapse whitespace)
        if el.text:
            normalized = " ".join(el.text.split())
            el.text = normalized if normalized else None

        # Normalize tail content (text after element)
        if el.tail:
            normalized = " ".join(el.tail.split())
            el.tail = normalized if normalized else None

        # Strip ignored attributes
        for attr_name in list(el.attrib.keys()): 
            attr_name = str(attr_name)
            # Handle namespaced attributes
            if "}" in attr_name:
                ns_uri, local = attr_name.split("}")
                # Convert to prefix:local format for common namespaces
                if "www.w3.org/XML" in ns_uri:
                    full_name = f"xml:{local}"
                else:
                    full_name = local
            else:
                full_name = attr_name

            if full_name in ignore_attrs:
                del el.attrib[attr_name]

    return elem_copy


def find_element_line_offset(full_xml: str, elem: etree._Element) -> int:
    """
    Find the line number where the element starts in the full document (1-indexed).
    Uses sourceline if available, otherwise searches for the tag.

    Args:
        full_xml: Full XML document string
        elem: Element to find

    Returns:
        Line number (1-indexed) where element starts
    """
    if hasattr(elem, 'sourceline') and elem.sourceline:
        return elem.sourceline

    # Fallback: search for opening tag in full XML
    tag_name = elem.tag.split('}')[-1] if '}' in elem.tag else elem.tag
    lines = full_xml.split('\n')
    for i, line in enumerate(lines):
        if f'<{tag_name}' in line or f'<tei:{tag_name}' in line:
            return i + 1
    return 1  # Fallback to line 1 if not found


def serialize_with_linebreaks(elem: etree._Element) -> str:
    """
    Serialize XML with linebreaks after each element, preserving document order.

    This creates a more readable diff than single-line serialization, while
    avoiding the element reordering that can happen with pretty_print=True.

    Args:
        elem: Element to serialize

    Returns:
        XML string with linebreaks after each closing tag
    """
    # Serialize without pretty printing to preserve order
    xml_str = etree.tostring(elem, encoding="unicode", pretty_print=False)

    # Add newline after each closing tag to enable line-by-line diffing
    # This regex finds closing tags and adds a newline after them
    import re
    xml_str = re.sub(r'(</[^>]+>)', r'\1\n', xml_str)

    # Also add newline after self-closing tags
    #xml_str = re.sub(r'(/>\s*(?!</))', r'/>\n', xml_str)

    return xml_str


def escape_html(text: str) -> str:
    """Escape HTML special characters."""
    if not text:
        return ""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#x27;")
    )
