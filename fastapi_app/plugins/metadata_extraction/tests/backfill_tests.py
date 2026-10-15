"""
Ad-hoc tests for the metadata backfill of the Metadata Extraction plugin.

Deliberately not named test_*.py so that the general test runners do not pick them up.
Run during development with:

    uv run python tests/unit-test-runner.py fastapi_app/plugins/metadata_extraction/tests/backfill_tests.py
"""

import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from lxml import etree

from fastapi_app.lib.models.models import FileMetadata
from fastapi_app.lib.services.metadata_extraction import BibliographicMetadata
from fastapi_app.plugins.metadata_extraction import backfill
from fastapi_app.plugins.metadata_extraction.backfill import (
    backfill_collection,
    backfill_document,
    fill_missing_fields,
    fill_missing_pdf_metadata,
    get_missing_fields,
    retrieve_metadata,
)
from fastapi_app.plugins.metadata_extraction.grobid_header import parse_grobid_header

NS = {"tei": "http://www.tei-c.org/ns/1.0"}

ENGLISH = (
    "The Federal Constitutional Court held that the statute on data retention violates the "
    "fundamental right to privacy of telecommunications and is therefore void. The court "
    "emphasised that the storage of traffic data without cause is a particularly serious "
    "interference with fundamental rights."
)

CROSSREF: BibliographicMetadata = {
    "title": "Registry Title",
    "authors": [{"given": "Ada", "family": "Lovelace"}],
    "date": "2020",
    "publisher": "Registry Press",
    "journal": "Journal of Tests",
    "volume": "12",
    "issue": "3",
    "pages": "100-120",
    "doi": "10.1234/registry",
    "issn": "1234-5678",
    "url": "https://doi.org/10.1234/registry",
    "language": "en",
}

GROBID_TEI = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader xml:lang="en">
    <fileDesc>
      <titleStmt><title level="a" type="main">Grobid  Title</title></titleStmt>
      <publicationStmt><publisher>Grobid Press</publisher><date type="published" when="2019">2019</date></publicationStmt>
      <sourceDesc>
        <biblStruct>
          <analytic>
            <author><persName><forename type="first">Alan</forename><forename type="middle">M</forename><surname>Turing</surname></persName></author>
            <author><affiliation>Only an affiliation</affiliation></author>
            <title level="a" type="main">Grobid Title</title>
          </analytic>
          <monogr>
            <title level="j" type="main">Grobid Journal</title>
            <idno type="ISSN">8765-4321</idno>
            <imprint>
              <biblScope unit="volume">7</biblScope>
              <biblScope unit="page" from="5" to="9"/>
              <date type="published" when="2019"/>
            </imprint>
          </monogr>
          <idno type="DOI">10.5555/grobid</idno>
        </biblStruct>
      </sourceDesc>
    </fileDesc>
  </teiHeader>
</TEI>"""


GERMAN = (
    "Das Bundesverfassungsgericht hat entschieden, dass das Gesetz zur Vorratsdatenspeicherung "
    "gegen das Fernmeldegeheimnis verstößt und daher nichtig ist. Das Gericht betonte, dass die "
    "anlasslose Speicherung von Verkehrsdaten einen besonders schweren Eingriff in die "
    "Grundrechte darstellt."
)


def _tei(source_desc: str = "", profile_desc: str = "", text: str = ENGLISH, text_attrs: str = "") -> str:
    return f"""<?xml-model href="https://example.com/schema.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title level="a">Existing Title</title>
      </titleStmt>
      <publicationStmt>
        <publisher>Existing Publisher</publisher>
      </publicationStmt>
      <sourceDesc>{source_desc}</sourceDesc>
    </fileDesc>{profile_desc}
    <revisionDesc>
      <change when="2026-01-01" status="extraction"/>
    </revisionDesc>
  </teiHeader>
  <text{text_attrs}><body><p>{text}</p></body></text>
