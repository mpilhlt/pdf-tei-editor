"""
Unit tests for Discord audit trail plugin.

@testCovers fastapi_app/plugins/discord_audit_trail/plugin.py
"""

import unittest
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime, timezone, timedelta
from lxml import etree
from pathlib import Path
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../..')))

from fastapi_app.plugins.discord_audit_trail.plugin import DiscordAuditTrailPlugin


class TestDiscordAuditTrailPlugin(unittest.IsolatedAsyncioTestCase):
    """Test Discord audit trail plugin."""

    def setUp(self):
        """Set up test fixtures."""
        self.plugin = DiscordAuditTrailPlugin()

    def test_metadata(self):
        """Test plugin metadata."""
        metadata = self.plugin.metadata
        self.assertEqual(metadata["id"], "discord-audit-trail")
        self.assertEqual(metadata["name"], "Discord Audit Trail")
        self.assertEqual(metadata["category"], "audit")
        self.assertEqual(metadata["required_roles"], ["*"])
        self.assertEqual(metadata["endpoints"], [])

    def test_no_endpoints(self):
        """Test plugin has no user-facing endpoints."""
        endpoints = self.plugin.get_endpoints()
        self.assertEqual(endpoints, {})

    @patch('fastapi_app.lib.plugin_tools.get_plugin_config')
    def test_is_available_enabled(self, mock_get_config):
        """Test plugin is available when enabled."""
        mock_get_config.return_value = True
        self.assertTrue(DiscordAuditTrailPlugin.is_available())

    @patch('fastapi_app.lib.plugin_tools.get_plugin_config')
    def test_is_available_disabled(self, mock_get_config):
        """Test plugin is not available when disabled."""
        mock_get_config.return_value = False
        self.assertFalse(DiscordAuditTrailPlugin.is_available())

    def test_extract_recent_revision_success(self):
        """Test extracting recent revision within 60 seconds."""
        # Create XML with recent change
        now = datetime.now(timezone.utc)
        recent_time = now.isoformat()

        xml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <fileDesc>
                    <titleStmt>
                        <respStmt>
                            <persName xml:id="jdoe">John Doe</persName>
                        </respStmt>
                    </titleStmt>
                </fileDesc>
                <revisionDesc>
                    <change when="{recent_time}" who="#jdoe">
                        <desc>Fixed formatting</desc>
                    </change>
                </revisionDesc>
            </teiHeader>
        </TEI>
        """

        xml_root = etree.fromstring(xml_content.encode('utf-8'))
        result = self.plugin._extract_recent_revision(xml_root)

        self.assertIsNotNone(result)
        self.assertEqual(result["desc"], "Fixed formatting")
        self.assertEqual(result["who_name"], "John Doe")
        self.assertEqual(result["status"], "draft")  # Default status
        # Check formatted timestamp (YYYY-MM-DD HH:MM:SS)
        self.assertRegex(result["when"], r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$')
        # Check ISO timestamp for Discord embed
        self.assertIn(recent_time[:19], result["when_iso"])

    def test_extract_recent_revision_old(self):
        """Test that old revisions (>60s) are skipped."""
        # Create XML with old change
        old_time = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat()

        xml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <revisionDesc>
                    <change when="{old_time}" who="#jdoe">
                        <desc>Old change</desc>
                    </change>
                </revisionDesc>
            </teiHeader>
        </TEI>
        """

        xml_root = etree.fromstring(xml_content.encode('utf-8'))
        result = self.plugin._extract_recent_revision(xml_root)

        self.assertIsNone(result)

    def test_extract_recent_revision_no_desc(self):
        """Test extracting revision without desc element."""
        now = datetime.now(timezone.utc).isoformat()

        xml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <revisionDesc>
                    <change when="{now}" who="#jdoe">Direct text change</change>
                </revisionDesc>
            </teiHeader>
        </TEI>
        """

        xml_root = etree.fromstring(xml_content.encode('utf-8'))
        result = self.plugin._extract_recent_revision(xml_root)

        self.assertIsNotNone(result)
        self.assertEqual(result["desc"], "Direct text change")

    def test_extract_recent_revision_multiple_changes(self):
        """Test extracting most recent from multiple changes."""
        now = datetime.now(timezone.utc)
        older_time = (now - timedelta(seconds=30)).isoformat()
        recent_time = now.isoformat()

        xml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <revisionDesc>
                    <change when="{older_time}" who="#jdoe">
                        <desc>Older change</desc>
                    </change>
                    <change when="{recent_time}" who="#jdoe">
                        <desc>Most recent change</desc>
                    </change>
                </revisionDesc>
            </teiHeader>
        </TEI>
        """

        xml_root = etree.fromstring(xml_content.encode('utf-8'))
        result = self.plugin._extract_recent_revision(xml_root)

        self.assertIsNotNone(result)
        self.assertEqual(result["desc"], "Most recent change")

    def test_extract_recent_revision_no_person_lookup(self):
        """Test revision extraction when person not found."""
        now = datetime.now(timezone.utc).isoformat()

        xml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <revisionDesc>
                    <change when="{now}" who="#unknown">
                        <desc>Change by unknown person</desc>
                    </change>
                </revisionDesc>
            </teiHeader>
        </TEI>
        """

        xml_root = etree.fromstring(xml_content.encode('utf-8'))
        result = self.plugin._extract_recent_revision(xml_root)

        self.assertIsNotNone(result)
        self.assertEqual(result["who_name"], "unknown")  # Falls back to ID

    def test_extract_recent_revision_with_status(self):
        """Test revision extraction with explicit status attribute."""
        now = datetime.now(timezone.utc).isoformat()

        xml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <revisionDesc>
                    <change when="{now}" status="published">
                        <desc>Published version</desc>
                    </change>
                </revisionDesc>
            </teiHeader>
        </TEI>
        """

        xml_root = etree.fromstring(xml_content.encode('utf-8'))
        result = self.plugin._extract_recent_revision(xml_root)

        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "published")

    def test_extract_document_title_from_tei(self):
        """Test extracting document title from TEI."""
        xml_content = """<?xml version="1.0" encoding="UTF-8"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <fileDesc>
                    <titleStmt>
                        <title type="main">Test Document Title</title>
                    </titleStmt>
                </fileDesc>
            </teiHeader>
        </TEI>
        """

        xml_root = etree.fromstring(xml_content.encode('utf-8'))
        title = self.plugin._extract_document_title(xml_root, None)

        self.assertEqual(title, "Test Document Title")

    def test_extract_document_title_from_label(self):
        """Test extracting document title from label fallback."""
        xml_content = """<?xml version="1.0" encoding="UTF-8"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <fileDesc>
                    <titleStmt>
                    </titleStmt>
                </fileDesc>
            </teiHeader>
        </TEI>
        """

        xml_root = etree.fromstring(xml_content.encode('utf-8'))
        title = self.plugin._extract_document_title(xml_root, "Label Title")

        self.assertEqual(title, "Label Title")

    @patch('fastapi_app.config.get_settings')
    @patch('fastapi_app.lib.collection_utils.list_collections')
    def test_resolve_collection_names(self, mock_list_collections, mock_get_settings):
        """Test resolving collection IDs to names."""
        # Mock settings
        mock_settings = MagicMock()
        mock_settings.db_dir = Path('/fake/db')
        mock_get_settings.return_value = mock_settings

        # Mock collections data
        mock_list_collections.return_value = [
            {'id': 'test-coll', 'label': 'Test Collection'},
            {'id': 'other-coll', 'name': 'Other Collection'}  # Test 'name' fallback
        ]

        names = self.plugin._resolve_collection_names(['test-coll', 'other-coll'])

        self.assertEqual(names, ['Test Collection', 'Other Collection'])

    @patch('fastapi_app.config.get_settings')
    @patch('fastapi_app.lib.collection_utils.list_collections')
    def test_resolve_collection_names_fallback(self, mock_list_collections, mock_get_settings):
        """Test collection name resolution fallback to ID."""
        # Mock settings
        mock_settings = MagicMock()
        mock_settings.db_dir = Path('/fake/db')
        mock_get_settings.return_value = mock_settings

        # Mock collections with missing collection
        mock_list_collections.return_value = []

        names = self.plugin._resolve_collection_names(['missing-coll'])

        self.assertEqual(names, ['missing-coll'])

    def test_resolve_collection_names_empty(self):
        """Test resolving empty collection list."""
        names = self.plugin._resolve_collection_names([])
        self.assertEqual(names, ["No collection"])

    @patch('fastapi_app.plugins.discord_audit_trail.plugin.httpx.AsyncClient')
    async def test_post_to_discord(self, mock_client_class):
        """Test posting to Discord webhook."""
        # Mock HTTP client
        mock_response = MagicMock()
        mock_response.raise_for_status = MagicMock()
        mock_client = MagicMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock()
        mock_client_class.return_value = mock_client

        revision_info = {
            "when": "2024-01-13 12:00:00",
            "when_iso": "2024-01-13T12:00:00+00:00",
            "desc": "Test change",
            "who_name": "John Doe",
            "status": "draft"
        }

        collection_progress = {"test-coll": 75.5}

        await self.plugin._post_to_discord(
            "https://discord.com/api/webhooks/test",
            revision_info,
            ["Test Collection"],
            collection_progress,
            "Test Document",
            "pdf123",  # pdf_stable_id
            "tei456",  # file_id (TEI stable_id)
            "https://example.com"  # base_url
        )

        # Verify webhook was called
        mock_client.post.assert_called_once()
        call_args = mock_client.post.call_args
        self.assertEqual(call_args[0][0], "https://discord.com/api/webhooks/test")

        # Verify payload structure
        payload = call_args[1]["json"]
        self.assertIn("embeds", payload)
        self.assertEqual(len(payload["embeds"]), 1)

        embed = payload["embeds"][0]
        self.assertEqual(embed["title"], "📝 New Document Revision")
        self.assertEqual(len(embed["fields"]), 8)  # Collection, Completion, Document, Change, Status, Who, When, Open document
        # Check that last field is "Open document" with link
        last_field = embed["fields"][-1]
        self.assertEqual(last_field["name"], "Open document")
        self.assertEqual(last_field["value"], "[Click here](https://example.com/#pdf=pdf123&xml=tei456)")

    @patch('fastapi_app.plugins.discord_audit_trail.plugin.get_config')
    async def test_handle_document_save_disabled(self, mock_get_config):
        """Test handler does nothing when disabled."""
        # Mock config with disabled flag
        mock_config = MagicMock()
        mock_config.get.side_effect = lambda key, default=None: {
            "plugin.discord-audit-trail.enabled": False,
            "plugin.discord-audit-trail.webhook-url": "https://test.url"
        }.get(key, default)
        mock_get_config.return_value = mock_config

        with patch.object(self.plugin, '_post_to_discord', new=AsyncMock()) as mock_post:
            await self.plugin._handle_document_save(
                xml_content="<TEI/>",
                label="Test",
                collections=[],
                doc_id="test"
            )

            mock_post.assert_not_called()

    @patch('fastapi_app.plugins.discord_audit_trail.plugin.get_config')
    async def test_handle_document_save_no_webhook_url(self, mock_get_config):
        """Test handler does nothing when webhook URL not configured."""
        # Mock config with empty webhook URL
        mock_config = MagicMock()
        mock_config.get.side_effect = lambda key, default=None: {
            "plugin.discord-audit-trail.enabled": True,
            "plugin.discord-audit-trail.webhook-url": ""
        }.get(key, default)
        mock_get_config.return_value = mock_config

        with patch.object(self.plugin, '_post_to_discord', new=AsyncMock()) as mock_post:
            await self.plugin._handle_document_save(
                xml_content="<TEI/>",
                label="Test",
                collections=[],
                doc_id="test"
            )

            mock_post.assert_not_called()

    @patch('fastapi_app.lib.statistics.calculate_collection_statistics')
    @patch('fastapi_app.lib.dependencies.get_db')
    @patch('fastapi_app.plugins.discord_audit_trail.plugin.get_config')
    @patch('fastapi_app.config.get_settings')
    @patch('fastapi_app.lib.collection_utils.list_collections')
    async def test_handle_document_save_success(self, mock_list_collections, mock_get_settings, mock_get_config, mock_get_db, mock_calc_stats):
        """Test successful document save handling."""
        # Mock config
        mock_config = MagicMock()
        mock_config.get.side_effect = lambda key, default=None: {
            "plugin.discord-audit-trail.enabled": True,
            "plugin.discord-audit-trail.webhook-url": "https://test.url"
        }.get(key, default)
        mock_get_config.return_value = mock_config

        # Mock settings
        mock_settings = MagicMock()
        mock_settings.db_dir = Path('/fake/db')
        mock_get_settings.return_value = mock_settings

        # Mock collections
        mock_list_collections.return_value = [
            {'id': 'test-coll', 'label': 'Test Collection'}
        ]

        # Mock database and statistics
        mock_db = MagicMock()
        mock_get_db.return_value = mock_db
        mock_calc_stats.return_value = {
            "avg_progress": 65.0,
            "total_docs": 10,
            "total_annotations": 15,
            "stage_counts": {},
            "doc_annotations": {}
        }

        # Create XML with recent change
        now = datetime.now(timezone.utc).isoformat()
        xml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <teiHeader>
                <fileDesc>
                    <titleStmt>
                        <title type="main">Test Document</title>
                        <respStmt>
                            <persName xml:id="jdoe">John Doe</persName>
                        </respStmt>
                    </titleStmt>
                </fileDesc>
                <revisionDesc>
                    <change when="{now}" who="#jdoe">
                        <desc>Test change</desc>
                    </change>
                </revisionDesc>
            </teiHeader>
        </TEI>
        """

        with patch.object(self.plugin, '_post_to_discord', new=AsyncMock()) as mock_post:
            await self.plugin._handle_document_save(
                xml_content=xml_content,
                label="Test Document",
                collections=["test-coll"],
                doc_id="doc123",
                pdf_stable_id="pdf456",
                file_id="tei789",
                base_url="https://example.com"
            )

            # Verify Discord post was called
            mock_post.assert_called_once()
            call_args = mock_post.call_args[0]

            # Verify arguments: webhook_url, revision_info, collection_names, collection_progress, doc_title, pdf_stable_id, file_id, base_url
            self.assertEqual(call_args[0], "https://test.url")
            self.assertEqual(call_args[1]["desc"], "Test change")
            self.assertEqual(call_args[2], ["Test Collection"])
            self.assertEqual(call_args[3], {"test-coll": 65.0})  # collection_progress
            self.assertEqual(call_args[4], "Test Document")
            self.assertEqual(call_args[5], "pdf456")  # pdf_stable_id
            self.assertEqual(call_args[6], "tei789")
            self.assertEqual(call_args[7], "https://example.com")  # base_url from event


if __name__ == '__main__':
    unittest.main()
