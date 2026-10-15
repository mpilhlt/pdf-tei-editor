"""
Unit tests for document language detection and declaration in the TEI header.

@testCovers fastapi_app/lib/services/language_detection.py
@testCovers fastapi_app/lib/utils/tei_utils.py
@testCovers fastapi_app/routers/extraction.py
@testCovers fastapi_app/lib/utils/doi_utils.py
@testCovers fastapi_app/lib/services/metadata_update_utils.py
"""

import hashlib
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lxml import etree

from fastapi_app.lib.services.language_detection import (
    add_document_language,
    detect_language,
)
from fastapi_app.lib.utils.tei_utils import (
    create_tei_header,
    get_document_language,
    normalize_language_code,
    set_document_language,
)

NS = {"tei": "http://www.tei-c.org/ns/1.0"}

ENGLISH = (
    "The Federal Constitutional Court held that the statute on data retention violates the "
    "fundamental right to privacy of telecommunications and is therefore void. The court "
    "emphasised that the storage of traffic data without cause is a particularly serious "
    "interference with fundamental rights."
)
GERMAN = (
    "Das Bundesverfassungsgericht hat entschieden, dass das Gesetz zur Vorratsdatenspeicherung "
    "gegen das Fernmeldegeheimnis verstößt und daher nichtig ist. Das Gericht betonte, dass die "
    "anlasslose Speicherung von Verkehrsdaten einen besonders schweren Eingriff in die "
    "Grundrechte darstellt."
)


def _tei(text_content: str = "", text_lang: str | None = None, header_extra: str = "") -> str:
    lang_attr = f' xml:lang="{text_lang}"' if text_lang else ""
    return f"""<?xml-model href="https://example.com/schema.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Test</title>
      </titleStmt>
    </fileDesc>
    <encodingDesc>
      <appInfo/>
    </encodingDesc>{header_extra}
    <revisionDesc>
      <change when="2026-01-01" status="extraction"/>
    </revisionDesc>
  </teiHeader>
  <text{lang_attr}><body><p>{text_content}</p></body></text>
</TEI>
"""


def _language_idents(xml: str) -> list[str]:
    root = etree.fromstring(xml.encode("utf-8"))
    idents = root.xpath("tei:teiHeader/tei:profileDesc/tei:langUsage/tei:language/@ident", namespaces=NS)
    assert isinstance(idents, list)
    return [str(i) for i in idents]


class TestDetectLanguage(unittest.TestCase):

    def test_detects_english(self):
        self.assertEqual(detect_language(ENGLISH), "en")

    def test_detects_german(self):
        self.assertEqual(detect_language(GERMAN), "de")

    def test_short_text_is_not_classified(self):
        self.assertIsNone(detect_language("BVerfGE 109, 279."))
        self.assertIsNone(detect_language(""))


class TestTeiLanguageUtils(unittest.TestCase):

    def test_get_document_language_from_text_element(self):
        root = etree.fromstring(_tei(text_lang="fr").encode("utf-8"))
        self.assertEqual(get_document_language(root), "fr")

    def test_get_document_language_none(self):
        root = etree.fromstring(_tei().encode("utf-8"))
        self.assertIsNone(get_document_language(root))

    def test_set_document_language_inserts_profile_desc_before_revision_desc(self):
        root = etree.fromstring(_tei().encode("utf-8"))
        self.assertTrue(set_document_language(root, "de"))
        header = root.find("tei:teiHeader", NS)
        assert header is not None
        names = [etree.QName(c).localname for c in header]
        self.assertEqual(names, ["fileDesc", "encodingDesc", "profileDesc", "revisionDesc"])
        self.assertEqual(get_document_language(root), "de")

    def test_set_document_language_replaces_existing_lang_usage(self):
        extra = """
    <profileDesc>
      <abstract><p>Abstract</p></abstract>
      <langUsage><language ident="en"/></langUsage>
    </profileDesc>"""
        root = etree.fromstring(_tei(header_extra=extra).encode("utf-8"))
        set_document_language(root, "de")
        self.assertEqual(_language_idents(etree.tostring(root, encoding="unicode")), ["de"])
        self.assertIsNotNone(root.find("tei:teiHeader/tei:profileDesc/tei:abstract", NS))

    def test_set_document_language_without_header(self):
        root = etree.fromstring(b'<TEI xmlns="http://www.tei-c.org/ns/1.0"><text/></TEI>')
        self.assertFalse(set_document_language(root, "en"))


