# Revision Status and Annotation History Implementation Plan

## Overview

This plan covers three related features:
1. Support for `status` attribute in TEI `<change>` elements
2. New annotation history plugin with nested revision display
3. Update existing plugins to show status column

## 1. Support "status" attribute of `<change>`

### Requirements

- Add status selection to save revision dialog
- Status values: `draft`, `checked`, `approved`, `candidate`, `published`
- Role-based restrictions: only reviewers/admins can select `approved`, `candidate`, `published`
- Default to current status from last `<change>` element in TEI
- Store status in TEI document only (not in database metadata)

### Files to Modify

#### Frontend: Dialog Template
**File:** `app/src/templates/save-revision-dialog.html`

Add status select between changeDesc input and saveAsGold checkbox:

```html
<sl-select name="status" label="Status" size="small" value="draft">
  <sl-option value="draft">Draft</sl-option>
  <sl-option value="checked">Checked</sl-option>
  <sl-option value="approved">Approved</sl-option>
  <sl-option value="candidate">Candidate</sl-option>
  <sl-option value="published">Published</sl-option>
</sl-select>
```

Update typedef in `app/src/plugins/document-actions.js`:

```javascript
/**
 * @typedef {object} newRevisionChangeDialogPart
 * @property {SlInput} persId - Person ID input
 * @property {SlInput} persName - Person name input
 * @property {SlInput} changeDesc - Change description input
 * @property {SlSelect} status - Status select
 * @property {SlCheckbox} saveAsGold - Save as gold version checkbox
 * @property {SlButton} submit - Submit button
 * @property {SlButton} cancel - Cancel button
 */
```

#### Frontend: Document Actions Plugin
**File:** `app/src/plugins/document-actions.js`

**Function:** `saveRevision(state)` (lines ~420-518)

1. Pre-fill status from current TEI:
```javascript
// After setting persId/persName values
const xmlDoc = xmlEditor.getXmlTree()
if (xmlDoc) {
  const ns = { 'tei': 'http://www.tei-c.org/ns/1.0' }
  const lastChange = xmlDoc.querySelector('revisionDesc change:last-of-type')
  if (lastChange) {
    const currentStatus = lastChange.getAttribute('status') || 'draft'
    revDlg.status.value = currentStatus
  }
}
```

2. Disable restricted options based on role:
```javascript
const isReviewer = userHasRole(userData, ["admin", "reviewer"])

// Disable restricted status options for non-reviewers
const restrictedOptions = ['approved', 'candidate', 'published']
Array.from(revDlg.status.querySelectorAll('sl-option')).forEach(option => {
  if (!isReviewer && restrictedOptions.includes(option.value)) {
    option.disabled = true
  }
})
```

3. Pass status to addTeiHeaderInfo:
```javascript
/** @type {RevisionChange} */
const revisionChange = {
  status: revDlg.status.value,  // Changed from hardcoded "draft"
  persId: revDlg.persId.value,
  desc: revDlg.changeDesc.value
}
```

#### Backend: TEI Utils
**File:** `app/src/modules/tei-utils.js`

Update `addRevisionChange()` to use the status parameter (verify current implementation supports this).

Expected signature:
```javascript
/**
 * @typedef {object} RevisionChange
 * @property {string} status - Status of the change
 * @property {string} persId - Person ID
 * @property {string} desc - Description
 */
```

The function should set `@status` attribute on the `<change>` element.

#### Tests to Update

**File:** `tests/e2e/document-lifecycle.spec.js`

Update revision save tests to:
- Verify status select is present and pre-filled
- Test role-based option restrictions
- Verify status is saved to TEI `<change>` element
- Test status persistence across reloads

