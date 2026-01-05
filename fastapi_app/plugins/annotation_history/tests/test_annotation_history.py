"""
Unit tests for the Annotation History plugin.

Tests XML parsing, nested HTML table generation, and error handling.

@testCovers fastapi_app/plugins/annotation_history/plugin.py
@testCovers fastapi_app/plugins/annotation_history/routes.py
"""

import unittest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

from fastapi_app.plugins.annotation_history.plugin import AnnotationHistoryPlugin
from fastapi_app.lib.plugin_base import PluginContext


class TestAnnotationHistoryPlugin(unittest.IsolatedAsyncioTestCase):
    """Test AnnotationHistoryPlugin functionality."""

    def setUp(self):
        """Set up test fixtures."""
        self.plugin = AnnotationHistoryPlugin()

    def test_plugin_metadata(self):
        """Test plugin metadata structure."""
        metadata = self.plugin.metadata
        self.assertEqual(metadata["id"], "annotation-history")
        self.assertEqual(metadata["name"], "Annotation History")
        self.assertEqual(metadata["category"], "document")
        self.assertEqual(metadata["required_roles"], ["user"])
        self.assertIn("endpoints", metadata)
        self.assertEqual(len(metadata["endpoints"]), 1)
        self.assertEqual(metadata["endpoints"][0]["name"], "analyze")

    def test_get_endpoints(self):
        """Test that plugin defines analyze endpoint."""
        endpoints = self.plugin.get_endpoints()
        self.assertIn("analyze", endpoints)
        self.assertTrue(callable(endpoints["analyze"]))

    async def test_analyze_no_pdf_id(self):
        """Test analyze endpoint with no PDF ID."""
        context = MagicMock(spec=PluginContext)
        params = {}

        result = await self.plugin.analyze(context, params)

        self.assertIn("error", result)
        self.assertEqual(result["error"], "No PDF document selected")

    def test_parse_tei_document_info_with_multiple_revisions(self):
        """Test parsing TEI XML with multiple revisions."""
        # Sample TEI XML with multiple change elements
        tei_xml = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt>
                <title level="a">Main Title</title>
            </titleStmt>
            <editionStmt>
                <edition>
                    <title>Test Document v1</title>
                </edition>
            </editionStmt>
        </fileDesc>
        <revisionDesc>
            <change when="2024-01-15" who="annotator1" status="draft">
                <desc>Initial annotation</desc>
            </change>
            <change when="2024-01-20T10:30:00" who="annotator2" status="checked">
                <desc>First review</desc>
            </change>
            <change when="2024-01-25" who="annotator1" status="approved">
                <desc>Final review</desc>
            </change>
        </revisionDesc>
    </teiHeader>
    <text>
        <body>
            <p>Content</p>
        </body>
    </text>
