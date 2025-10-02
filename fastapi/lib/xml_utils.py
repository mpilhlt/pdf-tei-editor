import xml.sax.saxutils as saxutils
from html import unescape

def encode_xml_entities(xml_string: str) -> str:
    """
    Escapes special characters in XML content using a manual string-parsing
    approach, but delegates the actual escaping logic to xml.sax.saxutils.escape.

    This function iterates through the string, keeping track of whether the
    current position is inside a tag or in the content between tags.

    Args:
      xml_string: The raw XML string to be processed.

    Returns:
      A new XML string with its node content properly escaped.
    """

    # Define the entities that need escaping in addition to the defaults (&, <, >).
    # saxutils.escape will handle these correctly.
    custom_entities: dict[str, str] = {
        "'": "&apos;",
        "\"": "&quot;",
    }

    in_tag = False
    result_parts = []
    content_buffer = []

    for char in xml_string:
        if char == '<':
            # When a '<' is found, the preceding text in the buffer is content.
            # Escape the buffered content and append to the result.
            if content_buffer:
                content_to_escape = "".join(content_buffer)
                # unescape first so that it isn't double-escaped
                unescaped_content = unescape(content_to_escape)
                escaped_content = saxutils.escape(unescaped_content, custom_entities)
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

    # After the loop, escape and append any final remaining content from the buffer.
    if content_buffer:
        content_to_escape = "".join(content_buffer)
        # unescape first so that it isn't double-escaped
        unescaped_content = unescape(content_to_escape)
        escaped_content = saxutils.escape(unescaped_content, custom_entities)
        result_parts.append(escaped_content)

    return "".join(result_parts)