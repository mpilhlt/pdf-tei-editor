"""
Unit tests for RNG Generator Module.
"""

import unittest
from fastapi_app.plugins.rng_converter.rng_generator import (
    generate_rng_schema,
    SchemaAnalyzer,
    RelaxNGGenerator
)


class TestRngGenerator(unittest.TestCase):
    """Test RNG schema generation functionality."""

    def setUp(self):
        """Set up test fixtures."""
        self.sample_tei = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test Document</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <p>Sample content.</p>
    </body>
  </text>
</TEI>"""

    def test_generate_rng_schema(self):
        """Test RNG schema generation from TEI XML."""
        rng_schema = generate_rng_schema(
            xml_content=self.sample_tei,
            variant="test-variant",
            base_url="http://localhost:8000",
            options={
                "schema_strictness": "balanced",
                "include_namespaces": True,
                "add_documentation": True
            }
        )

        # Check basic structure
        self.assertIn('<grammar', rng_schema)
        self.assertIn('http://relaxng.org/ns/structure/1.0', rng_schema)
        self.assertIn('<start>', rng_schema)
        self.assertIn('TEI', rng_schema)
        self.assertIn('<?xml-model', rng_schema)

    def test_schema_analyzer(self):
        """Test SchemaAnalyzer functionality."""
        from lxml import etree

        root = etree.fromstring(self.sample_tei.encode('utf-8'))
        analyzer = SchemaAnalyzer({
            "schema_strictness": "balanced",
            "include_namespaces": True
        })

        structure = analyzer.analyze(root)

        # Check structure
        self.assertIn('root_element', structure)
        self.assertIn('namespaces', structure)
        self.assertIn('elements', structure)
        self.assertIn('attributes', structure)

        # Check elements were found
        self.assertGreater(len(structure['elements']), 0)

    def test_relaxng_generator(self):
        """Test RelaxNGGenerator functionality."""
        from lxml import etree

        root = etree.fromstring(self.sample_tei.encode('utf-8'))
        analyzer = SchemaAnalyzer({"schema_strictness": "balanced"})
        structure = analyzer.analyze(root)

        generator = RelaxNGGenerator({"schema_strictness": "balanced"})
        rng_schema = generator.generate(structure)

        # Check generated schema
        self.assertIn('<grammar', rng_schema)
        self.assertIn('<start>', rng_schema)
        self.assertIn('<define', rng_schema)

    def test_invalid_xml(self):
        """Test handling of invalid XML."""
        with self.assertRaises(RuntimeError) as cm:
            generate_rng_schema(
                xml_content="<invalid>unclosed",
                variant="test",
                base_url="http://localhost:8000"
            )
        self.assertIn("Invalid XML syntax", str(cm.exception))

    def test_strictness_levels(self):
        """Test different strictness levels."""
        for strictness in ["strict", "balanced", "permissive"]:
            rng_schema = generate_rng_schema(
                xml_content=self.sample_tei,
                variant="test",
                base_url="http://localhost:8000",
                options={"schema_strictness": strictness}
            )
            self.assertIn('<grammar', rng_schema)


if __name__ == "__main__":
    unittest.main()
