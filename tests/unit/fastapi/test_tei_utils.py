"""
Unit tests for TEI utilities.
"""

import unittest
import tempfile
import json
from pathlib import Path
from lxml import etree
from fastapi_app.lib.tei_utils import (
    serialize_tei_with_formatted_header,
    create_schema_processing_instruction,
    create_tei_header,
    extract_tei_metadata
)


class TestSerializeTeiWithFormattedHeader(unittest.TestCase):
    """Test serialize_tei_with_formatted_header function."""

    def test_preserves_processing_instructions(self):
        """Test that processing instructions are preserved during serialization."""
        # Create a simple TEI document
        tei_xml = """<?xml version="1.0"?>
<?xml-model href="https://example.com/schema.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>
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
      <p>Test content</p>
    </body>
  </text>
</TEI>"""

        # Parse the XML
        xml_root = etree.fromstring(tei_xml.encode('utf-8'))

        # Extract processing instructions manually (simulating what _extract_processing_instructions does)
        processing_instructions = [
            '<?xml-model href="https://example.com/schema.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>'
        ]

        # Serialize with processing instructions
        result = serialize_tei_with_formatted_header(xml_root, processing_instructions)

        # Verify processing instruction is preserved
        self.assertIn('<?xml-model', result)
        self.assertIn('https://example.com/schema.rng', result)

    def test_preserves_multiple_processing_instructions(self):
        """Test that multiple processing instructions are preserved."""
        tei_xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
</TEI>"""

        xml_root = etree.fromstring(tei_xml.encode('utf-8'))

        processing_instructions = [
            '<?xml-model href="schema1.rng" type="application/xml"?>',
            '<?xml-stylesheet href="style.xsl" type="text/xsl"?>'
        ]

        result = serialize_tei_with_formatted_header(xml_root, processing_instructions)

        # Both PIs should be present
        self.assertIn('schema1.rng', result)
        self.assertIn('style.xsl', result)

        # PIs should come before the TEI element
        pi1_pos = result.find('<?xml-model')
        pi2_pos = result.find('<?xml-stylesheet')
        tei_pos = result.find('<TEI')

        self.assertLess(pi1_pos, tei_pos, "Processing instructions should come before TEI element")
        self.assertLess(pi2_pos, tei_pos, "Processing instructions should come before TEI element")

    def test_works_without_processing_instructions(self):
        """Test that serialization works when no processing instructions are provided."""
        tei_xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
</TEI>"""

        xml_root = etree.fromstring(tei_xml.encode('utf-8'))

        # No processing instructions
        result = serialize_tei_with_formatted_header(xml_root)

        # Should still serialize correctly
        self.assertIn('<TEI', result)
        self.assertIn('<teiHeader>', result)
        self.assertIn('Test', result)

    def test_does_not_include_xml_declaration(self):
        """Test that XML declaration is not included in output."""
        tei_xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
</TEI>"""

        xml_root = etree.fromstring(tei_xml.encode('utf-8'))
        result = serialize_tei_with_formatted_header(xml_root)

        # XML declaration should NOT be present
        self.assertNotIn('<?xml version=', result)

    def test_preserves_text_element_formatting(self):
        """Test that text elements maintain their original formatting."""
        tei_xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <p>Line1
Line2</p>
    </body>
  </text>
</TEI>"""

        xml_root = etree.fromstring(tei_xml.encode('utf-8'))
        result = serialize_tei_with_formatted_header(xml_root)

        # Text content should be preserved
        self.assertIn('Line1', result)
        self.assertIn('Line2', result)


class TestProcessingInstructionsExtraction(unittest.TestCase):
    """Test processing instruction extraction from tei_utils."""

    def test_extract_processing_instructions(self):
        """Test extraction of processing instructions from XML string."""
        from fastapi_app.lib.tei_utils import extract_processing_instructions

        xml_string = """<?xml version="1.0"?>
<?xml-model href="https://example.com/schema.rng" type="application/xml"?>
<?xml-stylesheet href="style.xsl" type="text/xsl"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test</title>
      </titleStmt>
    </fileDesc>
  </teiHeader>
</TEI>"""

        pis = extract_processing_instructions(xml_string)

        # Should extract 2 PIs (not the xml declaration)
        self.assertEqual(len(pis), 2)
        self.assertIn('xml-model', pis[0])
        self.assertIn('xml-stylesheet', pis[1])

    def test_does_not_extract_xml_declaration(self):
        """Test that XML declaration is not extracted as a processing instruction."""
        from fastapi_app.lib.tei_utils import extract_processing_instructions

        xml_string = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader/>