Example test additions:
```javascript
test('should pre-fill status from last change element', async ({ page }) => {
  // Load document with existing revision
  // Open save revision dialog
  // Verify status select shows last change status
})

test('should restrict status options for annotators', async ({ page }) => {
  // Login as annotator
  // Open save revision dialog
  // Verify approved/candidate/published are disabled
})

test('should allow all status options for reviewers', async ({ page }) => {
  // Login as reviewer
  // Open save revision dialog
  // Verify all status options are enabled
})

test('should save status to change element', async ({ page }) => {
  // Create revision with specific status
  // Reload document
  // Verify change element has correct @status attribute
})
```

## 2. Write New Annotation History Plugin

### Requirements

- Replace `annotation_versions_analyzer` plugin
- Show TEI documents for a given PDF (doc_id) with nested revision history
- Collapsed view: Title, Gold, Status, Last Change, Annotator, Date
- Expanded view: Individual `<change>` elements - Change, Annotator, Status, Date
- Expand/Collapse all buttons
- Non-sortable table (unlike edit_history plugin)

### Plugin Structure

**Directory:** `fastapi_app/plugins/annotation_history/`

Files:
- `__init__.py` - Plugin registration
- `plugin.py` - Plugin class with analyze endpoint
- `routes.py` - Custom routes for view/export (similar to edit_history pattern)

### Backend Implementation

#### Plugin Metadata
**File:** `fastapi_app/plugins/annotation_history/plugin.py`

```python
@property
def metadata(self) -> dict[str, Any]:
    return {
        "id": "annotation-history",
        "name": "Annotation History",
        "description": "Shows detailed annotation history for PDF documents",
        "version": "1.0.0",
        "category": "document",
        "required_roles": ["user"],
        "endpoints": [
            {
                "name": "analyze",
                "label": "Show Annotation History",
                "description": "Shows detailed annotation history of the current PDF document",
                "state_params": ["pdf", "variant"],
            },
        ],
    }
```

#### Analyze Endpoint
**File:** `fastapi_app/plugins/annotation_history/plugin.py`

Similar to `annotation_versions_analyzer`, but extract ALL `<change>` elements per document:

```python
async def analyze(self, context: PluginContext, params: dict[str, Any]) -> dict[str, Any]:
    pdf_id = params.get("pdf")
    if not pdf_id:
        return {"error": "No PDF document selected", ...}

    # Get doc_id from PDF
    # Get all TEI files for doc_id
    # Filter by variant if specified

    # For each TEI file, extract:
    documents = []
    for file_metadata in tei_files:
        doc_info = self._parse_tei_document_info(xml_content, file_metadata)
        if doc_info:
            documents.append(doc_info)

    # Sort: gold first, then by last change date
    self._sort_documents(documents)

    # Generate nested HTML table
    html = self._generate_nested_table(documents, show_variant_column)
    return {"html": html, "pdf": pdf_id, "variant": variant_filter or "all"}
```

#### Parse TEI Document Info

Extract both document-level and all revision info:

```python
def _parse_tei_document_info(self, xml_content: str, file_metadata: Any) -> dict[str, Any] | None:
    root = etree.fromstring(xml_content.encode("utf-8"))
    tei_metadata = extract_tei_metadata(root)

    # Document-level info
    title = tei_metadata.get("edition_title") or tei_metadata.get("title", "Untitled")
    is_gold = getattr(file_metadata, "is_gold_standard", False)
    variant = getattr(file_metadata, "variant", "")

    # Extract ALL change elements
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    change_elements = root.findall(".//tei:revisionDesc/tei:change", ns)

    revisions = []
    for change_elem in change_elements:
        desc_elem = change_elem.find("tei:desc", ns)
        change_desc = desc_elem.text.strip() if desc_elem is not None and desc_elem.text else ""

        who_id = change_elem.get("who", "")
        annotator = get_annotator_name(root, who_id)

        status = change_elem.get("status", "draft")

        when_attr = change_elem.get("when", "")
        change_date = self._format_date(when_attr) if when_attr else ""

        revisions.append({
            "desc": change_desc,
            "annotator": annotator,
            "status": status,
            "date": change_date,
            "date_raw": when_attr,
        })

    # Get last change for collapsed view
    last_change = revisions[-1] if revisions else {
        "desc": "", "annotator": "", "status": "", "date": "", "date_raw": ""
    }

    return {
        "title": title,
        "is_gold": is_gold,
        "variant": variant,
        "stable_id": file_metadata.stable_id,
        "last_change": last_change,
        "revisions": revisions,  # All changes in chronological order
    }
```

