import xml.sax.saxutils

def encode_xml_entities(xml_string, custom_entities=None):
  """
  Encodes special characters in an XML string.

  This function encodes the standard XML entities: '&', '<', and '>'.
  It can also encode an optional list of custom UTF-8 characters.

  Args:
    xml_string: The XML string to encode.
    custom_entities: An optional list of UTF-8 characters to encode
      as XML numeric character references.

  Returns:
    The XML string with specified characters encoded.
  """
  if custom_entities:
    # Create a dictionary for custom entities, mapping each character
    # to its XML numeric character reference.
    entities = {char: f"&#{ord(char)};" for char in custom_entities}
  else:
    entities = {}

  # The escape function handles the standard XML entities and any
  # additional entities provided in the dictionary.
  return xml.sax.saxutils.escape(xml_string, entities)