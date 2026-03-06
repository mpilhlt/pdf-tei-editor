"""
Unit tests for TEI utilities.
"""

import unittest
import tempfile
import json
from pathlib import Path
from lxml import etree
from fastapi_app.lib.utils.tei_utils import (
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
        from fastapi_app.lib.utils.tei_utils import extract_processing_instructions

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
        from fastapi_app.lib.utils.tei_utils import extract_processing_instructions

        xml_string = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader/>
</TEI>"""

        pis = extract_processing_instructions(xml_string)

        # Should be empty - xml declaration is not a processing instruction
        self.assertEqual(len(pis), 0)

    def test_grobid_training_schema_extraction(self):
        """Test extraction of grobid training schema processing instruction."""
        from fastapi_app.lib.utils.tei_utils import extract_processing_instructions

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
        from fastapi_app.lib.utils.tei_utils import get_file_id_from_options

        result = get_file_id_from_options({'doc_id': '10.1234/example'})
        self.assertEqual(result, '10.1234__example')

    def test_encodes_special_characters(self):
        """Test that filesystem-unsafe characters are encoded."""
        from fastapi_app.lib.utils.tei_utils import get_file_id_from_options

        result = get_file_id_from_options({'doc_id': '10.1234/test:file'})
        self.assertEqual(result, '10.1234__test$3A$file')

    def test_does_not_double_encode(self):
        """Test that an already-encoded doc_id is returned unchanged."""
        from fastapi_app.lib.utils.tei_utils import get_file_id_from_options

        result = get_file_id_from_options({'doc_id': '10.1234__example'})
        self.assertEqual(result, '10.1234__example')

    def test_simple_doc_id_unchanged(self):
        """Test that a doc_id without special characters is unchanged."""
        from fastapi_app.lib.utils.tei_utils import get_file_id_from_options

        result = get_file_id_from_options({'doc_id': 'my-document'})
        self.assertEqual(result, 'my-document')

    def test_fallback_to_pdf_path(self):
        """Test fallback to PDF basename when no doc_id."""
        from fastapi_app.lib.utils.tei_utils import get_file_id_from_options

        result = get_file_id_from_options({}, '/path/to/document.pdf')
        self.assertEqual(result, 'document')

    def test_empty_options_no_pdf(self):
        """Test returns empty string when no doc_id and no pdf_path."""
        from fastapi_app.lib.utils.tei_utils import get_file_id_from_options

        result = get_file_id_from_options({})
        self.assertEqual(result, '')

    def test_doc_id_takes_precedence_over_pdf_path(self):
        """Test that doc_id is used even when pdf_path is provided."""
        from fastapi_app.lib.utils.tei_utils import get_file_id_from_options

        result = get_file_id_from_options(
            {'doc_id': '10.1234/example'},
            '/path/to/other.pdf'
        )
        self.assertEqual(result, '10.1234__example')


class TestExtractChangeSignatures(unittest.TestCase):
    """Test extract_change_signatures function."""

    def test_extract_change_signatures(self):
        """Test extraction of change signatures from TEI XML."""
        from fastapi_app.lib.utils.tei_utils import extract_change_signatures

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
        from fastapi_app.lib.utils.tei_utils import extract_change_signatures

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
        from fastapi_app.lib.utils.tei_utils import build_version_ancestry_chains

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
        from fastapi_app.lib.utils.tei_utils import build_version_ancestry_chains

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
        from fastapi_app.lib.utils.tei_utils import build_version_ancestry_chains

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
        from fastapi_app.lib.utils.tei_utils import build_version_ancestry_chains

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


class TestCreateEncodingDescWithExtractor(unittest.TestCase):
    """Test create_encoding_desc_with_extractor function."""

    def _get_extractor_app(self, encoding_desc):
        """Find the extractor application element."""
        app_info = encoding_desc.find("appInfo")
        for app in app_info.findall("application"):
            if app.get("type") == "extractor":
                return app
        return None

    def test_single_ref(self):
        """Test that a single ref element is created with target only."""
        from fastapi_app.lib.utils.tei_utils import create_encoding_desc_with_extractor

        result = create_encoding_desc_with_extractor(
            timestamp="2024-01-15T10:30:00Z",
            extractor_name="Test",
            extractor_ident="test",
            refs=["https://example.com/schema/test.rng"],
        )
        app = self._get_extractor_app(result)
        refs = app.findall("ref")
        self.assertEqual(len(refs), 1)
        self.assertEqual(refs[0].get("target"), "https://example.com/schema/test.rng")
        self.assertIsNone(refs[0].get("subtype"))
        self.assertIsNone(refs[0].get("type"))

    def test_multiple_refs(self):
        """Test that multiple refs are added in order."""
        from fastapi_app.lib.utils.tei_utils import create_encoding_desc_with_extractor

        result = create_encoding_desc_with_extractor(
            timestamp="2024-01-15T10:30:00Z",
            extractor_name="Test",
            extractor_ident="test",
            refs=[
                "https://github.com/example/repo",
                "https://example.com/schema/test.rng",
            ],
        )
        app = self._get_extractor_app(result)
        refs = app.findall("ref")
        self.assertEqual(len(refs), 2)
        self.assertEqual(refs[0].get("target"), "https://github.com/example/repo")
        self.assertEqual(refs[1].get("target"), "https://example.com/schema/test.rng")

    def test_no_refs(self):
        """Test that no ref elements are created when refs is None."""
        from fastapi_app.lib.utils.tei_utils import create_encoding_desc_with_extractor

        result = create_encoding_desc_with_extractor(
            timestamp="2024-01-15T10:30:00Z",
            extractor_name="Test",
            extractor_ident="test",
        )
        app = self._get_extractor_app(result)
        refs = app.findall("ref")
        self.assertEqual(len(refs), 0)


class TestBiblStructCreation(unittest.TestCase):
    """Test biblStruct creation in create_tei_header."""

    def test_creates_biblstruct_with_complete_metadata(self):
        """Test that biblStruct is created with all journal metadata fields."""
        metadata = {
            "title": "Test Article",
            "authors": [
                {"given": "John", "family": "Doe"},
                {"given": "Jane", "family": "Smith"}
            ],
            "date": "2024",
            "publisher": "Test Publisher",
            "journal": "Test Journal",
            "volume": "123",
            "issue": "4",
            "pages": "1-15",
            "url": "https://example.com/article"
        }

        header = create_tei_header(doi="10.1234/test", metadata=metadata)

        # Verify biblStruct exists (no namespace - create_tei_header creates elements without namespace)
        sourceDesc = header.find(".//sourceDesc")
        self.assertIsNotNone(sourceDesc)
        biblStruct = sourceDesc.find("biblStruct")
        self.assertIsNotNone(biblStruct, "biblStruct should be created")

        # Verify analytic section
        analytic = biblStruct.find("analytic")
        title_elem = analytic.find('title[@level="a"]')
        self.assertIsNotNone(title_elem)
        self.assertEqual(title_elem.text, "Test Article")

        authors = analytic.findall('author')
        self.assertEqual(len(authors), 2)

        # Verify monograph section
        monogr = biblStruct.find("monogr")
        journal_elem = monogr.find('title[@level="j"]')
        self.assertIsNotNone(journal_elem)
        self.assertEqual(journal_elem.text, "Test Journal")

        # Verify imprint details
        imprint = monogr.find("imprint")
        volume_elem = imprint.find('biblScope[@unit="volume"]')
        self.assertEqual(volume_elem.text, "123")

        issue_elem = imprint.find('biblScope[@unit="issue"]')
        self.assertEqual(issue_elem.text, "4")

        pages_elem = imprint.find('biblScope[@unit="page"]')
        self.assertEqual(pages_elem.text, "1-15")
        self.assertEqual(pages_elem.get("from"), "1")
        self.assertEqual(pages_elem.get("to"), "15")

        date_elem = imprint.find('date')
        self.assertEqual(date_elem.text, "2024")
        self.assertEqual(date_elem.get("when"), "2024")

        publisher_elem = imprint.find('publisher')
        self.assertEqual(publisher_elem.text, "Test Publisher")

        # Verify identifiers
        doi_elem = biblStruct.find('idno[@type="DOI"]')
        self.assertEqual(doi_elem.text, "10.1234/test")

        ptr_elem = biblStruct.find('ptr')
        self.assertEqual(ptr_elem.get("target"), "https://example.com/article")

    def test_biblstruct_with_partial_metadata(self):
        """Test biblStruct creation with missing volume/issue."""
        metadata = {
            "title": "Test Article",
            "journal": "Test Journal",
            "date": "2024",
            "pages": "42"  # Single page, no range
        }

        header = create_tei_header(metadata=metadata)

        sourceDesc = header.find(".//sourceDesc")
        biblStruct = sourceDesc.find("biblStruct")
        self.assertIsNotNone(biblStruct)

        # Journal should be present
        monogr = biblStruct.find("monogr")
        journal_elem = monogr.find('title[@level="j"]')
        self.assertEqual(journal_elem.text, "Test Journal")

        # Volume/issue should be absent
        imprint = monogr.find("imprint")
        volume_elem = imprint.find('biblScope[@unit="volume"]')
        self.assertIsNone(volume_elem)

        issue_elem = imprint.find('biblScope[@unit="issue"]')
        self.assertIsNone(issue_elem)

        # Single page without from/to
        pages_elem = imprint.find('biblScope[@unit="page"]')
        self.assertEqual(pages_elem.text, "42")
        self.assertIsNone(pages_elem.get("from"))

    def test_preserves_existing_bibl_citation(self):
        """Test that existing bibl citation is preserved alongside biblStruct."""
        metadata = {
            "title": "Test",
            "authors": [{"given": "John", "family": "Doe"}],
            "date": "2024",
            "journal": "Test Journal"
        }

        header = create_tei_header(doi="10.1234/test", metadata=metadata)

        sourceDesc = header.find(".//sourceDesc")

        # Both bibl and biblStruct should exist
        bibl = sourceDesc.find("bibl")
        self.assertIsNotNone(bibl, "Legacy bibl should be preserved")
        self.assertIn("Doe", bibl.text)

        biblStruct = sourceDesc.find("biblStruct")
        self.assertIsNotNone(biblStruct, "New biblStruct should be created")

    def test_no_biblstruct_without_metadata(self):
        """Test that biblStruct is not created if no relevant metadata exists."""
        metadata = {}

        header = create_tei_header(metadata=metadata)

        sourceDesc = header.find(".//sourceDesc")
        biblStruct = sourceDesc.find("biblStruct")
        self.assertIsNone(biblStruct, "No biblStruct should be created without metadata")


class TestExtractBiblStructMetadata(unittest.TestCase):
    """Test extraction of journal metadata from biblStruct."""

    def test_extract_journal_from_biblstruct(self):
        """Test extraction of journal, volume, issue, pages from biblStruct."""
        tei_xml = """
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <fileDesc>
                    <titleStmt>
                        <title level="a">Test Article</title>
                    </titleStmt>
                    <publicationStmt>
                        <date type="publication">2024</date>
                    </publicationStmt>
                    <sourceDesc>
                        <biblStruct>
                            <monogr>
                                <title level="j">Test Journal</title>
                                <imprint>
                                    <biblScope unit="volume">123</biblScope>
                                    <biblScope unit="issue">4</biblScope>
                                    <biblScope unit="page" from="1" to="15">1-15</biblScope>
                                    <publisher>Test Publisher</publisher>
                                </imprint>
                            </monogr>
                        </biblStruct>
                    </sourceDesc>
                </fileDesc>
            </teiHeader>
        </TEI>
        """

        root = etree.fromstring(tei_xml.encode('utf-8'))
        metadata = extract_tei_metadata(root)

        self.assertEqual(metadata['journal'], "Test Journal")
        self.assertEqual(metadata['volume'], "123")
        self.assertEqual(metadata['issue'], "4")
        self.assertEqual(metadata['pages'], "1-15")
        self.assertEqual(metadata['publisher'], "Test Publisher")

    def test_round_trip_metadata(self):
        """Test that metadata survives create → extract round trip."""
        from fastapi_app.lib.utils.tei_utils import serialize_tei_with_formatted_header

        original_metadata = {
            "title": "Round Trip Test",
            "authors": [{"given": "Alice", "family": "Test"}],
            "date": "2024",
            "journal": "Test Journal",
            "volume": "99",
            "issue": "2",
            "pages": "10-20",
            "publisher": "Test Pub"
        }

        # Create TEI header
        header = create_tei_header(doi="10.1234/roundtrip", metadata=original_metadata)

        # Build minimal TEI document
        tei = etree.Element("TEI", nsmap={None: "http://www.tei-c.org/ns/1.0"})
        tei.append(header)

        # Serialize and re-parse (mimics production flow where TEI is saved and loaded)
        xml_string = serialize_tei_with_formatted_header(tei)
        # Add XML declaration for proper parsing
        xml_with_declaration = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml_string
        tei_reparsed = etree.fromstring(xml_with_declaration.encode('utf-8'))

        # Extract metadata back
        extracted = extract_tei_metadata(tei_reparsed)

        # Verify journal metadata survived
        self.assertEqual(extracted['journal'], original_metadata['journal'])
        self.assertEqual(extracted['volume'], original_metadata['volume'])
        self.assertEqual(extracted['issue'], original_metadata['issue'])
        self.assertEqual(extracted['pages'], original_metadata['pages'])
        self.assertEqual(extracted['publisher'], original_metadata['publisher'])

        # Verify it's in doc_metadata for database storage
        self.assertEqual(extracted['doc_metadata']['journal'], original_metadata['journal'])
        self.assertEqual(extracted['doc_metadata']['volume'], original_metadata['volume'])
        self.assertEqual(extracted['doc_metadata']['issue'], original_metadata['issue'])
        self.assertEqual(extracted['doc_metadata']['pages'], original_metadata['pages'])


class TestBiblStructPriorityExtraction(unittest.TestCase):
    """Test that biblStruct is prioritized over legacy locations for metadata extraction."""

    def test_extract_complete_metadata_from_biblstruct(self):
        """Test extraction of title, authors, date, DOI, URL from biblStruct."""
        tei_xml = """
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <fileDesc>
                    <titleStmt>
                        <title level="a">Legacy Title</title>
                        <author>
                            <persName>
                                <forename>Legacy</forename>
                                <surname>Author</surname>
                            </persName>
                        </author>
                    </titleStmt>
                    <publicationStmt>
                        <date type="publication">1999</date>
                        <idno type="DOI">10.1111/legacy.doi</idno>
                        <ptr target="https://legacy.example.com"/>
                    </publicationStmt>
                    <sourceDesc>
                        <biblStruct>
                            <analytic>
                                <title level="a">BiblStruct Title</title>
                                <author>
                                    <persName>
                                        <forename>Jane</forename>
                                        <surname>Smith</surname>
                                    </persName>
                                </author>
                                <author>
                                    <persName>
                                        <forename>John</forename>
                                        <surname>Doe</surname>
                                    </persName>
                                </author>
                            </analytic>
                            <monogr>
                                <title level="j">Test Journal</title>
                                <imprint>
                                    <biblScope unit="volume">42</biblScope>
                                    <biblScope unit="issue">3</biblScope>
                                    <biblScope unit="page" from="100" to="150">100-150</biblScope>
                                    <date when="2024">2024</date>
                                    <publisher>Test Publisher</publisher>
                                </imprint>
                            </monogr>
                            <idno type="DOI">10.1234/biblstruct.doi</idno>
                            <ptr target="https://biblstruct.example.com"/>
                        </biblStruct>
                    </sourceDesc>
                </fileDesc>
            </teiHeader>
        </TEI>
        """

        root = etree.fromstring(tei_xml.encode('utf-8'))
        metadata = extract_tei_metadata(root)

        # Verify biblStruct values are used, not legacy values
        self.assertEqual(metadata['title'], "BiblStruct Title")
        self.assertEqual(len(metadata['authors']), 2)
        self.assertEqual(metadata['authors'][0]['given'], "Jane")
        self.assertEqual(metadata['authors'][0]['family'], "Smith")
        self.assertEqual(metadata['authors'][1]['given'], "John")
        self.assertEqual(metadata['authors'][1]['family'], "Doe")
        self.assertEqual(metadata['date'], "2024")
        self.assertEqual(metadata['doi'], "10.1234/biblstruct.doi")
        self.assertEqual(metadata['url'], "https://biblstruct.example.com")

        # Verify journal metadata
        self.assertEqual(metadata['journal'], "Test Journal")
        self.assertEqual(metadata['volume'], "42")
        self.assertEqual(metadata['issue'], "3")
        self.assertEqual(metadata['pages'], "100-150")
        self.assertEqual(metadata['publisher'], "Test Publisher")

    def test_fallback_to_legacy_when_biblstruct_missing(self):
        """Test fallback to titleStmt/publicationStmt when biblStruct is missing (authors not extracted)."""
        tei_xml = """
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <fileDesc>
                    <titleStmt>
                        <title level="a">Legacy Title</title>
                        <author>
                            <persName>
                                <forename>Legacy</forename>
                                <surname>Author</surname>
                            </persName>
                        </author>
                    </titleStmt>
                    <publicationStmt>
                        <date type="publication">1999</date>
                        <idno type="DOI">10.1111/legacy.doi</idno>
                        <publisher>Legacy Publisher</publisher>
                        <ptr target="https://legacy.example.com"/>
                    </publicationStmt>
                    <sourceDesc>
                        <bibl>Legacy citation</bibl>
                    </sourceDesc>
                </fileDesc>
            </teiHeader>
        </TEI>
        """

        root = etree.fromstring(tei_xml.encode('utf-8'))
        metadata = extract_tei_metadata(root)

        # Verify legacy values are used when biblStruct is missing
        self.assertEqual(metadata['title'], "Legacy Title")
        # Authors are NOT extracted when biblStruct is missing (biblStruct is canonical source)
        self.assertEqual(metadata.get('authors'), [])
        self.assertEqual(metadata['date'], "1999")
        self.assertEqual(metadata['doi'], "10.1111/legacy.doi")
        self.assertEqual(metadata['publisher'], "Legacy Publisher")
        self.assertEqual(metadata['url'], "https://legacy.example.com")

    def test_round_trip_with_complete_metadata(self):
        """Test round-trip with complete metadata including DOI and URL."""
        from fastapi_app.lib.utils.tei_utils import serialize_tei_with_formatted_header

        original_metadata = {
            "title": "Complete Test Article",
            "authors": [
                {"given": "Alice", "family": "Test"},
                {"given": "Bob", "family": "Example"}
            ],
            "date": "2024",
            "journal": "Test Journal",
            "volume": "99",
            "issue": "2",
            "pages": "10-20",
            "publisher": "Test Publisher",
            "url": "https://example.com/article"
        }

        # Create TEI header
        header = create_tei_header(doi="10.1234/complete.test", metadata=original_metadata)

        # Build minimal TEI document
        tei = etree.Element("TEI", nsmap={None: "http://www.tei-c.org/ns/1.0"})
        tei.append(header)

        # Serialize and re-parse
        xml_string = serialize_tei_with_formatted_header(tei)
        xml_with_declaration = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml_string
        tei_reparsed = etree.fromstring(xml_with_declaration.encode('utf-8'))

        # Extract metadata back
        extracted = extract_tei_metadata(tei_reparsed)

        # Verify all metadata fields survived
        self.assertEqual(extracted['title'], original_metadata['title'])
        self.assertEqual(len(extracted['authors']), 2)
        self.assertEqual(extracted['authors'][0]['given'], "Alice")
        self.assertEqual(extracted['authors'][0]['family'], "Test")
        self.assertEqual(extracted['authors'][1]['given'], "Bob")
        self.assertEqual(extracted['authors'][1]['family'], "Example")
        self.assertEqual(extracted['date'], original_metadata['date'])
        self.assertEqual(extracted['journal'], original_metadata['journal'])
        self.assertEqual(extracted['volume'], original_metadata['volume'])
        self.assertEqual(extracted['issue'], original_metadata['issue'])
        self.assertEqual(extracted['pages'], original_metadata['pages'])
        self.assertEqual(extracted['publisher'], original_metadata['publisher'])
        self.assertEqual(extracted['doi'], "10.1234/complete.test")
        self.assertEqual(extracted['url'], original_metadata['url'])

        # Verify doc_metadata includes all fields
        doc_meta = extracted['doc_metadata']
        self.assertEqual(doc_meta['title'], original_metadata['title'])
        self.assertEqual(len(doc_meta['authors']), 2)
        self.assertEqual(doc_meta['date'], original_metadata['date'])
        self.assertEqual(doc_meta['journal'], original_metadata['journal'])
        self.assertEqual(doc_meta['volume'], original_metadata['volume'])
        self.assertEqual(doc_meta['issue'], original_metadata['issue'])
        self.assertEqual(doc_meta['pages'], original_metadata['pages'])
        self.assertEqual(doc_meta['publisher'], original_metadata['publisher'])
        self.assertEqual(doc_meta['doi'], "10.1234/complete.test")
        self.assertEqual(doc_meta['url'], original_metadata['url'])


if __name__ == '__main__':
    unittest.main()