</TEI>"""

        pis = extract_processing_instructions(xml_string)

        # Should be empty - xml declaration is not a processing instruction
        self.assertEqual(len(pis), 0)

    def test_grobid_training_schema_extraction(self):
        """Test extraction of grobid training schema processing instruction."""
        from fastapi_app.lib.tei_utils import extract_processing_instructions

        xml_string = """<?xml version="1.0"?>
<?xml-model href="https://mpilhlt.github.io/grobid-footnote-flavour/schema/grobid.training.segmentation.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader/>
</TEI>"""

        pis = extract_processing_instructions(xml_string)

        self.assertEqual(len(pis), 1)
        self.assertIn('grobid.training.segmentation.rng', pis[0])
        self.assertIn('http://relaxng.org/ns/structure/1.0', pis[0])


class TestCreateSchemaProcessingInstruction(unittest.TestCase):
    """Test create_schema_processing_instruction function."""

    def test_creates_correct_processing_instruction(self):
        """Test that the function creates a valid processing instruction."""
        schema_url = "https://mpilhlt.github.io/grobid-footnote-flavour/schema/grobid.training.segmentation.rng"
        result = create_schema_processing_instruction(schema_url)

        expected = '<?xml-model href="https://mpilhlt.github.io/grobid-footnote-flavour/schema/grobid.training.segmentation.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>'
        self.assertEqual(result, expected)

    def test_works_with_llamore_schema(self):
        """Test that it works with llamore schema URLs."""
        schema_url = "https://mpilhlt.github.io/llamore/schema/llamore.rng"
        result = create_schema_processing_instruction(schema_url)

        self.assertIn("llamore.rng", result)
        self.assertIn('type="application/xml"', result)
        self.assertIn('schematypens="http://relaxng.org/ns/structure/1.0"', result)

    def test_works_with_mock_schema(self):
        """Test that it works with mock extractor schema URLs."""
        schema_url = "https://example.com/schema/mock-default.rng"
        result = create_schema_processing_instruction(schema_url)

        self.assertIn("mock-default.rng", result)
        self.assertIn('type="application/xml"', result)


class TestGetFileIdFromOptions(unittest.TestCase):
    """Test get_file_id_from_options function."""

    def test_encodes_doi_slash(self):
        """Test that a DOI slash is encoded to double underscore."""
        from fastapi_app.lib.tei_utils import get_file_id_from_options

        result = get_file_id_from_options({'doc_id': '10.1234/example'})
        self.assertEqual(result, '10.1234__example')

    def test_encodes_special_characters(self):
        """Test that filesystem-unsafe characters are encoded."""
        from fastapi_app.lib.tei_utils import get_file_id_from_options

        result = get_file_id_from_options({'doc_id': '10.1234/test:file'})
        self.assertEqual(result, '10.1234__test$3A$file')

    def test_does_not_double_encode(self):
        """Test that an already-encoded doc_id is returned unchanged."""
        from fastapi_app.lib.tei_utils import get_file_id_from_options

        result = get_file_id_from_options({'doc_id': '10.1234__example'})
        self.assertEqual(result, '10.1234__example')

    def test_simple_doc_id_unchanged(self):
        """Test that a doc_id without special characters is unchanged."""
        from fastapi_app.lib.tei_utils import get_file_id_from_options

        result = get_file_id_from_options({'doc_id': 'my-document'})
        self.assertEqual(result, 'my-document')

    def test_fallback_to_pdf_path(self):
        """Test fallback to PDF basename when no doc_id."""
        from fastapi_app.lib.tei_utils import get_file_id_from_options

        result = get_file_id_from_options({}, '/path/to/document.pdf')
        self.assertEqual(result, 'document')

    def test_empty_options_no_pdf(self):
        """Test returns empty string when no doc_id and no pdf_path."""
        from fastapi_app.lib.tei_utils import get_file_id_from_options

        result = get_file_id_from_options({})
        self.assertEqual(result, '')

    def test_doc_id_takes_precedence_over_pdf_path(self):
        """Test that doc_id is used even when pdf_path is provided."""
        from fastapi_app.lib.tei_utils import get_file_id_from_options

        result = get_file_id_from_options(
            {'doc_id': '10.1234/example'},
            '/path/to/other.pdf'
        )
        self.assertEqual(result, '10.1234__example')


class TestExtractChangeSignatures(unittest.TestCase):
    """Test extract_change_signatures function."""

    def test_extract_change_signatures(self):
        """Test extraction of change signatures from TEI XML."""
        from fastapi_app.lib.tei_utils import extract_change_signatures

        xml_content = b"""<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <revisionDesc>
      <change when="2024-01-01" who="#user1" status="created">First</change>
      <change when="2024-01-02" who="#user2" status="updated">Second</change>
    </revisionDesc>
  </teiHeader>