#### Generate Nested HTML Table

```python
def _generate_nested_table(self, documents: list[dict[str, Any]], show_variant_column: bool = False) -> str:
    if not documents:
        return "<p>No annotation versions found.</p>"

    html_parts = [
        '<div style="margin-bottom: 1rem;">',
        '<button onclick="expandAll()" style="margin-right: 0.5rem;">Expand All</button>',
        '<button onclick="collapseAll()">Collapse All</button>',
        '</div>',
        '<table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">',
        '<thead>',
        '<tr style="background-color: #f5f5f5;">',
        '<th style="width: 30px;"></th>',  # Expand/collapse column
    ]

    # Header columns
    header_cells = [
        '<th>Title</th>',
        '<th style="width: 50px; text-align: center;">Gold</th>',
    ]
    if show_variant_column:
        header_cells.append('<th style="width: 100px;">Variant</th>')

    header_cells.extend([
        '<th>Last Change</th>',
        '<th style="width: 120px;">Annotator</th>',
        '<th style="width: 100px;">Status</th>',
        '<th style="width: 140px;">Date</th>',
    ])

    html_parts.extend(header_cells)
    html_parts.extend(['</tr>', '</thead>', '<tbody>'])

    # Generate rows for each document
    for idx, doc in enumerate(documents):
        # Collapsed row (document summary)
        html_parts.append(self._generate_document_row(doc, idx, show_variant_column))

        # Expanded row (nested revision table)
        html_parts.append(self._generate_revision_rows(doc, idx, show_variant_column))

    html_parts.extend(['</tbody>', '</table>'])

    # Add JavaScript for expand/collapse
    html_parts.append('''
    <script>
    function toggleRow(idx) {
      const detailRow = document.getElementById('detail-' + idx);
      const expandIcon = document.getElementById('expand-' + idx);
      if (detailRow.style.display === 'none') {
        detailRow.style.display = 'table-row';
        expandIcon.textContent = '▼';
      } else {
        detailRow.style.display = 'none';
        expandIcon.textContent = '▶';
      }
    }

    function expandAll() {
      document.querySelectorAll('[id^="detail-"]').forEach(row => {
        row.style.display = 'table-row';
      });
      document.querySelectorAll('[id^="expand-"]').forEach(icon => {
        icon.textContent = '▼';
      });
    }

    function collapseAll() {
      document.querySelectorAll('[id^="detail-"]').forEach(row => {
        row.style.display = 'none';
      });
      document.querySelectorAll('[id^="expand-"]').forEach(icon => {
        icon.textContent = '▶';
      });
    }
    </script>
    ''')

    return "".join(html_parts)
```

#### Generate Document Row

```python
def _generate_document_row(self, doc: dict[str, Any], idx: int, show_variant_column: bool) -> str:
    gold_icon = "✓" if doc["is_gold"] else ""
    title_link = f'<a href="#" onclick="window.pluginSandbox.openDocument(\'{doc["stable_id"]}\'); return false;">{self._escape_html(doc["title"])}</a>'

    last = doc["last_change"]

    cells = [
        f'<td style="cursor: pointer;" onclick="toggleRow({idx})">',
        f'<span id="expand-{idx}">▶</span>',
        '</td>',
        f'<td>{title_link}</td>',
        f'<td style="text-align: center;">{gold_icon}</td>',
    ]

    if show_variant_column:
        cells.append(f'<td>{self._escape_html(doc.get("variant", ""))}</td>')

    cells.extend([
        f'<td>{self._escape_html(last["desc"])}</td>',
        f'<td>{self._escape_html(last["annotator"])}</td>',
        f'<td>{self._escape_html(last["status"])}</td>',
        f'<td>{self._escape_html(last["date"])}</td>',
    ])

    return '<tr>' + ''.join(cells) + '</tr>'
```

