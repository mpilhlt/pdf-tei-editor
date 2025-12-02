"""
XML utility functions for PDF-TEI-Editor.

This module provides framework-agnostic XML processing utilities.
No Flask or FastAPI dependencies.
"""

import xml.sax.saxutils as saxutils
from html import unescape
from typing import TypedDict, Optional


class EncodeOptions(TypedDict, total=False):
    """Options for XML entity encoding.

    Attributes:
        encode_quotes: If True, encode apostrophes (') and quotes (") as &apos; and &quot;
                      Default: False (not required by XML spec for text content)
    """
    encode_quotes: bool


def encode_xml_entities(xml_string: str, options: Optional[EncodeOptions] = None) -> str:
    """
    Escapes special characters in XML content using a manual string-parsing
    approach, but delegates the actual escaping logic to xml.sax.saxutils.escape.

    This function iterates through the string, keeping track of whether the
    current position is inside a tag, comment, CDATA, or processing instruction.

    By default, only escapes the characters that are strictly required in XML text content:
    - & (ampersand)
    - < (less-than)
    - > (greater-than)

    Args:
      xml_string: The raw XML string to be processed.
      options: Optional encoding options (see EncodeOptions)

    Returns:
      A new XML string with its node content properly escaped.
    """

    # Use default options if none provided
    if options is None:
        options = {}

    # Define optional entities for quotes (not strictly required in XML text content)
    custom_entities: dict[str, str] = {}
    if options.get('encode_quotes', False):
        custom_entities = {
            "'": "&apos;",
            "\"": "&quot;",
        }

    in_tag = False
    in_comment = False
    in_cdata = False
    in_pi = False  # processing instruction
    result_parts = []
    content_buffer = []
    i = 0
    length = len(xml_string)

    while i < length:
        char = xml_string[i]

        # Check for comment start: <!--
        if not in_comment and not in_cdata and not in_pi and i + 3 < length:
            if xml_string[i:i+4] == '<!--':
                # Flush content buffer
                if content_buffer:
                    content_to_escape = "".join(content_buffer)
                    unescaped_content = unescape(content_to_escape)
                    if custom_entities:
                        escaped_content = saxutils.escape(unescaped_content, custom_entities)
                    else:
                        escaped_content = saxutils.escape(unescaped_content)
                    result_parts.append(escaped_content)
                    content_buffer = []

                in_comment = True
                result_parts.append('<!--')
                i += 4
                continue

        # Check for comment end: -->
        if in_comment and i + 2 < length:
            if xml_string[i:i+3] == '-->':
                in_comment = False
                result_parts.append('-->')
                i += 3
                continue

        # Check for CDATA start: <![CDATA[
        if not in_comment and not in_cdata and not in_pi and i + 8 < length:
            if xml_string[i:i+9] == '<![CDATA[':
                # Flush content buffer
                if content_buffer:
                    content_to_escape = "".join(content_buffer)
                    unescaped_content = unescape(content_to_escape)
                    if custom_entities:
                        escaped_content = saxutils.escape(unescaped_content, custom_entities)
                    else:
                        escaped_content = saxutils.escape(unescaped_content)
                    result_parts.append(escaped_content)
                    content_buffer = []

                in_cdata = True
                result_parts.append('<![CDATA[')
                i += 9
                continue

        # Check for CDATA end: ]]>
        if in_cdata and i + 2 < length:
            if xml_string[i:i+3] == ']]>':
                in_cdata = False
                result_parts.append(']]>')
                i += 3
                continue

        # Check for processing instruction start: <?
        if not in_comment and not in_cdata and not in_pi and i + 1 < length:
            if xml_string[i:i+2] == '<?':
                # Flush content buffer
                if content_buffer:
                    content_to_escape = "".join(content_buffer)
                    unescaped_content = unescape(content_to_escape)
                    if custom_entities:
                        escaped_content = saxutils.escape(unescaped_content, custom_entities)
                    else:
                        escaped_content = saxutils.escape(unescaped_content)
                    result_parts.append(escaped_content)
                    content_buffer = []

                in_pi = True
                result_parts.append('<?')
                i += 2
                continue

        # Check for processing instruction end: ?>
        if in_pi and i + 1 < length:
            if xml_string[i:i+2] == '?>':
                in_pi = False
                result_parts.append('?>')
                i += 2
                continue

        # Handle special sections (comment, CDATA, PI) - pass through unchanged
        if in_comment or in_cdata or in_pi:
            result_parts.append(char)
            i += 1
            continue

        # Normal tag/content handling
        if char == '<':
            # When a '<' is found, the preceding text in the buffer is content.
            # Escape the buffered content and append to the result.
            if content_buffer:
                content_to_escape = "".join(content_buffer)
                # unescape first so that it isn't double-escaped
                unescaped_content = unescape(content_to_escape)
                # Only pass custom_entities if not empty (empty dict overrides defaults)
                if custom_entities:
                    escaped_content = saxutils.escape(unescaped_content, custom_entities)
                else:
                    escaped_content = saxutils.escape(unescaped_content)
                result_parts.append(escaped_content)
                content_buffer = []  # Reset the buffer.

            in_tag = True
            result_parts.append(char)

        elif char == '>':
            # A '>' signifies the end of a tag.
            in_tag = False
            result_parts.append(char)

        else:
            if in_tag:
                # Characters inside a tag are appended directly.
                result_parts.append(char)
            else:
                # Characters outside a tag are content and are buffered for later escaping.
                content_buffer.append(char)

        i += 1

    # After the loop, escape and append any final remaining content from the buffer.
    if content_buffer:
        content_to_escape = "".join(content_buffer)
        # unescape first so that it isn't double-escaped
        unescaped_content = unescape(content_to_escape)
        # Only pass custom_entities if not empty (empty dict overrides defaults)
        if custom_entities:
            escaped_content = saxutils.escape(unescaped_content, custom_entities)
        else:
            escaped_content = saxutils.escape(unescaped_content)
        result_parts.append(escaped_content)

    return "".join(result_parts)