class TestRegistryLanguage(unittest.TestCase):
    """Language codes imported from CrossRef/DataCite metadata."""

    def test_normalize_language_code(self):
        self.assertEqual(normalize_language_code("DE"), "de")
        self.assertEqual(normalize_language_code("en_US"), "en-US")
        self.assertIsNone(normalize_language_code("English"))
        self.assertIsNone(normalize_language_code(""))
        self.assertIsNone(normalize_language_code(None))

    def _mock_response(self, payload: dict):
        from unittest.mock import MagicMock
        response = MagicMock()
        response.json.return_value = payload
        return response

    def test_crossref_language(self):
        from fastapi_app.lib.utils.doi_utils import parse_crossref_metadata
        payload = {"message": {"title": ["Titel"], "language": "de", "DOI": "10.1/x"}}
        with patch("fastapi_app.lib.utils.doi_utils.requests.get", return_value=self._mock_response(payload)):
            self.assertEqual(parse_crossref_metadata("10.1/x")["language"], "de")
        with patch("fastapi_app.lib.utils.doi_utils.requests.get", return_value=self._mock_response({"message": {}})):
            self.assertIsNone(parse_crossref_metadata("10.1/x")["language"])

    def test_datacite_language(self):
        from fastapi_app.lib.utils.doi_utils import parse_datacite_metadata
        payload = {"data": {"id": "10.1/x", "attributes": {"language": "en"}}}
        with patch("fastapi_app.lib.utils.doi_utils.requests.get", return_value=self._mock_response(payload)):
            self.assertEqual(parse_datacite_metadata("10.1/x")["language"], "en")

    def test_create_tei_header_declares_metadata_language(self):
        header = create_tei_header("", {"title": "Titel", "language": "de"})
        names = [etree.QName(c).localname for c in header]
        self.assertEqual(names, ["fileDesc", "encodingDesc", "profileDesc", "revisionDesc"])
        self.assertEqual(header.xpath("string(profileDesc/langUsage/language/@ident)"), "de")

    def test_create_tei_header_without_language(self):
        header = create_tei_header("", {"title": "Titel"})
        self.assertIsNone(header.find("profileDesc"))

    def test_metadata_language_wins_over_detection(self):
        extra = """
    <profileDesc>
      <langUsage><language ident="de"/></langUsage>
    </profileDesc>"""
        result = add_document_language(_tei(ENGLISH, header_extra=extra))
        self.assertEqual(_language_idents(result), ["de"])

    def test_update_biblstruct_sets_language(self):
        from fastapi_app.lib.services.metadata_update_utils import update_biblstruct_in_tei
        extra = """
    <profileDesc>
      <langUsage><language ident="und"/></langUsage>
    </profileDesc>"""
        root = etree.fromstring(_tei(header_extra=extra).encode("utf-8"))
        ok, _ = update_biblstruct_in_tei(root, {"title": "Titel", "language": "de"})
        self.assertTrue(ok)
        self.assertEqual(get_document_language(root), "de")