</TEI>"""

        # Mock file metadata
        file_metadata = MagicMock()
        file_metadata.stable_id = "test-stable-id"
        file_metadata.variant = "standard"
        file_metadata.is_gold_standard = False

        result = self.plugin._parse_tei_document_info(tei_xml, file_metadata)

        self.assertIsNotNone(result)
        self.assertEqual(result["title"], "Test Document v1")
        self.assertFalse(result["is_gold"])
        self.assertEqual(result["variant"], "standard")
        self.assertEqual(result["stable_id"], "test-stable-id")

        # Check revisions list
        self.assertIn("revisions", result)
        self.assertEqual(len(result["revisions"]), 3)

        # Check first revision
        self.assertEqual(result["revisions"][0]["desc"], "Initial annotation")
        self.assertEqual(result["revisions"][0]["annotator"], "annotator1")
        self.assertEqual(result["revisions"][0]["status"], "draft")
        self.assertEqual(result["revisions"][0]["date_raw"], "2024-01-15")

        # Check last revision (should match last_change)
        self.assertEqual(result["last_change"]["desc"], "Final review")
        self.assertEqual(result["last_change"]["annotator"], "annotator1")
        self.assertEqual(result["last_change"]["status"], "approved")

    def test_parse_tei_document_info_no_status_defaults_to_draft(self):
        """Test that missing status attribute defaults to 'draft'."""
        tei_xml = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt>
                <title level="a">Document Without Status</title>
            </titleStmt>
        </fileDesc>
        <revisionDesc>
            <change when="2024-01-15" who="annotator1">
                <desc>Change without status</desc>
            </change>
        </revisionDesc>
    </teiHeader>
</TEI>"""

        file_metadata = MagicMock()
        file_metadata.stable_id = "no-status-id"
        file_metadata.variant = "standard"
        file_metadata.is_gold_standard = False

        result = self.plugin._parse_tei_document_info(tei_xml, file_metadata)

        self.assertIsNotNone(result)
        self.assertEqual(len(result["revisions"]), 1)
        self.assertEqual(result["revisions"][0]["status"], "draft")
        self.assertEqual(result["last_change"]["status"], "draft")

    def test_generate_nested_table_structure(self):
        """Test nested HTML table structure."""
        documents = [
            {
                "title": "Test Document",
                "is_gold": True,
                "variant": "grobid",
                "stable_id": "stable-1",
                "last_change": {
                    "desc": "Final review",
                    "annotator": "annotator1",
                    "status": "approved",
                    "date": "January 25, 2024",
                    "date_raw": "2024-01-25",
                },
                "revisions": [
                    {
                        "desc": "Initial annotation",
                        "annotator": "annotator1",
                        "status": "draft",
                        "date": "January 15, 2024",
                        "date_raw": "2024-01-15",
                    },
                    {
                        "desc": "Final review",
                        "annotator": "annotator1",
                        "status": "approved",
                        "date": "January 25, 2024",
                        "date_raw": "2024-01-25",
                    },
                ],
            }
        ]

        html = self.plugin._generate_nested_table(documents, show_variant_column=False)

        # Check for expand/collapse buttons
        self.assertIn("expandAll()", html)
        self.assertIn("collapseAll()", html)
        self.assertIn("Expand All</button>", html)
        self.assertIn("Collapse All</button>", html)

        # Check main table structure
        self.assertIn("<table", html)
        self.assertIn("<thead>", html)
        self.assertIn("<tbody>", html)

        # Check headers (collapsed view)
        self.assertIn("Title", html)
        self.assertIn("Gold", html)
        self.assertIn("Status", html)
        self.assertIn("Last Change", html)
        self.assertIn("Annotator", html)
        self.assertIn("Date", html)

        # Check collapsed row content
        self.assertIn("Test Document", html)
        self.assertIn("✓", html)  # Gold checkmark
        self.assertIn("Final review", html)
        self.assertIn("approved", html)

        # Check nested table structure (detail rows)
        self.assertIn('id="detail-', html)
        self.assertIn('display: none', html)  # Initially collapsed

        # Check nested table content
        self.assertIn("Initial annotation", html)
        self.assertIn("draft", html)

        # Check JavaScript functions
        self.assertIn("function toggleRow", html)
        self.assertIn("function expandAll", html)
        self.assertIn("function collapseAll", html)

    def test_generate_nested_table_empty(self):
        """Test HTML table generation with no documents."""
        html = self.plugin._generate_nested_table([])
        self.assertIn("No annotation versions found", html)

    def test_sort_documents(self):
        """Test sorting documents: gold first, then by last change date (newest first)."""
        documents = [
            {
                "title": "Document A",
                "is_gold": False,
                "last_change": {"date_raw": "2024-01-15"},
            },
            {
                "title": "Document B",
                "is_gold": True,
                "last_change": {"date_raw": "2024-02-01"},
            },
            {
                "title": "Document C",
                "is_gold": False,
                "last_change": {"date_raw": "2024-03-01"},
            },
            {
                "title": "Document D",
                "is_gold": True,
                "last_change": {"date_raw": "2024-01-01"},
            },
        ]

        self.plugin._sort_documents(documents)

        # Check order: gold files first (B, D), then non-gold by date (C, A)
        self.assertEqual(documents[0]["title"], "Document B")  # Gold, newest
        self.assertEqual(documents[1]["title"], "Document D")  # Gold, older
        self.assertEqual(documents[2]["title"], "Document C")  # Non-gold, newest
        self.assertEqual(documents[3]["title"], "Document A")  # Non-gold, older

    async def test_analyze_returns_urls(self):
        """Test analyze endpoint returns URLs."""
        context = MagicMock(spec=PluginContext)
        params = {"pdf": "test-pdf-id", "variant": "standard"}

        result = await self.plugin.analyze(context, params)

        # Verify result contains URLs
        self.assertIn("outputUrl", result)
        self.assertIn("exportUrl", result)
        self.assertIn("pdf", result)
        self.assertIn("variant", result)

        # Verify URL structure
        self.assertIn("/api/plugins/annotation-history/view", result["outputUrl"])
        self.assertIn("pdf=test-pdf-id", result["outputUrl"])
        self.assertIn("variant=standard", result["outputUrl"])

        self.assertIn("/api/plugins/annotation-history/export", result["exportUrl"])
        self.assertIn("pdf=test-pdf-id", result["exportUrl"])
        self.assertIn("variant=standard", result["exportUrl"])

    def test_generate_csv(self):
        """Test CSV generation with multiple documents and revisions."""
        documents = [
            {
                "title": "Test Document A",
                "is_gold": True,
                "variant": "grobid",
                "stable_id": "stable-1",
                "last_change": {
                    "desc": "Final review",
                    "annotator": "annotator1",
                    "status": "approved",
                    "date": "January 25, 2024",
                    "date_raw": "2024-01-25",
                },
                "revisions": [
                    {
                        "desc": "Initial annotation",
                        "annotator": "annotator1",
                        "status": "draft",
                        "date": "January 15, 2024",
                        "date_raw": "2024-01-15",
                    },
                    {
                        "desc": "Final review",
                        "annotator": "annotator1",
                        "status": "approved",
                        "date": "January 25, 2024",
                        "date_raw": "2024-01-25",
                    },
                ],
            },
            {
                "title": "Test Document B",
                "is_gold": False,
                "variant": "standard",
                "stable_id": "stable-2",
                "last_change": {
                    "desc": "First draft",
                    "annotator": "annotator2",
                    "status": "draft",
                    "date": "January 10, 2024",
                    "date_raw": "2024-01-10",
                },
                "revisions": [
                    {
                        "desc": "First draft",
                        "annotator": "annotator2",
                        "status": "draft",
                        "date": "January 10, 2024",
                        "date_raw": "2024-01-10",
                    },
                ],
            },
        ]

        # Test with variant column
        csv = self.plugin._generate_csv(documents, show_variant_column=True)

        # Check header
        self.assertIn("Title,Gold,Variant,Change,Annotator,Status,Date", csv)

        # Check data rows - parent values should be repeated for each revision
        self.assertIn("Test Document A,Yes,grobid,Initial annotation,annotator1,draft", csv)
        self.assertIn("Test Document A,Yes,grobid,Final review,annotator1,approved", csv)
        self.assertIn("Test Document B,No,standard,First draft,annotator2,draft", csv)

        # Count rows (header + 3 data rows)
        lines = csv.strip().split('\n')
        self.assertEqual(len(lines), 4)

    def test_generate_csv_without_variant(self):
        """Test CSV generation without variant column."""
        documents = [
            {
                "title": "Test Document",
                "is_gold": False,
                "variant": "standard",
                "stable_id": "stable-1",
                "last_change": {
                    "desc": "Review",
                    "annotator": "annotator1",
                    "status": "checked",
                    "date": "January 20, 2024",
                    "date_raw": "2024-01-20",
                },
                "revisions": [
                    {
                        "desc": "Review",
                        "annotator": "annotator1",
                        "status": "checked",
                        "date": "January 20, 2024",
                        "date_raw": "2024-01-20",
                    },
                ],
            },
        ]

        csv = self.plugin._generate_csv(documents, show_variant_column=False)

        # Check header without Variant column
        self.assertIn("Title,Gold,Change,Annotator,Status,Date", csv)
        self.assertNotIn("Variant", csv.split('\n')[0])

        # Check data row
        self.assertIn("Test Document,No,Review,annotator1,checked", csv)


