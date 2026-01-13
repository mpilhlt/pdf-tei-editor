# Discord Audit Trail Plugin Implementation Plan

## Overview

Backend plugin that posts document save notifications to a Discord channel via webhooks, capturing revision metadata from TEI documents.

## Technical Requirements

### Event Bus Integration

1. **Event emission in files_save.py**
   - Add event emission before saving to repository (after validation, before `file_repo.insert_file()` or `file_repo.update_file()`)
   - Event name: `"document.save"`
   - Event payload:
     ```python
     {
         "file_id": str,           # stable_id or doc_id
         "doc_id": str,            # document ID
         "xml_content": str,       # TEI XML content
         "file_metadata": dict,    # FileMetadata object data
         "collections": list[str], # collection IDs
         "is_gold": bool,          # is_gold_standard flag
         "version": int | None,    # version number
         "variant": str | None     # variant name
     }
     ```
   - Import: `from ..lib.event_bus import get_event_bus`
   - Call: `await get_event_bus().emit("document.save", ...)`

### Plugin Structure

```
fastapi_app/plugins/discord_audit_trail/
├── __init__.py          # Config initialization and plugin registration
├── plugin.py            # Main plugin class with event handler
└── tests/
    └── test_plugin.py   # Unit tests
```

### Configuration

**In `__init__.py`:**

```python
from fastapi_app.lib.plugin_tools import get_plugin_config

# Initialize config from environment variables
get_plugin_config(
    "plugin.discord-audit-trail.enabled",
    "DISCORD_AUDIT_TRAIL_ENABLED",
    default=True,
    value_type="boolean"
)

get_plugin_config(
    "plugin.discord-audit-trail.webhook-url",
    "DISCORD_AUDIT_TRAIL_WEBHOOK_URL",
    default=""
)

from .plugin import DiscordAuditTrailPlugin

plugin = DiscordAuditTrailPlugin()
```

### Plugin Class Structure

**In `plugin.py`:**

```python
from fastapi_app.lib.plugin_base import Plugin
from fastapi_app.lib.event_bus import get_event_bus
from fastapi_app.lib.config_utils import get_config
from lxml import etree
import httpx
from datetime import datetime, timezone
from typing import Any
import logging

logger = logging.getLogger(__name__)

class DiscordAuditTrailPlugin(Plugin):
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
    """

    def __init__(self):
        super().__init__()
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

    def get_endpoints(self) -> dict[str, callable]:
        return {}  # No endpoints

    async def _handle_document_save(self, **kwargs):
        """Event handler for document.save events."""
        try:
            # Check if enabled
            config = get_config()
            enabled = config.get("plugin.discord-audit-trail.enabled", default=True)
            webhook_url = config.get("plugin.discord-audit-trail.webhook-url", default="")

            if not enabled or not webhook_url:
                logger.debug("Discord audit trail disabled or webhook URL not configured")
                return

            # Extract event data
            xml_content = kwargs.get("xml_content")
            file_metadata = kwargs.get("file_metadata")
            collections = kwargs.get("collections", [])

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
            doc_title = self._extract_document_title(xml_root, file_metadata)

            # Post to Discord
            await self._post_to_discord(
                webhook_url,
                revision_info,
                collection_names,
                doc_title
            )

        except Exception as e:
            logger.error(f"Error in Discord audit trail handler: {e}", exc_info=True)

    def _extract_recent_revision(self, xml_root) -> dict | None:
        """Extract most recent change element if within 60 seconds.

        Returns:
            dict with keys: when, desc, who_id, who_name
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
                # Parse ISO 8601 timestamp
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

        return {
            "when": most_recent_dt.isoformat(),
            "desc": desc,
            "who_id": who_id,
            "who_name": who_name
        }

    def _extract_document_title(self, xml_root, file_metadata: dict) -> str:
        """Extract document title from TEI or metadata."""
        # Try TEI title first
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}
        title_elem = xml_root.find(".//tei:titleStmt/tei:title[@type='main']", ns)
        if title_elem is not None and title_elem.text:
            return title_elem.text.strip()

        # Fallback to metadata label
        if file_metadata and "label" in file_metadata:
            return file_metadata["label"]

        # Fallback to doc_id
        if file_metadata and "doc_id" in file_metadata:
            return file_metadata["doc_id"]

        return "Unknown document"

    def _resolve_collection_names(self, collection_ids: list[str]) -> list[str]:
        """Resolve collection IDs to human-readable names."""
        from fastapi_app.lib.dependencies import get_db
        from fastapi_app.lib.database import Database

        if not collection_ids:
            return ["No collection"]

        try:
            db = get_db()
            names = []

            for coll_id in collection_ids:
                coll_data = db.read('collections', coll_id)
                if coll_data and 'label' in coll_data:
                    names.append(coll_data['label'])
                else:
                    names.append(coll_id)

            return names
        except Exception as e:
            logger.warning(f"Could not resolve collection names: {e}")
            return collection_ids

    async def _post_to_discord(
        self,
        webhook_url: str,
        revision_info: dict,
        collection_names: list[str],
        doc_title: str
    ):
        """Post formatted message to Discord webhook."""
        # Format message using Discord embed
        embed = {
            "title": "📝 New Document Revision",
            "color": 5814783,  # Blue color
            "fields": [
                {
                    "name": "Collection",
                    "value": ", ".join(collection_names),
                    "inline": False
                },
                {
                    "name": "Document",
                    "value": doc_title,
                    "inline": False
                },
                {
                    "name": "Change",
                    "value": revision_info["desc"],
                    "inline": False
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
            ],
            "timestamp": revision_info["when"]
        }

        payload = {"embeds": [embed]}

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(webhook_url, json=payload, timeout=10.0)
                response.raise_for_status()
                logger.info(f"Posted revision notification to Discord: {doc_title}")
        except httpx.HTTPError as e:
            logger.error(f"Failed to post to Discord webhook: {e}")
```

