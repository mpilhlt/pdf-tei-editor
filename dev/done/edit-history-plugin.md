# Edit history plugin

`docs/code-assistant/backend-plugins.md`

Write a backend plugin that creates a report about recent activity in the current collection. It should output a table:

|Change Date|Document id|Extraction label|Change Description|Who
|---|---|---|---|---
|2025-12-28 15:00:10|10.3456.abcd|Changes Christian|Final Corrections|Christian Boulanger
...

- Most of the data in the table is not in the database. You need to look up all artifacts of the current variant for all documents in a collection and extract the information from it (see `fastapi_app/plugins/iaa_analyzer/plugin.py` on how to do this).
- Data on the change is in the last `/TEI/teiHeader/revisionDesc/change`, in the @who and @when attributes, and the description as the text content or in the `./desc` subelement
- The table should be sortable by clicking on the header with "up" and "down" icons for sorting ascending and descending. Don't implement from scratch, use a library from CDN
- When clicking on the entries in the "Document label" column, the corresponding artifact should open in the editor, and the plugin result window closes.
- The table can be exported as CSV through a route similarly to the other plugin

## Implementation Summary

**Files Created:**
- [fastapi_app/plugins/edit_history/__init__.py](../../fastapi_app/plugins/edit_history/__init__.py) - Plugin registration
- [fastapi_app/plugins/edit_history/plugin.py](../../fastapi_app/plugins/edit_history/plugin.py) - Main plugin implementation
- [fastapi_app/plugins/edit_history/routes.py](../../fastapi_app/plugins/edit_history/routes.py) - CSV export route

**Files Modified:**
- [app/src/plugins/backend-plugins.js](../../app/src/plugins/backend-plugins.js) - Added `exportUrl` support (with backward compatibility for `pdf` parameter)
- [fastapi_app/plugins/iaa_analyzer/plugin.py](../../fastapi_app/plugins/iaa_analyzer/plugin.py) - Updated to use `exportUrl` pattern

**Features:**

1. **Backend Plugin Structure** - Plugin with metadata, category "analyzer", required roles ["user"], state parameters ["collection", "variant"]

2. **Data Extraction** - Extracts edit history from TEI documents:
   - Gets all TEI files in current collection (filtered by variant if specified)
   - Extracts from `/TEI/teiHeader/revisionDesc/change[last()]`
   - Gets `@who` and `@when` attributes
   - Gets description from text content or `./desc` subelement
   - Uses `edition_title` (extraction label) from `/TEI/teiHeader/editionStmt/edition/title`, falls back to document title
   - Formats dates with non-breaking space to prevent wrapping

3. **Sortable Table** - Uses DataTables library (jQuery plugin) from CDN:
   - Sortable columns with ascending/descending icons
   - Default sort: most recent changes first (date descending)
   - Pagination (25 entries per page)
   - Striped rows using DataTables "stripe" class
   - Search/filter functionality built into DataTables

4. **Interactive Document Links** - Clicking extraction label opens document:
   - Uses `window.pluginSandbox.openDocument()` to open artifact
   - Closes plugin result window automatically

5. **CSV Export** - Generic export mechanism:
   - Export button in plugin result dialog (reuses existing UI)
   - Route at `/api/plugins/edit-history/export?collection=...&variant=...&session_id=...`
   - Returns CSV with proper Content-Disposition header
   - Includes authentication and access control checks
   - Generic `exportUrl` pattern introduced (deprecated `pdf` parameter for backward compatibility)

**Key Implementation Details:**

- Used `FileRepository.get_files_by_collection()` to get collection files
- Used `extract_tei_metadata()` from `tei_utils.py` for consistent metadata extraction
- Table rendered server-side, DataTables provides client-side sorting/filtering/pagination
- Export URL passed via `exportUrl` key in response (new generic pattern)
- IAA analyzer plugin updated to use the same `exportUrl` pattern
- Non-breaking space (`\u00a0`) in date formatting prevents line wrapping in table cells

## Testing Summary (2025-12-30)

Created comprehensive test suite for edit_history export route in [fastapi_app/plugins/edit_history/tests/test_edit_history_export.py](../../fastapi_app/plugins/edit_history/tests/test_edit_history_export.py:1):

**Test Coverage:**

- Authentication checks (no session, invalid session, no user)
- Authorization checks (no collection access)
- CSV export success with data
- Variant filtering
- Empty results handling

**Testing Pattern:**

- Uses FastAPI TestClient with dependency overrides
- Mocks session/auth managers via dependency injection
- Mocks `get_db()` and `get_file_storage()` function calls via @patch
- Mocks FileRepository class to return test data
- Validates CSV format, headers, and content

**Key Learning:**

When testing FastAPI routes that mix dependency injection with direct function calls, use both approaches:

- Override dependencies in setUp() for consistent mocks across tests
- Use @patch for functions called inside routes (get_db, get_settings, etc.)
- Mock at correct import path (where used, not where defined)

All 7 tests passing.

## Bug Fixes (2025-12-30)

Fixed two issues with the edit_history plugin:

1. **Sandbox client iframe support** - Updated [plugin_tools.py](../../fastapi_app/lib/plugin_tools.py:133-139) `generate_sandbox_client_script()` to support both iframe and popup contexts:
   - Changed from `window.opener` only to `window.parent !== window ? window.parent : window.opener`
   - Now works in iframes (uses `window.parent`) and new windows (uses `window.opener`)
   - Fixes "sandbox is not defined" error when clicking links in iframe-displayed results

