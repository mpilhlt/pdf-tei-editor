"""
RelaxNG Schema Generation Module.

This module contains the logic for generating RelaxNG schemas from XML documents.
"""

from typing import Dict, Any
from lxml import etree
from collections import defaultdict


def generate_rng_schema(
    xml_content: str,
    variant: str,
    base_url: str,
    options: Dict[str, Any] = None
) -> str:
    """
    Generate RelaxNG schema from XML content.

    Args:
        xml_content: XML content to analyze
        variant: Variant name for schema URL
        base_url: Base URL for validation instructions
        options: Generation options

    Returns:
        RelaxNG schema as XML string
    """
    options = options or {}

    try:
        # Parse the input XML
        root = etree.fromstring(xml_content.encode('utf-8'))

        # Generate schema structure
        schema_analyzer = SchemaAnalyzer(options)
        schema_structure = schema_analyzer.analyze(root)

        # Generate RelaxNG schema
        schema_generator = RelaxNGGenerator(options)
        rng_schema = schema_generator.generate(schema_structure)

        # Format final schema
        return _format_final_schema(rng_schema, options)

    except etree.XMLSyntaxError as e:
        raise RuntimeError(f"Invalid XML syntax: {e}")
    except Exception as e:
        raise RuntimeError(f"Schema generation failed: {e}")


def _format_final_schema(rng_schema: str, options: Dict[str, Any]) -> str:
    """Format the final schema."""
    header = '<?xml version="1.0" encoding="UTF-8"?>'

    # Add RelaxNG schema validation
    relaxng_validation = '<?xml-model href="https://relaxng.org/relaxng.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>'

    return f"{header}\n{relaxng_validation}\n{rng_schema}"


