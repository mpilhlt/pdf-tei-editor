"""Discord webhook notifications for document revisions.

Setup:
1. Create a Discord server or use existing one
2. Go to Server Settings → Integrations → Webhooks
3. Click "New Webhook"
4. Configure webhook:
   - Name: "Audit Trail" (or custom name)
   - Channel: Select target channel
   - Copy webhook URL
5. Configure plugin:
   - Set DISCORD_AUDIT_TRAIL_WEBHOOK_URL environment variable
   - Set DISCORD_AUDIT_TRAIL_ENABLED=true (default)

Example .env configuration:
```
DISCORD_AUDIT_TRAIL_ENABLED=true
DISCORD_AUDIT_TRAIL_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

For more information on Discord webhooks, see:
https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks
"""

from fastapi_app.lib.plugin_base import Plugin
from fastapi_app.lib.event_bus import get_event_bus
from fastapi_app.lib.config_utils import get_config
from lxml import etree
import httpx
from datetime import datetime, timezone
from typing import Any, Callable
import logging

logger = logging.getLogger(__name__)


class DiscordAuditTrailPlugin(Plugin):
    """Discord webhook notifications for document revisions."""

    @classmethod
    def is_available(cls) -> bool:
        """Only available if enabled in config."""
        from fastapi_app.lib.plugin_tools import get_plugin_config

        enabled = get_plugin_config(
            "plugin.discord-audit-trail.enabled",
            "DISCORD_AUDIT_TRAIL_ENABLED",
            default=True,
            value_type="boolean"
        )

        return enabled

    def __init__(self):
        super().__init__()

        # Initialize config from environment variables
        from fastapi_app.lib.plugin_tools import get_plugin_config
        get_plugin_config(
            "plugin.discord-audit-trail.enabled",
            "DISCORD_AUDIT_TRAIL_ENABLED",
            default=True,
            value_type="boolean"
        )
        get_plugin_config(
            "plugin.discord-audit-trail.webhook-url",
            "DISCORD_AUDIT_TRAIL_WEBHOOK_URL",
            default=None
        )

        # Register event handler on initialization
        event_bus = get_event_bus()
        event_bus.on("document.save", self._handle_document_save)
        logger.info("Discord audit trail plugin registered for document.save events")

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "discord-audit-trail",
            "name": "Discord Audit Trail",
            "description": "Posts document revision notifications to Discord",
            "category": "audit",
            "version": "1.0.0",
            "required_roles": ["*"],  # System plugin, no user-facing endpoints
            "endpoints": []  # No user-callable endpoints
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {}  # No endpoints

    async def _handle_document_save(self, **kwargs):
        """Event handler for document.save events."""
        try:
            # Check if enabled
            config = get_config()
            enabled = config.get("plugin.discord-audit-trail.enabled", default=True)
            webhook_url = config.get("plugin.discord-audit-trail.webhook-url", default=None)

            if not enabled:
                logger.debug("Discord audit trail disabled")
                return

            if not webhook_url:
                logger.debug("Discord audit trail webhook URL not configured")
                return

            # Extract event data
            xml_content = kwargs.get("xml_content")
            label = kwargs.get("label")
            collections = kwargs.get("collections", [])
            doc_id = kwargs.get("doc_id") or ""
            pdf_stable_id = kwargs.get("pdf_stable_id") or ""
            file_id = kwargs.get("file_id") or ""  # TEI stable_id
            base_url = kwargs.get("base_url") or ""

            logger.info(f"DEBUG: Event payload - doc_id={doc_id}, pdf_stable_id={pdf_stable_id}, file_id={file_id}, base_url={base_url}")

            if not xml_content:
                logger.warning("No XML content in document.save event")
                return

            # Parse XML and extract revision
            xml_root = etree.fromstring(xml_content.encode('utf-8'))
            revision_info = self._extract_recent_revision(xml_root)

            if not revision_info:
                logger.debug("No recent revision found (older than 60s)")
                return

            # Resolve collection names
            collection_names = self._resolve_collection_names(collections)

            # Extract document title
            doc_title = self._extract_document_title(xml_root, label)

            # Calculate collection progress
            collection_progress = self._calculate_collection_progress(collections)

            # Post to Discord
            await self._post_to_discord(
                webhook_url,
                revision_info,
                collection_names,
                collection_progress,
                doc_title,
                pdf_stable_id,
                file_id,
                base_url
            )

        except Exception as e:
            logger.error(f"Error in Discord audit trail handler: {e}", exc_info=True)

    def _extract_recent_revision(self, xml_root) -> dict | None:
        """Extract most recent change element if within 60 seconds.

        Returns:
            dict with keys: when, when_iso, desc, who_id, who_name, status
            None if no recent change found
        """
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}

        # Find all change elements with @when attribute
        changes = xml_root.xpath(
            "//tei:revisionDesc/tei:change[@when]",
            namespaces=ns
        )

        if not changes:
            return None

        # Sort by @when timestamp (ISO 8601 format)
        changes_with_time = []
        for change in changes:
            when_str = change.get("when")
            try:
                # Parse ISO 8601 timestamp (handle both Z and +00:00 formats)
                when_dt = datetime.fromisoformat(when_str.replace('Z', '+00:00'))
                changes_with_time.append((when_dt, change))
            except (ValueError, AttributeError):
                continue

        if not changes_with_time:
            return None

        # Get most recent
        changes_with_time.sort(key=lambda x: x[0], reverse=True)
        most_recent_dt, most_recent = changes_with_time[0]

        # Check if within 60 seconds
        now = datetime.now(timezone.utc)
        age_seconds = (now - most_recent_dt).total_seconds()

        if age_seconds > 60:
            logger.debug(f"Most recent change is {age_seconds}s old, skipping")
            return None

        # Extract description
        desc_elem = most_recent.find("tei:desc", ns)
        if desc_elem is not None and desc_elem.text:
            desc = desc_elem.text.strip()
        else:
            desc = most_recent.text.strip() if most_recent.text else "No description"

        # Extract who attribute
        who_id = most_recent.get("who")
        who_name = None

        if who_id:
            # Remove # prefix if present
            who_id_clean = who_id.lstrip('#')

            # Lookup person name
            person = xml_root.xpath(
                f"//tei:respStmt/tei:persName[@xml:id='{who_id_clean}']",
                namespaces=ns
            )

            if person:
                who_name = person[0].text.strip() if person[0].text else who_id_clean
            else:
                who_name = who_id_clean
        else:
            who_name = "Unknown"

        # Extract status attribute
        status = most_recent.get("status")
        if not status:
            status = "draft"  # Default status per TEI schema

        # Convert UTC to local time
        local_dt = most_recent_dt.astimezone()

        return {
            "when": local_dt.strftime("%Y-%m-%d %H:%M:%S"),
            "when_iso": most_recent_dt.isoformat(),
            "desc": desc,
            "who_id": who_id,
            "who_name": who_name,
            "status": status
        }

    def _extract_document_title(self, xml_root, label: str | None) -> str:
        """Extract document title from TEI or label."""
        # Try TEI title first
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}
        title_elem = xml_root.find(".//tei:titleStmt/tei:title[@type='main']", ns)
        if title_elem is not None and title_elem.text:
            return title_elem.text.strip()

        # Fallback to label
        if label:
            return label

        return "Unknown document"

    def _resolve_collection_names(self, collection_ids: list[str]) -> list[str]:
        """Resolve collection IDs to human-readable names."""
        from fastapi_app.lib.collection_utils import find_collection, list_collections
        from fastapi_app.config import get_settings

        if not collection_ids:
            return ["No collection"]

        try:
            settings = get_settings()
            collections = list_collections(settings.db_dir)
            names = []

            for coll_id in collection_ids:
                collection = find_collection(coll_id, collections)
                if collection:
                    # Try 'label' first, fall back to 'name'
                    name = collection.get('label') or collection.get('name') or coll_id
                    names.append(name)
                else:
                    names.append(coll_id)

            return names
        except Exception as e:
            logger.warning(f"Could not resolve collection names: {e}")
            return collection_ids

    def _calculate_collection_progress(self, collection_ids: list[str]) -> dict[str, float]:
        """Calculate annotation progress for each collection.

        Returns:
            Dict mapping collection IDs to progress percentages (0-100)
        """
        from fastapi_app.lib.statistics import calculate_collection_statistics
        from fastapi_app.lib.file_repository import FileRepository
        from fastapi_app.lib.config_utils import get_config
        from fastapi_app.lib.dependencies import get_db

        if not collection_ids:
            return {}

        try:
            config = get_config()
            lifecycle_order = config.get("annotation.lifecycle.order", default=[])

            db = get_db()
            file_repo = FileRepository(db)
            progress_map = {}

            for collection_id in collection_ids:
                try:
                    stats = calculate_collection_statistics(
                        file_repo,
                        collection_id,
                        variant=None,
                        lifecycle_order=lifecycle_order
                    )
                    progress_map[collection_id] = stats["avg_progress"]
                except Exception as e:
                    logger.warning(f"Could not calculate progress for collection {collection_id}: {e}")
                    progress_map[collection_id] = 0.0

            return progress_map
        except Exception as e:
            logger.warning(f"Could not calculate collection progress: {e}")
            return {}

    async def _post_to_discord(
        self,
        webhook_url: str,
        revision_info: dict,
        collection_names: list[str],
        collection_progress: dict[str, float],
        doc_title: str,
        pdf_stable_id: str,
        file_id: str,
        base_url: str
    ):
        """Post formatted message to Discord webhook."""
        # Calculate average completion across all collections
        if collection_progress:
            avg_completion = sum(collection_progress.values()) / len(collection_progress)
            completion_text = f"{avg_completion:.1f}%"
        else:
            completion_text = "N/A"

        # Build application URL
        app_url = None
        if base_url and pdf_stable_id and file_id:
            app_url = f"{base_url}/#pdf={pdf_stable_id}&xml={file_id}"
            logger.info(f"DEBUG: Constructed app_url={app_url}")
        else:
            logger.info(f"DEBUG: Cannot construct URL - base_url={base_url}, pdf_stable_id={pdf_stable_id}, file_id={file_id}")

        # Format message using Discord embed
        fields = [
            {
                "name": "Collection",
                "value": ", ".join(collection_names),
                "inline": True
            },
            {
                "name": "Completion",
                "value": completion_text,
                "inline": True
            },
            {
                "name": "Document",
                "value": doc_title,
                "inline": False
            },
            {
                "name": "Change",
                "value": revision_info["desc"],
                "inline": True
            },
            {
                "name": "Status",
                "value": revision_info["status"],
                "inline": True
            },
            {
                "name": "Who",
                "value": revision_info["who_name"],
                "inline": True
            },
            {
                "name": "When",
                "value": revision_info["when"],
                "inline": True
            }
        ]

        # Add "Open document" link if URL is available
        if app_url:
            fields.append({
                "name": "Open document",
                "value": f"[Click here]({app_url})",
                "inline": False
            })

        embed = {
            "title": "📝 New Document Revision",
            "color": 5814783,  # Blue color
            "fields": fields,
            "timestamp": revision_info["when_iso"]
        }

        payload = {"embeds": [embed]}

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(webhook_url, json=payload, timeout=10.0)
                response.raise_for_status()
                logger.info(f"Posted revision notification to Discord: {doc_title}")
        except httpx.HTTPError as e:
            logger.error(f"Failed to post to Discord webhook: {e}")