class TestAnnotationHistoryRoutes(unittest.TestCase):
    """Test annotation history HTTP routes."""

    def setUp(self):
        """Set up test client."""
        from fastapi import FastAPI
        from fastapi_app.plugins.annotation_history.routes import router
        from fastapi_app.lib.dependencies import (
            get_auth_manager,
            get_session_manager,
            get_db,
            get_file_storage,
        )

        self.app = FastAPI()
        self.app.include_router(router)

        # Create mocks for dependencies
        self.mock_session_manager = MagicMock()
        self.mock_auth_manager = MagicMock()
        self.mock_db = MagicMock()
        self.mock_storage = MagicMock()

        # Mock valid authentication by default
        self.mock_session_manager.is_session_valid.return_value = True
        self.mock_auth_manager.get_user_by_session_id.return_value = MagicMock(
            username="testuser",
            groups=["*"]  # Wildcard access
        )

        # Override dependencies
        self.app.dependency_overrides[get_session_manager] = lambda: self.mock_session_manager
        self.app.dependency_overrides[get_auth_manager] = lambda: self.mock_auth_manager
        self.app.dependency_overrides[get_db] = lambda: self.mock_db
        self.app.dependency_overrides[get_file_storage] = lambda: self.mock_storage

        self.client = TestClient(self.app)

    def test_view_success(self):
        """Test successful HTML view via HTTP route."""
        # Sample TEI XML with multiple revisions
        tei_xml = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt>
                <title level="a">Test Document</title>
            </titleStmt>
            <editionStmt>
                <edition>
                    <title>Test Document v1</title>
                </edition>
            </editionStmt>
        </fileDesc>
        <revisionDesc>
            <change when="2024-01-15" who="annotator1" status="draft">
                <desc>Initial annotation</desc>
            </change>
            <change when="2024-01-20" who="annotator2" status="checked">
                <desc>Final review</desc>
            </change>
        </revisionDesc>
    </teiHeader>