class SchemaAnalyzer:
    """Analyzes XML structure to extract schema patterns."""

    def __init__(self, options: Dict[str, Any]):
        self.options = options
        self.strictness = options.get('schema_strictness', 'balanced')
        self.include_namespaces = options.get('include_namespaces', True)

    def analyze(self, root: etree._Element) -> Dict[str, Any]:
        """Analyze XML structure and return schema patterns."""
        structure = {
            'root_element': root.tag,
            'namespaces': self._extract_namespaces(root) if self.include_namespaces else {},
            'elements': self._analyze_elements(root),
            'attributes': self._analyze_attributes(root)
        }
        return structure

    def _extract_namespaces(self, root: etree._Element) -> Dict[str, str]:
        """Extract namespace declarations from the document."""
        return root.nsmap or {}

    def _analyze_elements(self, element: etree._Element) -> Dict[str, Any]:
        """Analyze element structure recursively."""
        elements = defaultdict(lambda: {
            'children': defaultdict(int),
            'text_content': False,
            'attributes': set(),
            'occurrences': 0
        })

        def traverse(elem, path=""):
            if not hasattr(elem, 'tag') or not isinstance(elem.tag, str):
                return

            tag = elem.tag
            current_path = f"{path}/{tag}" if path else tag

            elements[tag]['occurrences'] += 1

            # Check if element has meaningful text content
            has_meaningful_text = False

            # Collect all text content from the element
            all_text_parts = []
            if elem.text and elem.text.strip():
                all_text_parts.append(elem.text.strip())

            # Also check tail text of children (text after child elements)
            for child in elem:
                if hasattr(child, 'tail') and child.tail and child.tail.strip():
                    all_text_parts.append(child.tail.strip())

            # Determine if there's meaningful text
            for text_part in all_text_parts:
                if text_part:
                    # Check for meaningful text content
                    has_letters = any(c.isalpha() for c in text_part)
                    has_digits = any(c.isdigit() for c in text_part)
                    has_meaningful_chars = any(c.isalnum() or c in '.-_:/' for c in text_part)
                    is_substantial = len(text_part.strip()) > 0

                    # Consider it text content if:
                    # 1. Has letters (words), OR
                    # 2. Has digits with meaningful characters (dates, IDs, page numbers), OR
                    # 3. Any substantial alphanumeric content
                    if is_substantial and (has_letters or
                                         (has_digits and has_meaningful_chars) or
                                         has_meaningful_chars):
                        # Exclude pure whitespace patterns
                        if not all(c in ' \n\t\r' for c in text_part):
                            has_meaningful_text = True
                            break

            if has_meaningful_text:
                elements[tag]['text_content'] = True

            # Collect attributes (safely handle potential Cython functions)
            try:
                if hasattr(elem, 'attrib') and elem.attrib:
                    # Get namespace map from root element for consistent prefix resolution
                    root_nsmap = element.nsmap or {} if hasattr(element, 'nsmap') else {}
                    if 'xml' not in root_nsmap:
                        root_nsmap['xml'] = 'http://www.w3.org/XML/1998/namespace'

                    for attr in elem.attrib:
                        if isinstance(attr, str):
                            # Handle namespace attributes properly
                            if attr.startswith('{'):
                                # Extract namespace URI and local name
                                if '}' in attr:
                                    ns_uri, local_name = attr.split('}', 1)
                                    ns_uri = ns_uri[1:]  # Remove leading {

                                    # Find prefix for this namespace
                                    prefix = None
                                    for p, uri in root_nsmap.items():
                                        if uri == ns_uri:
                                            prefix = p
                                            break

                                    # Use prefixed form if prefix found, otherwise use local name
                                    if prefix:
                                        attr_name = f"{prefix}:{local_name}"
                                    else:
                                        attr_name = local_name
                                else:
                                    attr_name = attr
                            else:
                                attr_name = attr

                            elements[tag]['attributes'].add(attr_name)
            except (TypeError, AttributeError):
                pass

            # Count child elements (safely handle potential Cython functions)
            try:
                for child in elem:
                    if hasattr(child, 'tag') and isinstance(child.tag, str):
                        child_tag = child.tag
                        elements[tag]['children'][child_tag] += 1
                        traverse(child, current_path)
            except (TypeError, AttributeError):
                pass

        traverse(element)
        return dict(elements)

    def _analyze_attributes(self, element: etree._Element) -> Dict[str, set]:
        """Analyze attribute patterns, preserving namespace prefixes."""
        attributes = defaultdict(set)
        namespace_map = element.nsmap or {}
        # Add standard xml namespace if not present
        if 'xml' not in namespace_map:
            namespace_map['xml'] = 'http://www.w3.org/XML/1998/namespace'

        def traverse(elem):
            try:
                if hasattr(elem, 'attrib') and elem.attrib:
                    for attr, value in elem.attrib.items():
                        if isinstance(attr, str) and isinstance(value, str):
                            # Handle namespace-prefixed attributes
                            if attr.startswith('{'):
                                # Extract namespace URI and local name
                                if '}' in attr:
                                    ns_uri, local_name = attr.split('}', 1)
                                    ns_uri = ns_uri[1:]  # Remove leading {

                                    # Find prefix for this namespace
                                    prefix = None
                                    for p, uri in namespace_map.items():
                                        if uri == ns_uri:
                                            prefix = p
                                            break

                                    # Use prefixed form if prefix found, otherwise use local name
                                    if prefix:
                                        attr_name = f"{prefix}:{local_name}"
                                    else:
                                        attr_name = local_name
                                else:
                                    attr_name = attr
                            else:
                                attr_name = attr

                            attributes[attr_name].add(value)
            except (TypeError, AttributeError):
                pass

            try:
                for child in elem:
                    if hasattr(child, 'tag'):
                        traverse(child)
            except (TypeError, AttributeError):
                pass

        traverse(element)
        return {k: v for k, v in attributes.items()}