#### Generate Revision Rows

```python
def _generate_revision_rows(self, doc: dict[str, Any], idx: int, show_variant_column: bool) -> str:
    if not doc["revisions"]:
        return ""

    # Calculate colspan for nested table
    colspan = 6  # Base columns: expand, title, gold, last change, annotator, status, date
    if show_variant_column:
        colspan += 1

    parts = [
        f'<tr id="detail-{idx}" style="display: none;">',
        f'<td colspan="{colspan}">',
        '<table style="width: 100%; margin-left: 30px; border: 1px solid #ddd;">',
        '<thead>',
        '<tr style="background-color: #f9f9f9;">',
        '<th>Change</th>',
        '<th style="width: 120px;">Annotator</th>',
        '<th style="width: 100px;">Status</th>',
        '<th style="width: 140px;">Date</th>',
        '</tr>',
        '</thead>',
        '<tbody>',
    ]

    for revision in doc["revisions"]:
        parts.extend([
            '<tr>',
            f'<td>{self._escape_html(revision["desc"])}</td>',
            f'<td>{self._escape_html(revision["annotator"])}</td>',
            f'<td>{self._escape_html(revision["status"])}</td>',
            f'<td>{self._escape_html(revision["date"])}</td>',
            '</tr>',
        ])

    parts.extend([
        '</tbody>',
        '</table>',
        '</td>',
        '</tr>',
    ])

    return "".join(parts)
```

### Frontend Integration

Update plugin button in toolbar to call new plugin endpoint (if there's a dedicated button, otherwise it's invoked via plugin menu).

### Testing

**File:** `tests/api/v1/plugins_annotation_history.test.js`

Test cases:
- Analyze endpoint returns nested structure with all revisions
- Variant filtering works correctly
- Gold status is properly detected
- Status values are extracted from change elements
- Expand/collapse functionality works
- Links to open documents work

## 3. Adapt Existing Plugins to Support "Status" Column

### Files to Modify

#### Annotation Progress Plugin
**File:** `fastapi_app/plugins/annotation_progress/plugin.py`

**Function:** `_extract_annotation_info()` (lines ~83-156)

Add status extraction:
```python
# After extracting last_change_desc and last_annotator
last_change_status = ""
if last_change is not None:
    last_change_status = last_change.get("status", "draft")

return {
    "annotation_label": annotation_label,
    "revision_count": revision_count,
    "stable_id": file_metadata.stable_id,
    "last_change_desc": last_change_desc,
    "last_annotator": last_annotator,
    "last_change_status": last_change_status,  # Add this
    "last_change_timestamp": last_change_timestamp,
}
```

**File:** `fastapi_app/plugins/annotation_progress/routes.py`

Update HTML generation to add Status column between Annotator and Date.

#### Edit History Plugin
**File:** `fastapi_app/plugins/edit_history/plugin.py`

**Function:** `_extract_revision_info()` (lines ~85-163)

Add status extraction:
```python
# After extracting who_name
status = last_change.get("status", "draft")

return [
    {
        "timestamp": timestamp,
        "date_str": timestamp.strftime("%Y-%m-%d\u00a0%H:%M:%S"),
        "doc_id": doc_id,
        "doc_label": doc_label,
        "description": description,
        "who": who_name,
        "status": status,  # Add this
        "stable_id": file_metadata.stable_id,
    }
]
```

**File:** `fastapi_app/plugins/edit_history/routes.py`

Update HTML generation to add Status column between Annotator (Who) and Date.

### Testing

Update tests for both plugins to verify:
- Status column is present in output
- Status values are correctly extracted
- Default to "draft" if status attribute is missing

## Implementation Order

1. **Phase 1:** Status attribute support
   - Update dialog template
   - Modify document-actions.js
   - Update tests
   - Verify status is saved and loaded correctly