2. **Full name lookup for annotators** - Updated name resolution in both [routes.py](../../fastapi_app/plugins/edit_history/routes.py:298-311) and [plugin.py](../../fastapi_app/plugins/edit_history/plugin.py:123-134):
   - Changed from displaying user ID to displaying full name from `titleStmt/respStmt/persName[@xml:id]`
   - Added XML namespace declaration for `xml:id` attribute lookup
   - Updated test to verify full name appears instead of ID

All tests still passing after fixes.

## Refactoring Summary (2025-12-30)

Refactored to use iframe-based rendering with `outputUrl` instead of injecting HTML into dialog:

**Backend Changes:**

- Added `/view` route in [routes.py](../../fastapi_app/plugins/edit_history/routes.py:26) that returns complete HTML page using `generate_datatable_page()` utility
- Simplified [plugin.py](../../fastapi_app/plugins/edit_history/plugin.py:52) `show_history()` to return `outputUrl` instead of generating HTML
- Removed `_generate_html_table()` and `_escape_html()` methods (now handled by generic utilities)
- Added static file serving support for plugins via [plugin_manager.py](../../fastapi_app/lib/plugin_manager.py:144-174)
- Created `generate_datatable_page()` utility in [plugin_tools.py](../../fastapi_app/lib/plugin_tools.py:258-387) for reusable table generation

**Frontend Changes:**

- Added `outputUrl` support to [backend-plugins.js](../../app/src/plugins/backend-plugins.js:348-391) with iframe rendering
- Added "Open in new window" button in [backend-plugins-result-dialog.html](../../app/src/templates/backend-plugins-result-dialog.html:7-10)
- Created singleton `pluginSandbox` instance for inter-window communication
- Extracted `configureExportButton()` method to avoid code duplication

**Benefits:**

- Cleaner separation: route generates full HTML page, plugin just returns URLs
- No more innerHTML script execution issues
- Sandbox client works properly in standalone pages
- jQuery/DataTables load once in dedicated page
- User can open results in new window for better visibility
- Generic table generation utility can be reused by other plugins
- Reduced code duplication across plugins

## Additional Fixes (2025-12-30)

Fixed two remaining issues with iframe communication and name lookup:

1. **Strip "#" prefix from @who attribute** - Updated [routes.py](../../fastapi_app/plugins/edit_history/routes.py:301) and [plugin.py](../../fastapi_app/plugins/edit_history/plugin.py:124):
   - Changed `who_id = last_change.get("who", "")` to `who_id = last_change.get("who", "").lstrip("#")`
   - TEI documents use "#cboulanger" format in `@who` attribute, but `@xml:id` uses "cboulanger" without prefix
   - Stripping "#" allows successful lookup of full names from `persName[@xml:id]`

2. **Iframe message handler** - [backend-plugin-sandbox.js](../../app/src/modules/backend-plugin-sandbox.js:33-34) already had permanent message handler:
   - Constructor sets up `messageHandler` that listens for both iframe and popup messages
   - Uses `event.source.postMessage()` to respond to correct source window
   - Enables clicking extraction labels in iframe-displayed results to open documents

All 7 tests passing after fixes.

## Code Refactoring (2025-12-30)

Factored out annotator lookup logic to reusable utility:

- Added `get_annotator_name(tei_root, who_id)` to [tei_utils.py](../../fastapi_app/lib/tei_utils.py:485-515):
  - Handles "#" prefix stripping automatically
  - Looks up full name from `persName[@xml:id]` in `respStmt`
  - Returns full name or falls back to ID if not found
  - Can be reused by other plugins/code that needs annotator name lookup

- Updated [routes.py](../../fastapi_app/plugins/edit_history/routes.py:303) and [plugin.py](../../fastapi_app/plugins/edit_history/plugin.py:126) to use the utility
- Removed duplicate XML namespace declarations and lookup logic
- All tests still passing

## Plugin Updates (2025-12-30)

Updated all analyzer plugins to display annotator names instead of IDs:

**Annotation Versions Analyzer:**
- [plugin.py](../../fastapi_app/plugins/annotation_versions_analyzer/plugin.py:188-190) now uses `get_annotator_name()` to display full names
- Added `last_annotator_id` field to version info dictionary
- [routes.py](../../fastapi_app/plugins/annotation_versions_analyzer/routes.py:96) CSV export now includes both "Annotator ID" and "Annotator Name" columns

**IAA Analyzer:**
- [plugin.py](../../fastapi_app/plugins/iaa_analyzer/plugin.py:212-214) now uses `get_annotator_name()` to display full names
- Added `annotator_id` field to metadata dictionary
- [routes.py](../../fastapi_app/plugins/iaa_analyzer/routes.py:127-133) CSV export now includes both "Annotator ID 1/2" and "Annotator Name 1/2" columns

**Edit History:**
- [routes.py](../../fastapi_app/plugins/edit_history/routes.py:302-305) CSV export now includes both "Annotator ID" and "Annotator Name" columns
- Added `who_id` field to history entries (ID without "#" prefix)
- [tests](../../fastapi_app/plugins/edit_history/tests/test_edit_history_export.py:202-208) updated to verify both ID and name in CSV

All plugins now consistently display annotator full names in UI and export both IDs (without "#") and names in CSV files.