</TEI>
"""


def _root(source: str) -> etree._Element:  # type: ignore[name-defined]
    return etree.fromstring(source.encode("utf-8"))


def _values(root: etree._Element, xpath: str) -> list[str]:  # type: ignore[name-defined]
    result = root.xpath(xpath, namespaces=NS)
    assert isinstance(result, list)
    return [str(v) for v in result]


def _file(stable_id: str, file_type: str, doc_metadata: dict[str, Any] | None = None) -> FileMetadata:
    return FileMetadata(
        id=f"hash-{stable_id}",
        stable_id=stable_id,
        filename=f"{stable_id}.{file_type}",
        doc_id="doc1",
        file_type=file_type,
        file_size=1,
        doc_metadata=doc_metadata or {},
    )


class FakeStorage:
    """In-memory replacement for FileStorage."""

    def __init__(self, contents: dict[str, str]):
        self.contents = {k: v.encode("utf-8") for k, v in contents.items()}
        self.saved: list[bytes] = []

    def read_file(self, file_hash: str, file_type: str) -> bytes | None:
        return self.contents.get(file_hash)

    def get_file_path(self, file_hash: str, file_type: str) -> Path | None:
        return Path(f"/tmp/{file_hash}.pdf")

    def save_file(self, content: bytes, file_type: str, increment_ref: bool = True) -> tuple[str, Path]:
        self.saved.append(content)
        file_hash = f"new-{len(self.saved)}"
        self.contents[file_hash] = content
        return file_hash, Path(f"/tmp/{file_hash}")


class TestMissingFields(unittest.TestCase):

    def test_empty_source_desc(self):
        missing = get_missing_fields(_root(_tei()))
        # title and publisher exist in titleStmt/publicationStmt (legacy locations)
        self.assertNotIn("title", missing)
        self.assertNotIn("publisher", missing)
        for name in ("authors", "date", "journal", "volume", "issue", "pages", "doi", "issn", "isbn", "url", "language"):
            self.assertIn(name, missing)

    def test_existing_values(self):
        source_desc = """<biblStruct>
          <analytic><author><persName><surname>Existing</surname></persName></author></analytic>
          <monogr><title level="j"><hi>Markup</hi> Journal</title><imprint><date when="1999"/></imprint></monogr>
          <idno type="DOI">10.1/x</idno>
          <ptr target="https://example.com"/>
        </biblStruct>"""
        profile = '\n    <profileDesc><langUsage><language ident="de"/></langUsage></profileDesc>'
        missing = get_missing_fields(_root(_tei(source_desc, profile)))
        for name in ("authors", "journal", "date", "doi", "url", "language"):
            self.assertNotIn(name, missing)

    def test_undetermined_language_counts_as_missing(self):
        profile = '\n    <profileDesc><langUsage><language ident="und"/></langUsage></profileDesc>'
        self.assertIn("language", get_missing_fields(_root(_tei(profile_desc=profile))))


class TestFillMissingFields(unittest.TestCase):

    def test_fills_only_missing_fields(self):
        root = _root(_tei())
        missing = get_missing_fields(root)
        filled = fill_missing_fields(root, CROSSREF, missing)
        self.assertNotIn("title", filled)
        self.assertNotIn("publisher", filled)
        self.assertEqual(
            filled, ["authors", "date", "journal", "volume", "issue", "pages", "doi", "issn", "url"]
        )
        bibl = "//tei:sourceDesc/tei:biblStruct"
        self.assertEqual(_values(root, f"{bibl}/tei:analytic/tei:title/text()"), [])
        self.assertEqual(_values(root, f"{bibl}/tei:analytic/tei:author/tei:persName/tei:surname/text()"), ["Lovelace"])
        self.assertEqual(_values(root, f"{bibl}/tei:monogr/tei:title[@level='j']/text()"), ["Journal of Tests"])
        self.assertEqual(_values(root, f"{bibl}/tei:monogr/tei:idno[@type='ISSN']/text()"), ["1234-5678"])
        self.assertEqual(_values(root, f"{bibl}/tei:monogr/tei:imprint/tei:biblScope[@unit='page']/@from"), ["100"])
        self.assertEqual(_values(root, f"{bibl}/tei:monogr/tei:imprint/tei:date/@when"), ["2020"])
        self.assertEqual(_values(root, f"{bibl}/tei:idno[@type='DOI']/text()"), ["10.1234/registry"])
        self.assertEqual(_values(root, f"{bibl}/tei:ptr/@target"), ["https://doi.org/10.1234/registry"])
        # Element order: analytic, monogr (title, idno, imprint), idno, ptr
        bibl_struct, monogr = root.find(".//tei:biblStruct", NS), root.find(".//tei:monogr", NS)
        assert bibl_struct is not None and monogr is not None
        names = [etree.QName(e).localname for e in bibl_struct]
        self.assertEqual(names, ["analytic", "monogr", "idno", "ptr"])
        self.assertEqual([etree.QName(e).localname for e in monogr], ["title", "idno", "imprint"])
        # Nothing is missing afterwards except the language and the ISBN
        self.assertEqual(get_missing_fields(root), ["isbn", "language"])

    def test_existing_values_are_not_overwritten(self):
        source_desc = """<biblStruct>
          <monogr><title level="j">Old Journal</title><imprint><biblScope unit="volume">1</biblScope></imprint></monogr>
        </biblStruct>"""
        root = _root(_tei(source_desc))
        fill_missing_fields(root, CROSSREF, get_missing_fields(root))
        self.assertEqual(_values(root, "//tei:monogr/tei:title[@level='j']/text()"), ["Old Journal"])
        self.assertEqual(_values(root, "//tei:biblScope[@unit='volume']/text()"), ["1"])
        self.assertEqual(_values(root, "//tei:biblScope[@unit='issue']/text()"), ["3"])

    def test_fields_not_in_list_are_ignored(self):
        root = _root(_tei())
        self.assertEqual(fill_missing_fields(root, CROSSREF, ["journal"]), ["journal"])
        self.assertEqual(_values(root, "//tei:analytic"), [])

    def test_keeps_formatting(self):
        source = _tei()
        root = _root(source)
        fill_missing_fields(root, CROSSREF, ["journal", "doi"])
        result = backfill.serialize_tei_like_source(root, source)
        self.assertTrue(result.startswith("<?xml-model "))
        self.assertIn(
            "      <sourceDesc>\n"
            "        <biblStruct>\n"
            "          <monogr>\n"
            '            <title level="j">Journal of Tests</title>\n'
            "          </monogr>\n"
            '          <idno type="DOI">10.1234/registry</idno>\n'
            "        </biblStruct>\n"
            "      </sourceDesc>\n"
            "    </fileDesc>\n",
            result,
        )
        self.assertIn(f"  <text><body><p>{ENGLISH}</p></body></text>\n</TEI>\n", result)

    def test_creates_source_desc(self):
        source = _tei().replace("      <sourceDesc></sourceDesc>\n", "")
        root = _root(source)
        fill_missing_fields(root, CROSSREF, ["doi"])
        result = backfill.serialize_tei_like_source(root, source)
        self.assertIn(
            "      </publicationStmt>\n"
            "      <sourceDesc>\n"
            "        <biblStruct>\n"
            '          <idno type="DOI">10.1234/registry</idno>\n'
            "        </biblStruct>\n"
            "      </sourceDesc>\n"
            "    </fileDesc>\n",
            result,
        )

    def test_nothing_to_fill_leaves_no_trace(self):
        source = _tei()
        root = _root(source)
        self.assertEqual(fill_missing_fields(root, {"authors": [{"given": "", "family": ""}]}, ["authors"]), [])
        unchanged = backfill.serialize_tei_like_source(_root(source), source)
        self.assertEqual(backfill.serialize_tei_like_source(root, source), unchanged)

    def test_pdf_metadata(self):
        merged, filled = fill_missing_pdf_metadata({"title": "Kept"}, CROSSREF)
        self.assertEqual(merged["title"], "Kept")
        self.assertEqual(merged["journal"], "Journal of Tests")
        self.assertNotIn("title", filled)
        self.assertNotIn("language", merged)


class TestGrobidHeader(unittest.TestCase):

    def test_parse(self):
        metadata = parse_grobid_header(GROBID_TEI)
        self.assertEqual(metadata.get("title"), "Grobid Title")
        self.assertEqual(metadata.get("authors"), [{"given": "Alan M", "family": "Turing"}])
        self.assertEqual(metadata.get("journal"), "Grobid Journal")
        self.assertEqual(metadata.get("date"), "2019")
        self.assertEqual(metadata.get("publisher"), "Grobid Press")
        self.assertEqual(metadata.get("volume"), "7")
        self.assertEqual(metadata.get("pages"), "5-9")
        self.assertEqual(metadata.get("doi"), "10.5555/grobid")
        self.assertEqual(metadata.get("issn"), "8765-4321")
        self.assertNotIn("issue", metadata)


class TestRetrieveMetadata(unittest.IsolatedAsyncioTestCase):

    async def test_crossref_with_doi(self):
        grobid = MagicMock()
        with patch.object(backfill, "lookup_doi", return_value=dict(CROSSREF)):
            metadata, sources, doi = await retrieve_metadata("10.1234/registry", Path("/x.pdf"), grobid, [])
        self.assertEqual(sources, ["crossref"])
        self.assertEqual(metadata.get("title"), "Registry Title")
        grobid.assert_not_called()

    async def test_grobid_fallback_without_doi(self):
        grobid_metadata = parse_grobid_header(GROBID_TEI)
        grobid_metadata.pop("doi")
        lookup = MagicMock()
        with patch.object(backfill, "lookup_doi", lookup):
            metadata, sources, doi = await retrieve_metadata(None, Path("/x.pdf"), lambda path: grobid_metadata, [])
        lookup.assert_not_called()
        self.assertEqual(sources, ["grobid"])
        self.assertEqual(metadata.get("title"), "Grobid Title")
        self.assertIsNone(doi)

    async def test_grobid_doi_is_looked_up(self):
        async def lookup(doi: str) -> BibliographicMetadata:
            return {"title": "Registry Title", "doi": doi} if doi == "10.5555/grobid" else {}

        with patch.object(backfill, "lookup_doi", side_effect=lookup):
            metadata, sources, doi = await retrieve_metadata(
                None, Path("/x.pdf"), lambda path: parse_grobid_header(GROBID_TEI), []
            )
        self.assertEqual(sources, ["crossref", "grobid"])
        self.assertEqual(doi, "10.5555/grobid")
        self.assertEqual(metadata.get("title"), "Registry Title")
        self.assertEqual(metadata.get("journal"), "Grobid Journal")

    async def test_failed_doi_lookup_falls_back_to_grobid(self):
        errors: list[str] = []
        with patch.object(backfill, "lookup_doi", return_value={}):
            metadata, sources, _ = await retrieve_metadata(
                "10.1234/missing", Path("/x.pdf"), lambda path: {"title": "Grobid Title"}, errors
            )
        self.assertEqual(sources, ["grobid"])
        self.assertEqual(metadata.get("title"), "Grobid Title")
        self.assertEqual(len(errors), 1)

    async def test_no_grobid(self):
        with patch.object(backfill, "lookup_doi", return_value={}):
            metadata, sources, _ = await retrieve_metadata(None, Path("/x.pdf"), None, [])
        self.assertEqual(sources, [])
        self.assertEqual(metadata, {})


class TestBackfillDocument(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        self.pdf = _file("pdf1", "pdf", {"title": "PDF Title"})
        self.tei = _file("tei1", "tei")
        self.storage = FakeStorage({self.tei.id: _tei('<biblStruct><idno type="DOI">10.1234/registry</idno></biblStruct>')})
        self.repo = MagicMock()
        lock_patch = patch.object(backfill, "check_lock", return_value={"is_locked": False})
        self.check_lock = lock_patch.start()
        self.addCleanup(lock_patch.stop)
        lookup_patch = patch.object(backfill, "lookup_doi", return_value=dict(CROSSREF))
        self.lookup = lookup_patch.start()
        self.addCleanup(lookup_patch.stop)
        pdf_text_patch = patch.object(backfill, "extract_pdf_text", return_value="")
        pdf_text_patch.start()
        self.addCleanup(pdf_text_patch.stop)

    async def _run(self, **kwargs: Any):
        return await backfill_document(
            "doc1", self.pdf, [self.tei], self.repo, self.storage, "session", Path("/tmp"), **kwargs  # type: ignore[arg-type]
        )

    async def test_backfills_from_crossref(self):
        result = await self._run()
        self.assertEqual(result.sources, ["crossref", "language-detection"])
        self.assertEqual(result.doi, "10.1234/registry")
        filled = result.files[0].filled
        self.assertEqual(filled["journal"], "Journal of Tests")
        self.assertEqual(filled["authors"], [{"given": "Ada", "family": "Lovelace"}])
        self.assertEqual(filled["language"], "en")
        self.assertEqual(result.files[0].language_source, "tei-text")
        self.assertNotIn("doi", filled)
        self.assertEqual(len(self.storage.saved), 1)
        saved = self.storage.saved[0].decode("utf-8")
        self.assertTrue(saved.startswith("<?xml-model "))
        root = _root(saved)
        self.assertEqual(_values(root, "//tei:langUsage/tei:language/@ident"), ["en"])
        self.assertEqual(_values(root, "//tei:titleStmt/tei:title/text()"), ["Existing Title"])
        self.assertEqual(len(_values(root, "//tei:idno[@type='DOI']")), 1)
        # TEI record points to the new content, PDF record got the missing keys only
        tei_update = self.repo.update_file.call_args_list[0]
        self.assertEqual(tei_update.args[0], self.tei.id)
        self.assertEqual(tei_update.args[1].id, "new-1")
        pdf_update = self.repo.update_file.call_args_list[1]
        self.assertEqual(pdf_update.args[1].doc_metadata["title"], "PDF Title")
        self.assertEqual(pdf_update.args[1].doc_metadata["journal"], "Journal of Tests")

    async def test_dry_run_saves_nothing(self):
        result = await self._run(dry_run=True)
        self.assertIn("journal", result.files[0].filled)
        self.assertTrue(result.pdf_filled)
        self.assertEqual(self.storage.saved, [])
        self.repo.update_file.assert_not_called()

    async def test_locked_file_is_skipped(self):
        self.check_lock.return_value = {"is_locked": True, "locked_by": "other"}
        result = await self._run()
        self.assertTrue(result.files[0].locked)
        self.assertEqual(self.storage.saved, [])

    async def test_language_only_needs_no_lookup(self):
        source_desc = """<biblStruct>
          <analytic><title level="a">T</title><author><persName><surname>S</surname></persName></author></analytic>
          <monogr><title level="j">J</title><idno type="ISSN">1</idno><idno type="ISBN">2</idno>
            <imprint><biblScope unit="volume">1</biblScope><biblScope unit="issue">2</biblScope>
            <biblScope unit="page">3</biblScope><date when="2000"/><publisher>P</publisher></imprint></monogr>
          <idno type="DOI">10.1234/registry</idno><ptr target="https://example.com"/>
        </biblStruct>"""
        self.storage.contents[self.tei.id] = _tei(source_desc).encode("utf-8")
        self.pdf = _file("pdf1", "pdf", {"title": "T", "authors": [{"family": "S"}], "date": "2000"})
        result = await self._run()
        self.lookup.assert_not_called()
        self.assertEqual(result.sources, ["language-detection"])
        self.assertEqual(result.files[0].filled, {"language": "en"})
        self.assertEqual(_values(_root(self.storage.saved[0].decode("utf-8")), "//tei:language/@ident"), ["en"])

    async def test_detected_language_wins_over_registry_and_grobid_xml_lang(self):
        self.storage.contents[self.tei.id] = _tei(text=GERMAN, text_attrs=' xml:lang="en"').encode("utf-8")
        result = await self._run()
        self.assertEqual(result.files[0].filled["language"], "de")
        self.assertEqual(result.files[0].language_source, "tei-text")

    async def test_registry_language_if_text_too_short(self):
        source_desc = '<biblStruct><idno type="DOI">10.1234/registry</idno></biblStruct>'
        self.storage.contents[self.tei.id] = _tei(source_desc, text="Kurz.", text_attrs=' xml:lang="fr"').encode("utf-8")
        self.lookup.return_value = dict(CROSSREF, language="de")
        result = await self._run()
        self.assertEqual(result.files[0].filled["language"], "de")
        self.assertEqual(result.files[0].language_source, "registry")

    async def test_pdf_metadata_values_are_reported(self):
        result = await self._run()
        self.assertEqual(result.pdf_filled["journal"], "Journal of Tests")
        self.assertNotIn("title", result.pdf_filled)

    async def test_complete_document_is_untouched(self):
        source_desc = """<biblStruct>
          <analytic><title level="a">T</title><author><persName><surname>S</surname></persName></author></analytic>
          <monogr><title level="j">J</title><idno type="ISSN">1</idno><idno type="ISBN">2</idno>
            <imprint><biblScope unit="volume">1</biblScope><biblScope unit="issue">2</biblScope>
            <biblScope unit="page">3</biblScope><date when="2000"/><publisher>P</publisher></imprint></monogr>
          <idno type="DOI">10.1234/registry</idno><ptr target="https://example.com"/>
        </biblStruct>"""
        profile = '\n    <profileDesc><langUsage><language ident="de"/></langUsage></profileDesc>'
        self.storage.contents[self.tei.id] = _tei(source_desc, profile).encode("utf-8")
        self.pdf = _file("pdf1", "pdf", {"title": "T", "authors": [{"family": "S"}], "date": "2000"})
        result = await self._run()
        self.lookup.assert_not_called()
        self.assertFalse(result.updated)
        self.assertEqual(self.storage.saved, [])


class TestBackfillCollection(unittest.IsolatedAsyncioTestCase):

    async def test_report(self):
        pdf, tei = _file("pdf1", "pdf"), _file("tei1", "tei")
        repo = MagicMock()
        repo.get_files_by_collection.return_value = [pdf, tei]
        repo.get_files_by_doc_id.return_value = [pdf, tei]
        storage = FakeStorage({tei.id: _tei()})
        progress = MagicMock()
        with patch.object(backfill, "check_lock", return_value={"is_locked": False}), \
                patch.object(backfill, "lookup_doi", return_value=dict(CROSSREF)), \
                patch.object(backfill, "extract_pdf_text", return_value=""):
            report = await backfill_collection(
                "coll", repo, storage, "session", Path("/tmp"),  # type: ignore[arg-type]
                grobid_fetcher=lambda path: {"title": "Grobid Title", "doi": "10.1234/registry"},
                progress_callback=progress,
            )
        self.assertEqual(report["summary"]["documents"], 1)
        self.assertEqual(report["summary"]["documents_updated"], 1)
        self.assertEqual(report["summary"]["tei_files_updated"], 1)
        self.assertEqual(report["summary"]["pdfs_updated"], 1)
        self.assertEqual(report["sources"]["crossref"], 1)
        self.assertEqual(report["sources"]["grobid"], 1)
        self.assertEqual(report["documents"][0]["files"][0]["stable_id"], "tei1")
        progress.assert_called_once()


class TestPluginMenuEntry(unittest.IsolatedAsyncioTestCase):

    async def test_opens_options_for_current_collection(self):
        from fastapi_app.plugins.metadata_extraction.plugin import MetadataExtractionPlugin

        plugin = MetadataExtractionPlugin()
        self.assertEqual(plugin.metadata["required_roles"], ["admin"])
        result = await plugin.backfill(MagicMock(), {"collection": "my coll"})
        self.assertEqual(result["outputUrl"], "/api/plugins/metadata-extraction/backfill/options?collection=my+coll")
        self.assertIn("error", await plugin.backfill(MagicMock(), {}))


class TestBackfillRoute(unittest.TestCase):

    def setUp(self):
        from fastapi_app.lib.core.dependencies import (
            get_auth_manager,
            get_db,
            get_file_storage,
            get_session_manager,
            get_sse_service,
        )
        from fastapi_app.plugins.metadata_extraction.routes import router

        self.app = FastAPI()
        self.app.include_router(router)
        self.session_manager = MagicMock()
        self.session_manager.is_session_valid.return_value = True
        self.auth_manager = MagicMock()
        self.auth_manager.get_user_by_session_id.return_value = {"username": "admin", "roles": ["admin"]}
        self.app.dependency_overrides[get_session_manager] = lambda: self.session_manager
        self.app.dependency_overrides[get_auth_manager] = lambda: self.auth_manager
        self.app.dependency_overrides[get_sse_service] = lambda: MagicMock()
        self.app.dependency_overrides[get_db] = lambda: MagicMock()
        self.app.dependency_overrides[get_file_storage] = lambda: MagicMock()
        self.client = TestClient(self.app)
        self.url = "/api/plugins/metadata-extraction/backfill"

        patches = [
            patch("fastapi_app.lib.utils.collection_utils.validate_collection", side_effect=lambda c, d: c == "coll"),
            patch("fastapi_app.plugins.metadata_extraction.grobid_header.get_live_grobid_server_url", return_value=None),
            patch("fastapi_app.lib.sse.sse_utils.ProgressBar"),
            patch("fastapi_app.lib.sse.sse_utils.send_notification"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_requires_session(self):
        self.assertEqual(self.client.post(self.url, params={"collection": "coll"}).status_code, 401)

    def test_requires_admin(self):
        self.auth_manager.get_user_by_session_id.return_value = {"username": "u", "roles": ["annotator"]}
        response = self.client.post(self.url, params={"collection": "coll", "session_id": "s"})
        self.assertEqual(response.status_code, 403)

    def test_unknown_collection(self):
        response = self.client.post(self.url, params={"collection": "nope", "session_id": "s"})
        self.assertEqual(response.status_code, 404)

    def test_options_page(self):
        response = self.client.get(self.url + "/options", params={"collection": "coll", "session_id": "s"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("<strong>coll</strong>", response.text)
        self.assertIn("/api/plugins/metadata-extraction/static/backfill.js", response.text)

    def test_options_page_requires_admin(self):
        self.auth_manager.get_user_by_session_id.return_value = {"username": "u", "roles": ["annotator"]}
        response = self.client.get(self.url + "/options", params={"collection": "coll", "session_id": "s"})
        self.assertEqual(response.status_code, 403)

    def test_runs_backfill(self):
        report = {"summary": {"documents": 0, "documents_updated": 0, "errors": 0}}
        with patch("fastapi_app.plugins.metadata_extraction.backfill.backfill_collection", return_value=report) as run:
            response = self.client.post(
                self.url, params={"collection": "coll", "session_id": "s", "dry_run": "true", "limit": "5"}
            )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["grobid_available"])
        kwargs = run.call_args.kwargs
        self.assertEqual(kwargs["collection_id"], "coll")
        self.assertTrue(kwargs["dry_run"])
        self.assertEqual(kwargs["limit"], 5)
        self.assertIsNone(kwargs["grobid_fetcher"])


if __name__ == "__main__":
    unittest.main()