</TEI>"""

        # Mock TEI file metadata
        mock_tei_file = MagicMock()
        mock_tei_file.id = "test-tei-id"
        mock_tei_file.file_type = "tei"
        mock_tei_file.variant = "standard"
        mock_tei_file.is_gold_standard = False
        mock_tei_file.stable_id = "test-stable-id"

        # Mock dependencies
        with (
            patch("fastapi_app.plugins.annotation_history.routes.get_db") as mock_get_db,
            patch("fastapi_app.plugins.annotation_history.routes.get_file_storage") as mock_storage,
            patch("fastapi_app.plugins.annotation_history.routes.FileRepository") as mock_repo_class,
        ):
            # Setup mock database
            mock_get_db.return_value = MagicMock()

            # Setup mock repository
            mock_repo = MagicMock()
            mock_repo.get_doc_id_by_file_id.return_value = "test-doc-id"
            mock_repo.get_files_by_doc_id.return_value = [mock_tei_file]
            mock_repo_class.return_value = mock_repo

            # Setup mock file storage
            mock_storage_instance = MagicMock()
            mock_storage_instance.read_file.return_value = tei_xml.encode("utf-8")
            mock_storage.return_value = mock_storage_instance

            # Make request with session_id
            response = self.client.get(
                "/api/plugins/annotation-history/view",
                params={"pdf": "test-pdf-id", "variant": "standard", "session_id": "test-session"}
            )

            # Verify response
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "text/html; charset=utf-8")

            # Verify HTML content
            html_content = response.text
            self.assertIn("Test Document v1", html_content)
            self.assertIn("annotator1", html_content)
            self.assertIn("annotator2", html_content)
            self.assertIn("Initial annotation", html_content)
            self.assertIn("Final review", html_content)
            self.assertIn("draft", html_content)
            self.assertIn("checked", html_content)

    def test_view_pdf_not_found(self):
        """Test view with non-existent PDF."""
        with (
            patch("fastapi_app.plugins.annotation_history.routes.get_db") as mock_get_db,
            patch("fastapi_app.plugins.annotation_history.routes.FileRepository") as mock_repo_class,
        ):
            # Setup mock database
            mock_get_db.return_value = MagicMock()

            # Setup mock repository to return None
            mock_repo = MagicMock()
            mock_repo.get_doc_id_by_file_id.return_value = None
            mock_repo_class.return_value = mock_repo

            # Make request with session_id
            response = self.client.get(
                "/api/plugins/annotation-history/view",
                params={"pdf": "nonexistent-id", "variant": "all", "session_id": "test-session"}
            )

            # Verify 404 error
            self.assertEqual(response.status_code, 404)
            self.assertIn("PDF file not found", response.json()["detail"])

    def test_export_csv_success(self):
        """Test successful CSV export via HTTP route."""
        # Sample TEI XML with multiple revisions
        tei_xml = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt>
                <title level="a">Test Document</title>
            </titleStmt>
            <editionStmt>
                <edition>
                    <title>Test Document v1</title>
                </edition>
            </editionStmt>
        </fileDesc>
        <revisionDesc>
            <change when="2024-01-15" who="annotator1" status="draft">
                <desc>Initial annotation</desc>
            </change>
            <change when="2024-01-20" who="annotator2" status="checked">
                <desc>Final review</desc>
            </change>
        </revisionDesc>
    </teiHeader>
</TEI>"""

        # Mock TEI file metadata
        mock_tei_file = MagicMock()
        mock_tei_file.id = "test-tei-id"
        mock_tei_file.file_type = "tei"
        mock_tei_file.variant = "standard"
        mock_tei_file.is_gold_standard = False
        mock_tei_file.stable_id = "test-stable-id"

        # Mock dependencies
        with (
            patch("fastapi_app.plugins.annotation_history.routes.get_db") as mock_get_db,
            patch("fastapi_app.plugins.annotation_history.routes.get_file_storage") as mock_storage,
            patch("fastapi_app.plugins.annotation_history.routes.FileRepository") as mock_repo_class,
        ):
            # Setup mock database
            mock_get_db.return_value = MagicMock()

            # Setup mock repository
            mock_repo = MagicMock()
            mock_repo.get_doc_id_by_file_id.return_value = "test-doc-id"
            mock_repo.get_files_by_doc_id.return_value = [mock_tei_file]
            mock_repo_class.return_value = mock_repo

            # Setup mock file storage
            mock_storage_instance = MagicMock()
            mock_storage_instance.read_file.return_value = tei_xml.encode("utf-8")
            mock_storage.return_value = mock_storage_instance

            # Make request
            response = self.client.get(
                "/api/plugins/annotation-history/export",
                params={"pdf": "test-pdf-id", "variant": "standard"}
            )

            # Verify response
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "text/csv; charset=utf-8")
            self.assertIn("attachment; filename=annotation_history_test-pdf-id.csv",
                         response.headers["content-disposition"])

            # Verify CSV content
            csv_content = response.text
            self.assertIn("Title,Gold,Change,Annotator,Status,Date", csv_content)
            self.assertIn("Test Document v1,No,Initial annotation,annotator1,draft", csv_content)
            self.assertIn("Test Document v1,No,Final review,annotator2,checked", csv_content)

    def test_export_csv_with_variant_column(self):
        """Test CSV export includes Variant column when variant=all."""
        # Sample TEI XML
        tei_xml = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt>
                <title level="a">Test Document</title>
            </titleStmt>
            <editionStmt>
                <edition>
                    <title>Test Document</title>
                </edition>
            </editionStmt>
        </fileDesc>
        <revisionDesc>
            <change when="2024-01-15" who="annotator1" status="draft">
                <desc>Test change</desc>
            </change>
        </revisionDesc>
    </teiHeader>