## Implementation Steps

1. **Emit document.save event in files_save.py** (3 locations)
   - After validation, before save in update path (line ~330)
   - After validation, before save in new version path (line ~415)
   - After validation, before save in new gold path (line ~485)
   - Emit with full payload including XML content and metadata

2. **Create plugin directory structure**
   - `fastapi_app/plugins/discord_audit_trail/`
   - `__init__.py`, `plugin.py`, `tests/` directory

3. **Implement `__init__.py`**
   - Initialize config keys using `get_plugin_config()`
   - Import and register plugin

4. **Implement `plugin.py`**
   - Plugin class with metadata (no user endpoints)
   - Event handler registration in `__init__()`
   - `_handle_document_save()` event handler
   - `_extract_recent_revision()` - parse revisionDesc/change elements
   - `_extract_document_title()` - extract title from TEI
   - `_resolve_collection_names()` - lookup collection labels
   - `_post_to_discord()` - format and send webhook

5. **Add tests in `tests/test_plugin.py`**
   - Test event handler with mock webhook
   - Test revision extraction (recent vs old)
   - Test config checks (enabled, webhook URL)
   - Test person name lookup
   - Test collection name resolution

## Key Patterns

### Event Bus Usage
```python
from fastapi_app.lib.event_bus import get_event_bus

# In files_save.py (before save operations)
await get_event_bus().emit("document.save",
    file_id=file_id,
    doc_id=doc_id,
    xml_content=xml_string,
    file_metadata={...},
    collections=doc_collections,
    is_gold=is_gold_standard,
    version=version,
    variant=variant
)

# In plugin (on registration)
event_bus = get_event_bus()
event_bus.on("document.save", self._handle_document_save)
```

### TEI XPath Queries
```python
ns = {"tei": "http://www.tei-c.org/ns/1.0"}

# Get all changes with timestamps
changes = xml_root.xpath("//tei:revisionDesc/tei:change[@when]", namespaces=ns)

# Get description child
desc = change.find("tei:desc", ns)

# Lookup person by xml:id
person = xml_root.xpath(f"//tei:respStmt/tei:persName[@xml:id='{who_id}']", namespaces=ns)
```

### Discord Webhook Format
```python
payload = {
    "embeds": [{
        "title": "📝 New Document Revision",
        "color": 5814783,  # Hex color as decimal
        "fields": [
            {"name": "Field Name", "value": "Field Value", "inline": False}
        ],
        "timestamp": "2024-01-13T12:00:00Z"
    }]
}
```

## Testing Strategy

1. **Unit tests** (`tests/test_plugin.py`)
   - Mock `get_event_bus()` to verify event registration
   - Mock `httpx.AsyncClient` for webhook calls
   - Test XML parsing with sample TEI documents
   - Test timestamp age filtering (< 60s vs > 60s)
   - Test config checks (enabled/disabled, URL presence)

2. **Integration test** (manual or in plugin tests)
   - Configure webhook URL in `.env.test`
   - Trigger document save via API
   - Verify Discord message appears in channel

## Environment Configuration

**`.env` file:**
```bash
DISCORD_AUDIT_TRAIL_ENABLED=true
DISCORD_AUDIT_TRAIL_WEBHOOK_URL=https://discord.com/api/webhooks/123456789/abcdef...
```

**`data/db/config.json`** (overrides env):
```json
{
  "plugin.discord-audit-trail.enabled": true,
  "plugin.discord-audit-trail.webhook-url": "https://discord.com/api/webhooks/..."
}
```

## Dependencies

- `httpx` - Already in requirements.txt for async HTTP requests
- `lxml` - Already in requirements.txt for TEI XML parsing

## Notes

- Plugin has no user-facing endpoints (system plugin only)
- Event handler runs asynchronously, won't block save operations
- Errors in event handler are logged but don't affect document save
- 60-second threshold prevents notification spam on bulk imports
- Discord webhooks support rich embeds with formatting and timestamps
- Collection name resolution uses existing Database API