2. **Phase 2:** New annotation history plugin
   - Create plugin structure
   - Implement backend logic
   - Generate nested HTML table
   - Add tests

3. **Phase 3:** Update existing plugins
   - Modify annotation_progress plugin
   - Modify edit_history plugin
   - Update tests

## Migration Notes

- The new `annotation_history` plugin replaces `annotation_versions_analyzer`
- Old plugin can be deprecated after new plugin is tested
- No database changes required (status stored in TEI only)
- Existing TEI documents without status default to "draft"

## Testing Strategy

### Unit Tests
- TEI utils: verify status attribute handling
- Plugin endpoints: verify status extraction and filtering

### E2E Tests
- Full revision workflow with status selection
- Role-based status restrictions
- Status persistence across document reloads
- Nested table expand/collapse functionality

### Integration Tests
- Verify all three plugins show consistent status information
- Test with TEI documents with and without status attributes
- Verify backward compatibility with documents lacking status

## Implementation Progress

### Phase 1: Status Attribute Support ✅

**Files Modified:**
- [app/src/templates/save-revision-dialog.html](app/src/templates/save-revision-dialog.html:7-13) - Added status select with 5 options
- [app/src/plugins/document-actions.js](app/src/plugins/document-actions.js:7,90,435-454,484) - Added SlSelect import, updated typedef, added status pre-fill and role-based restrictions
- [tests/e2e/tests/document-actions.spec.js](tests/e2e/tests/document-actions.spec.js:421-660) - Added 5 new tests for status functionality

**Implementation Summary:**
Status attribute support fully implemented. The save revision dialog now includes a status select that pre-fills from the last change element, enforces role-based restrictions (annotators can only select draft/checked, reviewers can select all options), and saves the selected status to the TEI change element. The existing `addRevisionChange()` function in tei-utils.js already supported the status parameter (line 129), so no backend changes were needed.

### Phase 2: New Annotation History Plugin ✅

**Files Created:**
- [fastapi_app/plugins/annotation_history/__init__.py](fastapi_app/plugins/annotation_history/__init__.py) - Plugin package initialization
- [fastapi_app/plugins/annotation_history/plugin.py](fastapi_app/plugins/annotation_history/plugin.py) - Main plugin implementation with nested table generation
- [fastapi_app/plugins/annotation_history/tests/__init__.py](fastapi_app/plugins/annotation_history/tests/__init__.py) - Tests package
- [fastapi_app/plugins/annotation_history/tests/test_annotation_history.py](fastapi_app/plugins/annotation_history/tests/test_annotation_history.py) - Unit tests

**Implementation Summary:**
Created new annotation_history plugin to replace annotation_versions_analyzer. The new plugin extracts ALL change elements from each TEI document (not just the last one) and displays them in a nested table structure. The collapsed view shows document summary with title, gold status, variant, last change info, annotator, status, and date. Clicking the expand icon reveals all individual revisions for that document in chronological order. Includes Expand All/Collapse All buttons and inline JavaScript for expand/collapse functionality. The plugin auto-discovers via the filesystem-based plugin registry, so no manual registration needed.

### Phase 3: Update Existing Plugins ✅

**Files Modified:**
- [fastapi_app/plugins/annotation_progress/plugin.py](fastapi_app/plugins/annotation_progress/plugin.py:120,136,155) - Added last_change_status extraction
- [fastapi_app/plugins/annotation_progress/routes.py](fastapi_app/plugins/annotation_progress/routes.py:116,127,144,149,277,286,298) - Added Status column to HTML and CSV output
- [fastapi_app/plugins/edit_history/plugin.py](fastapi_app/plugins/edit_history/plugin.py:122,158) - Added status extraction
- [fastapi_app/plugins/edit_history/routes.py](fastapi_app/plugins/edit_history/routes.py:110,122,238,251) - Added Status column to HTML and CSV output