</TEI>"""

        signatures = extract_change_signatures(xml_content)

        self.assertEqual(len(signatures), 2)
        self.assertEqual(signatures[0], ("#user1", "2024-01-01", "created"))
        self.assertEqual(signatures[1], ("#user2", "2024-01-02", "updated"))

    def test_extract_change_signatures_empty(self):
        """Test extraction with no change elements."""
        from fastapi_app.lib.tei_utils import extract_change_signatures

        xml_content = b"""<?xml version="1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <revisionDesc/>
  </teiHeader>
</TEI>"""

        signatures = extract_change_signatures(xml_content)
        self.assertEqual(len(signatures), 0)


class TestBuildVersionAncestryChains(unittest.TestCase):
    """Test build_version_ancestry_chains function."""

    def test_build_version_ancestry_chains_linear(self):
        """Test building ancestry chains for linear version history."""
        from fastapi_app.lib.tei_utils import build_version_ancestry_chains

        # Version A (1 change) -> B (2 changes, extends A) -> C (3 changes, extends B)
        versions = [
            {
                "annotation_label": "Version A",
                "stable_id": "id-a",
                "change_signatures": [("user1", "2024-01-01", "created")],
            },
            {
                "annotation_label": "Version B",
                "stable_id": "id-b",
                "change_signatures": [
                    ("user1", "2024-01-01", "created"),
                    ("user1", "2024-01-02", "updated"),
                ],
            },
            {
                "annotation_label": "Version C",
                "stable_id": "id-c",
                "change_signatures": [
                    ("user1", "2024-01-01", "created"),
                    ("user1", "2024-01-02", "updated"),
                    ("user1", "2024-01-03", "reviewed"),
                ],
            },
        ]

        chains = build_version_ancestry_chains(versions)

        # Should have one chain: A -> B -> C
        self.assertEqual(len(chains), 1)
        self.assertEqual(len(chains[0]), 3)
        self.assertEqual(chains[0][0]["stable_id"], "id-a")
        self.assertEqual(chains[0][1]["stable_id"], "id-b")
        self.assertEqual(chains[0][2]["stable_id"], "id-c")

    def test_build_version_ancestry_chains_branching(self):
        """Test building ancestry chains for branching version history."""
        from fastapi_app.lib.tei_utils import build_version_ancestry_chains

        # Version A (1 change) -> B (2 changes, extends A)
        # Version A (1 change) -> D (2 changes, extends A but different from B)
        versions = [
            {
                "annotation_label": "Version A",
                "stable_id": "id-a",
                "change_signatures": [("user1", "2024-01-01", "created")],
            },
            {
                "annotation_label": "Version B",
                "stable_id": "id-b",
                "change_signatures": [
                    ("user1", "2024-01-01", "created"),
                    ("user1", "2024-01-02", "updated"),
                ],
            },
            {
                "annotation_label": "Version D",
                "stable_id": "id-d",
                "change_signatures": [
                    ("user1", "2024-01-01", "created"),
                    ("user2", "2024-01-02", "edited"),  # Different second change
                ],
            },
        ]

        chains = build_version_ancestry_chains(versions)

        # Should have two chains: A -> B and A -> D
        self.assertEqual(len(chains), 2)

        # Both chains should start with A
        chain_starts = [c[0]["stable_id"] for c in chains]
        self.assertEqual(chain_starts, ["id-a", "id-a"])

        # Check chain ends
        chain_ends = [c[-1]["stable_id"] for c in chains]
        self.assertIn("id-b", chain_ends)
        self.assertIn("id-d", chain_ends)

    def test_build_version_ancestry_chains_independent(self):
        """Test building ancestry chains for independent versions."""
        from fastapi_app.lib.tei_utils import build_version_ancestry_chains

        # Two independent versions with no common ancestor
        versions = [
            {
                "annotation_label": "Version X",
                "stable_id": "id-x",
                "change_signatures": [("user1", "2024-01-01", "created")],
            },
            {
                "annotation_label": "Version Y",
                "stable_id": "id-y",
                "change_signatures": [("user2", "2024-02-01", "created")],
            },
        ]

        chains = build_version_ancestry_chains(versions)

        # Should have two separate chains
        self.assertEqual(len(chains), 2)
        self.assertEqual(len(chains[0]), 1)
        self.assertEqual(len(chains[1]), 1)

    def test_build_version_ancestry_chains_empty(self):
        """Test building ancestry chains with empty input."""
        from fastapi_app.lib.tei_utils import build_version_ancestry_chains

        chains = build_version_ancestry_chains([])
        self.assertEqual(len(chains), 0)


class TestCreateTeiHeaderUrl(unittest.TestCase):
    """Test url field handling in create_tei_header."""

    def _find_idno(self, header, id_type):
        """Find an idno element by type attribute in the header."""
        pub_stmt = header.find("fileDesc/publicationStmt")
        for idno in pub_stmt.findall("idno"):
            if idno.get("type") == id_type:
                return idno
        return None

    def _find_ptr(self, header):
        """Find the ptr element in publicationStmt."""
        pub_stmt = header.find("fileDesc/publicationStmt")
        return pub_stmt.find("ptr")

    def test_url_written_to_publication_stmt(self):
        """url in metadata produces <ptr target="..."/> in publicationStmt."""
        header = create_tei_header(metadata={"url": "https://www.jstor.org/stable/44290231"})
        ptr = self._find_ptr(header)
        self.assertIsNotNone(ptr)
        self.assertEqual(ptr.get("target"), "https://www.jstor.org/stable/44290231")

    def test_url_and_doi_coexist(self):
        """DOI idno and ptr are siblings, not mutually exclusive."""
        header = create_tei_header(
            doi="10.5771/2699-1284-2024-3-149",
            metadata={"url": "https://doi.org/10.5771/2699-1284-2024-3-149"}
        )
        doi_idno = self._find_idno(header, "DOI")
        ptr = self._find_ptr(header)
        self.assertIsNotNone(doi_idno, "DOI idno should be present")
        self.assertIsNotNone(ptr, "ptr should be present alongside DOI")
        self.assertEqual(doi_idno.text, "10.5771/2699-1284-2024-3-149")
        self.assertEqual(ptr.get("target"), "https://doi.org/10.5771/2699-1284-2024-3-149")

    def test_url_and_generic_id_coexist(self):
        """Generic id idno and ptr are siblings."""
        header = create_tei_header(metadata={
            "id": "jstor:44290231",
            "url": "https://www.jstor.org/stable/44290231"
        })
        jstor_idno = self._find_idno(header, "jstor")
        ptr = self._find_ptr(header)
        self.assertIsNotNone(jstor_idno)
        self.assertEqual(jstor_idno.text, "44290231")
        self.assertIsNotNone(ptr)
        self.assertEqual(ptr.get("target"), "https://www.jstor.org/stable/44290231")

    def test_url_absent_produces_no_ptr(self):
        """No url in metadata means no <ptr> element."""
        header = create_tei_header(doi="10.1234/test", metadata={"title": "Test"})
        ptr = self._find_ptr(header)
        self.assertIsNone(ptr)

    def test_url_empty_string_produces_no_ptr(self):
        """Empty string url is treated as absent."""
        header = create_tei_header(metadata={"url": ""})
        ptr = self._find_ptr(header)
        self.assertIsNone(ptr)


class TestExtractTeiMetadataUrl(unittest.TestCase):
    """Test url extraction in extract_tei_metadata."""

    def _make_tei(self, pub_stmt_extra=""):
        """Build a minimal TEI XML string with optional extra content in publicationStmt."""
        return f"""
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <fileDesc>
                    <titleStmt>
                        <title level="a">Test</title>
                    </titleStmt>
                    <publicationStmt>
                        <publisher>Test Publisher</publisher>
                        <date type="publication">2024</date>
                        {pub_stmt_extra}
                    </publicationStmt>
                    <sourceDesc><bibl>Test</bibl></sourceDesc>
                </fileDesc>
            </teiHeader>
        </TEI>
        """

    def test_extracts_url_from_publication_stmt(self):
        """extract_tei_metadata reads <ptr target="..."/> into url and doc_metadata."""
        tei_xml = self._make_tei(
            '<ptr target="https://www.jstor.org/stable/44290231"/>'
        )
        root = etree.fromstring(tei_xml.encode('utf-8'))
        result = extract_tei_metadata(root)

        self.assertEqual(result.get('url'), "https://www.jstor.org/stable/44290231")
        self.assertEqual(result['doc_metadata']['url'], "https://www.jstor.org/stable/44290231")

    def test_url_absent_returns_no_url_key(self):
        """No <ptr> means url is absent from result."""
        tei_xml = self._make_tei('<idno type="DOI">10.1234/test</idno>')
        root = etree.fromstring(tei_xml.encode('utf-8'))
        result = extract_tei_metadata(root)

        self.assertIsNone(result.get('url'))
        self.assertNotIn('url', result.get('doc_metadata', {}))

    def test_url_round_trips_with_doi(self):
        """Both DOI and url are extracted independently."""
        tei_xml = self._make_tei(
            '<idno type="DOI">10.1234/test</idno>\n'
            '                        <ptr target="https://example.com/article/1"/>'
        )
        root = etree.fromstring(tei_xml.encode('utf-8'))
        result = extract_tei_metadata(root)

        self.assertEqual(result.get('url'), "https://example.com/article/1")
        self.assertEqual(result['doc_metadata']['url'], "https://example.com/article/1")


if __name__ == '__main__':
    unittest.main()