</TEI>"""

        # Mock TEI file with grobid variant
        mock_tei_file = MagicMock()
        mock_tei_file.id = "test-tei-id"
        mock_tei_file.file_type = "tei"
        mock_tei_file.variant = "grobid"
        mock_tei_file.is_gold_standard = False
        mock_tei_file.stable_id = "test-stable-id"

        # Mock dependencies
        with (
            patch("fastapi_app.plugins.annotation_history.routes.get_db") as mock_get_db,
            patch("fastapi_app.plugins.annotation_history.routes.get_file_storage") as mock_storage,
            patch("fastapi_app.plugins.annotation_history.routes.FileRepository") as mock_repo_class,
        ):
            # Setup mock database
            mock_get_db.return_value = MagicMock()

            mock_repo = MagicMock()
            mock_repo.get_doc_id_by_file_id.return_value = "test-doc-id"
            mock_repo.get_files_by_doc_id.return_value = [mock_tei_file]
            mock_repo_class.return_value = mock_repo

            mock_storage_instance = MagicMock()
            mock_storage_instance.read_file.return_value = tei_xml.encode("utf-8")
            mock_storage.return_value = mock_storage_instance

            # Request with variant=all
            response = self.client.get(
                "/api/plugins/annotation-history/export",
                params={"pdf": "test-pdf-id", "variant": "all"}
            )

            # Verify Variant column is present
            self.assertEqual(response.status_code, 200)
            csv_content = response.text
            self.assertIn("Title,Gold,Variant,Change,Annotator,Status,Date", csv_content)
            self.assertIn("grobid", csv_content)

    def test_export_csv_pdf_not_found(self):
        """Test CSV export with non-existent PDF."""
        with (
            patch("fastapi_app.plugins.annotation_history.routes.get_db") as mock_get_db,
            patch("fastapi_app.plugins.annotation_history.routes.FileRepository") as mock_repo_class,
        ):
            # Setup mock database
            mock_get_db.return_value = MagicMock()

            # Setup mock repository to return None
            mock_repo = MagicMock()
            mock_repo.get_doc_id_by_file_id.return_value = None
            mock_repo_class.return_value = mock_repo

            # Make request
            response = self.client.get(
                "/api/plugins/annotation-history/export",
                params={"pdf": "nonexistent-id", "variant": "all"}
            )

            # Verify 404 error
            self.assertEqual(response.status_code, 404)
            self.assertIn("PDF file not found", response.json()["detail"])

    def test_export_csv_no_tei_files(self):
        """Test CSV export when no TEI files exist."""
        with (
            patch("fastapi_app.plugins.annotation_history.routes.get_db") as mock_get_db,
            patch("fastapi_app.plugins.annotation_history.routes.FileRepository") as mock_repo_class,
        ):
            # Setup mock database
            mock_get_db.return_value = MagicMock()

            # Setup mock repository with no TEI files
            mock_repo = MagicMock()
            mock_repo.get_doc_id_by_file_id.return_value = "test-doc-id"
            mock_repo.get_files_by_doc_id.return_value = []
            mock_repo_class.return_value = mock_repo

            # Make request
            response = self.client.get(
                "/api/plugins/annotation-history/export",
                params={"pdf": "test-pdf-id", "variant": "all"}
            )

            # Verify 404 error
            self.assertEqual(response.status_code, 404)
            self.assertIn("No annotation versions found", response.json()["detail"])

    def test_export_csv_variant_filter(self):
        """Test CSV export filters by variant."""
        tei_xml = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
    <teiHeader>
        <fileDesc>
            <titleStmt>
                <title level="a">Test Document</title>
            </titleStmt>
            <editionStmt>
                <edition>
                    <title>Test Document</title>
                </edition>
            </editionStmt>
        </fileDesc>
        <revisionDesc>
            <change when="2024-01-15" who="annotator1" status="draft">
                <desc>Test change</desc>
            </change>
        </revisionDesc>
    </teiHeader>
</TEI>"""

        # Create two TEI files with different variants
        mock_tei_grobid = MagicMock()
        mock_tei_grobid.id = "tei-grobid-id"
        mock_tei_grobid.file_type = "tei"
        mock_tei_grobid.variant = "grobid"
        mock_tei_grobid.is_gold_standard = False
        mock_tei_grobid.stable_id = "grobid-stable-id"

        mock_tei_standard = MagicMock()
        mock_tei_standard.id = "tei-standard-id"
        mock_tei_standard.file_type = "tei"
        mock_tei_standard.variant = "standard"
        mock_tei_standard.is_gold_standard = False
        mock_tei_standard.stable_id = "standard-stable-id"

        # Mock dependencies
        with (
            patch("fastapi_app.plugins.annotation_history.routes.get_db") as mock_get_db,
            patch("fastapi_app.plugins.annotation_history.routes.get_file_storage") as mock_storage,
            patch("fastapi_app.plugins.annotation_history.routes.FileRepository") as mock_repo_class,
        ):
            # Setup mock database
            mock_get_db.return_value = MagicMock()

            mock_repo = MagicMock()
            mock_repo.get_doc_id_by_file_id.return_value = "test-doc-id"
            mock_repo.get_files_by_doc_id.return_value = [mock_tei_grobid, mock_tei_standard]
            mock_repo_class.return_value = mock_repo

            mock_storage_instance = MagicMock()
            mock_storage_instance.read_file.return_value = tei_xml.encode("utf-8")
            mock_storage.return_value = mock_storage_instance

            # Request with variant=grobid filter
            response = self.client.get(
                "/api/plugins/annotation-history/export",
                params={"pdf": "test-pdf-id", "variant": "grobid"}
            )

            # Verify only grobid variant is in result
            self.assertEqual(response.status_code, 200)
            # Should not include Variant column when filtering
            csv_content = response.text
            self.assertNotIn("Variant", csv_content.split('\n')[0])


if __name__ == "__main__":
    unittest.main()