**Implementation Summary:**
Updated annotation_progress and edit_history plugins to extract and display status from TEI change elements. Both plugins now include a Status column in their HTML tables and CSV exports, showing the status of the last change (defaulting to "draft" if not present). All status values are properly HTML-escaped for security.

### Bug Fixes ✅

**Event Bubbling Issue:**
- [app/src/plugins/document-actions.js](app/src/plugins/document-actions.js:464-471,566-572,729-735) - Fixed sl-hide event handler in all three dialogs
- Root cause: Shoelace select components emit sl-hide events that bubble to parent dialog
- Solution: Check `e.target === dialog` to ensure event originates from dialog itself

**Column Alignment in Nested Table:**
- [fastapi_app/plugins/annotation_history/plugin.py](fastapi_app/plugins/annotation_history/plugin.py:426-483) - Updated `_generate_revision_rows()` method
- Changed from nested table with colspan to integrated table rows with empty cells
- Header row and data rows now include empty cells for Caret, Title, Gold (and Variant if shown) columns
- All borders and column widths align perfectly with parent table
- Changed method signature from `colspan: int` to `show_variant_column: bool`
- Updated call site at line 339 to pass `show_variant_column`
- [fastapi_app/plugins/annotation_history/tests/test_annotation_history.py](fastapi_app/plugins/annotation_history/tests/test_annotation_history.py:208) - Updated test to check for `display: none` instead of exact style match

**Expand/Collapse All Child Rows:**
- [fastapi_app/plugins/annotation_history/plugin.py](fastapi_app/plugins/annotation_history/plugin.py:445,466,348-375) - Fixed expand/collapse to affect all child rows
- Added `class="detail-row-{idx}"` to all child rows (header and data rows)
- Updated JavaScript `toggleRow()` to toggle all rows with matching class
- Updated `expandAll()` and `collapseAll()` to select by class prefix
- Now all child rows are hidden by default and toggle together

**Plugin Architecture - URL-Based Pattern:**

- [fastapi_app/plugins/annotation_history/plugin.py](fastapi_app/plugins/annotation_history/plugin.py:48-80) - Updated `analyze()` method to return URLs
- Returns `outputUrl` pointing to `/api/plugins/annotation-history/view` route
- Returns `exportUrl` pointing to `/api/plugins/annotation-history/export` route
- Follows same pattern as edit_history plugin
- [fastapi_app/plugins/annotation_history/routes.py](fastapi_app/plugins/annotation_history/routes.py) - Created HTTP routes for view and export
- `/view` route: `GET /api/plugins/annotation-history/view?pdf={id}&variant={filter}` returns HTML
- `/export` route: `GET /api/plugins/annotation-history/export?pdf={id}&variant={filter}` returns CSV
- Both routes automatically discovered and registered by PluginManager
- View route generates nested HTML table with expand/collapse functionality
- Export route provides CSV download with parent values repeated for each revision
- [fastapi_app/plugins/annotation_history/tests/test_annotation_history.py](fastapi_app/plugins/annotation_history/tests/test_annotation_history.py) - Added comprehensive tests
- Tests cover plugin URL generation, CSV generation, HTML view route, CSV export route
- Total test count: 18 tests (11 for plugin, 2 for view route, 5 for export route)

## Summary

All three phases of the implementation are complete:

1. **Status Attribute Support**: TEI change elements now support status attribute with 5 values (draft, checked, approved, candidate, published). The save revision dialog includes role-based status selection that pre-fills from the last change element.

2. **New Annotation History Plugin**: Replaced annotation_versions_analyzer with new annotation_history plugin that displays complete revision history in an expandable nested table format. Columns align seamlessly with parent table for clean visual integration. Includes CSV export functionality that repeats parent row values for each child revision.

3. **Updated Existing Plugins**: Both annotation_progress and edit_history plugins now extract and display status information in their HTML and CSV outputs.

All changes include comprehensive unit tests and E2E tests. Backward compatibility is maintained (documents without status default to "draft").