class RelaxNGGenerator:
    """Generates RelaxNG schema from analyzed structure."""

    def __init__(self, options: Dict[str, Any]):
        self.options = options
        self.strictness = options.get('schema_strictness', 'balanced')

    def generate(self, structure: Dict[str, Any]) -> str:
        """Generate RelaxNG schema from structure analysis."""
        rng_parts = []

        # Start grammar
        rng_parts.append('<grammar xmlns="http://relaxng.org/ns/structure/1.0"')

        # Collect all namespace prefixes used in attributes to ensure they're declared
        used_prefixes = set()
        for element_info in structure['elements'].values():
            for attr in element_info.get('attributes', []):
                if isinstance(attr, str) and ':' in attr:
                    prefix = attr.split(':', 1)[0]
                    used_prefixes.add(prefix)

        # Add namespace declarations
        # Ensure xml namespace is always declared for xml:id and other xml: attributes
        xml_namespace_declared = False
        for prefix, uri in structure['namespaces'].items():
            if prefix:  # Skip default namespace for now
                rng_parts.append(f'  xmlns:{prefix}="{uri}"')
                if prefix == 'xml':
                    xml_namespace_declared = True

        # Always include xml namespace if not already declared (for xml:id, xml:lang, etc.)
        if not xml_namespace_declared and 'xml' in used_prefixes:
            rng_parts.append('  xmlns:xml="http://www.w3.org/XML/1998/namespace"')

        # Set default namespace if TEI
        if 'http://www.tei-c.org/ns/1.0' in structure['namespaces'].values():
            rng_parts.append('  ns="http://www.tei-c.org/ns/1.0"')

        rng_parts.append('>')

        # Generate start pattern
        root_element = structure['root_element']
        # Remove namespace prefix for local name
        local_name = root_element.split('}')[-1] if '}' in root_element else root_element
        rng_parts.append(f'  <start>')
        rng_parts.append(f'    <ref name="{local_name}"/>')
        rng_parts.append(f'  </start>')

        # Generate element definitions
        rng_parts.extend(self._generate_element_definitions(structure['elements']))

        rng_parts.append('</grammar>')

        return '\n'.join(rng_parts)

    def _generate_element_definitions(self, elements: Dict[str, Any]) -> list:
        """Generate element definitions for the schema."""
        definitions = []

        for element_name, element_info in elements.items():
            # Remove namespace prefix for local name
            local_name = element_name.split('}')[-1] if '}' in element_name else element_name

            definitions.append(f'  <define name="{local_name}">')
            definitions.append(f'    <element name="{local_name}">')

            # Add attributes if any
            if element_info['attributes']:
                # Ensure all attributes are strings before sorting
                str_attributes = [str(attr) for attr in element_info['attributes'] if attr is not None]
                for attr in sorted(str_attributes):
                    # Handle namespace-prefixed attributes
                    if ':' in attr:
                        # Split prefix and local name
                        prefix, local_name = attr.split(':', 1)
                        # Use the namespace URI directly for xml namespace
                        if prefix == 'xml':
                            attr_element = f'<attribute name="{local_name}" ns="http://www.w3.org/XML/1998/namespace"/>'
                        else:
                            # For other namespaces, use the prefix (assuming it's declared in grammar)
                            attr_element = f'<attribute name="{attr}"/>'
                    else:
                        attr_element = f'<attribute name="{attr}"/>'

                    # Make attributes optional in balanced/permissive mode
                    if self.strictness in ['balanced', 'permissive']:
                        definitions.append(f'      <optional>')
                        definitions.append(f'        {attr_element}')
                        definitions.append(f'      </optional>')
                    else:
                        definitions.append(f'      {attr_element}')

            # Add content model with improved logic
            has_children = bool(element_info['children'])
            has_text = element_info.get('text_content', False)

            if has_children or has_text:
                if has_text and has_children:
                    # True mixed content - text and elements can be interleaved
                    definitions.append('      <interleave>')
                    definitions.append('        <text/>')
                    # Ensure all child keys are strings before sorting
                    str_children = [str(child) for child in element_info['children'].keys() if child is not None]
                    for child in sorted(str_children):
                        child_local = child.split('}')[-1] if '}' in child else child
                        definitions.append(f'        <zeroOrMore>')
                        definitions.append(f'          <ref name="{child_local}"/>')
                        definitions.append(f'        </zeroOrMore>')
                    definitions.append('      </interleave>')
                elif has_children:
                    # Element content only - use structured patterns
                    str_children = [str(child) for child in element_info['children'].keys() if child is not None]

                    if len(str_children) == 1:
                        # Single child type - simple pattern
                        child = str_children[0]
                        child_local = child.split('}')[-1] if '}' in child else child
                        definitions.append(f'      <zeroOrMore>')
                        definitions.append(f'        <ref name="{child_local}"/>')
                        definitions.append(f'      </zeroOrMore>')
                    else:
                        # Multiple child types - use choice pattern instead of interleave
                        # This is more restrictive but more accurate for most XML structures
                        definitions.append('      <zeroOrMore>')
                        definitions.append('        <choice>')
                        for child in sorted(str_children):
                            child_local = child.split('}')[-1] if '}' in child else child
                            definitions.append(f'          <ref name="{child_local}"/>')
                        definitions.append('        </choice>')
                        definitions.append('      </zeroOrMore>')
                else:
                    # Text content only
                    definitions.append('      <text/>')
            else:
                # Empty element
                definitions.append('      <empty/>')

            definitions.append('    </element>')
            definitions.append('  </define>')
            definitions.append('')  # Add blank line for readability

        return definitions