class TestAddDocumentLanguage(unittest.TestCase):

    def test_uses_language_declared_by_extractor(self):
        result = add_document_language(_tei(GERMAN, text_lang="en"))
        self.assertEqual(_language_idents(result), ["en"])

    def test_detects_language_from_tei_text(self):
        result = add_document_language(_tei(GERMAN))
        self.assertEqual(_language_idents(result), ["de"])

    def test_prefers_pdf_text_over_tei_text(self):
        with patch("fastapi_app.lib.services.language_detection.extract_pdf_text", return_value=GERMAN):
            result = add_document_language(_tei(ENGLISH), pdf_path="/some/file.pdf")
        self.assertEqual(_language_idents(result), ["de"])

    def test_undetermined_language(self):
        result = add_document_language(_tei("1, 2, 3"))
        self.assertEqual(_language_idents(result), ["und"])

    def test_existing_declaration_is_left_unchanged(self):
        extra = """
    <profileDesc>
      <langUsage><language ident="fr"/></langUsage>
    </profileDesc>"""
        source = _tei(GERMAN, header_extra=extra)
        self.assertEqual(add_document_language(source), source)

    def test_preserves_formatting_and_processing_instructions(self):
        source = _tei(ENGLISH)
        result = add_document_language(source)
        self.assertTrue(result.startswith('<?xml-model href="https://example.com/schema.rng"'))
        self.assertIn("\n<TEI ", result)
        self.assertIn(f"<text><body><p>{ENGLISH}</p></body></text>", result)
        self.assertIn(
            "    </encodingDesc>\n"
            "    <profileDesc>\n"
            "      <langUsage>\n"
            '        <language ident="en"/>\n'
            "      </langUsage>\n"
            "    </profileDesc>\n"
            "    <revisionDesc>",
            result,
        )

    def test_malformed_xml_is_returned_unchanged(self):
        with self.assertLogs("fastapi_app.lib.services.language_detection", level="WARNING"):
            self.assertEqual(add_document_language("<TEI"), "<TEI")


class TestExtractionRouteSetsLanguage(unittest.TestCase):
    """The extraction route declares the language regardless of the extractor."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_extraction_result_declares_language(self):
        from fastapi.testclient import TestClient

        from fastapi_app.config import Settings, get_settings
        from fastapi_app.lib.core.database import DatabaseManager
        from fastapi_app.lib.core.dependencies import (
            get_file_repository,
            get_file_storage,
            require_authenticated_user,
        )
        from fastapi_app.lib.models.models import FileCreate
        from fastapi_app.lib.repository.file_repository import FileRepository
        from fastapi_app.lib.storage.file_storage import FileStorage
        from fastapi_app.main import app

        db = DatabaseManager(self.test_dir / "test.db")
        repo = FileRepository(db)
        storage = FileStorage(self.test_dir / "files", db)

        pdf_content = b"%PDF-1.4 language detection test"
        file_hash = hashlib.sha256(pdf_content).hexdigest()
        storage.save_file(pdf_content, "pdf")
        repo.insert_file(FileCreate(
            id=file_hash,
            filename=f"{file_hash}.pdf",
            doc_id="test-doc-lang",
            file_type="pdf",
            file_size=len(pdf_content),
            label="Test doc",
            doc_collections=["_inbox"],
        ))

        class _GermanExtractor:
            @classmethod
            def get_info(cls):
                return {"input": ["pdf"], "output": ["tei-document"]}

            async def extract(self, pdf_path=None, xml_content=None, options=None):
                return _tei(GERMAN)

        app.dependency_overrides[get_file_repository] = lambda: repo
        app.dependency_overrides[get_file_storage] = lambda: storage
        app.dependency_overrides[require_authenticated_user] = lambda: {"username": "testuser", "roles": ["admin"]}
        app.dependency_overrides[get_settings] = lambda: Settings(DATA_ROOT=str(self.test_dir))

        try:
            with patch("fastapi_app.routers.extraction.create_extractor", return_value=_GermanExtractor()), \
                    patch("fastapi_app.lib.services.language_detection.extract_pdf_text", return_value=""):
                response = TestClient(app).post(
                    "/api/v1/extract",
                    json={"extractor": "mock-extractor", "file_id": file_hash, "options": {}},
                )
            self.assertEqual(response.status_code, 200, response.text)
            tei_file = repo.get_file_by_stable_id(response.json()["xml"])
            assert tei_file is not None
            tei_bytes = storage.read_file(tei_file.id, "tei")
            assert tei_bytes is not None
            tei_xml = tei_bytes.decode("utf-8")
            self.assertEqual(_language_idents(tei_xml), ["de"])
        finally:
            app.dependency_overrides.clear()


if __name__ == "__main__":
    unittest.main()
