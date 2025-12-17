# Inter-Annotator Agreement Plugin Implementation Plan

## Implementation Status

✅ **COMPLETED** - Plugin is fully implemented and tested.

## Overview

Backend plugin that computes inter-annotator agreement between all versions of a TEI annotation variant for a PDF document. Returns HTML table with pairwise comparison statistics.

## Example Plugin Reference

See [fastapi_app/plugins/annotation_versions_analyzer/plugin.py](../../fastapi_app/plugins/annotation_versions_analyzer/plugin.py) for a complete example of:

- Plugin metadata structure and endpoint registration
- Using FileRepository to query TEI files by doc_id and variant
- Using file_storage to read file content
- Parsing TEI XML with lxml and extracting metadata using `extract_tei_metadata()`
- Generating styled HTML tables for results
- Proper error handling and logging

See [fastapi_app/plugins/annotation_versions_analyzer/routes.py](../../fastapi_app/plugins/annotation_versions_analyzer/routes.py) for an example of:

- Adding custom routes to a plugin (CSV export endpoint)
- Reusing plugin methods from route handlers to avoid code duplication
- Returning file downloads via StreamingResponse

**IMPORTANT**: The plugin endpoint and any custom routes (like CSV export) should share the same data extraction logic. Extract common functionality into reusable methods that both the plugin endpoint and custom routes can call. This prevents code duplication and ensures consistency.

## Technical Requirements

### Input Parameters

Plugin receives from frontend state:

- `pdf` (state field) - Document ID of the PDF file
- `variant` (state field) - Currently selected variant filter

### Output

HTML table showing:

- Pairwise comparisons between all TEI versions
- Document label
- Annotator ID (last change element)
- Agreement metrics for each pair

### Algorithm: Flattened Element Sequence Agreement

**Configuration Constants:**

Define at module level for both IAA plugin and diff viewer:

```python
# Tags to ignore in element sequence comparison
IGNORE_TAGS = frozenset([
    # Add tags that should be skipped, e.g., 'pb', 'milestone'
])

# Attributes to ignore in element comparison
IGNORE_ATTRIBUTES = frozenset([
    'xml:id',  # Internal IDs vary between versions
    'xml:base',
    # Add other attributes that should be ignored
])
```

**Important:** This applies to BOTH the IAA calculation in the plugin AND the diff viewer. Both must use the same ignore lists for consistency.

**Element Sequence Extraction:**

1. Parse TEI XML and locate the `<text>` element
2. Traverse all descendant elements within `<text>` in document order (depth-first)
3. For each element:
   - Skip if element tag is in `IGNORE_TAGS`
   - Create a token with:
     - Element tag name (without namespace prefix)
     - Element's `.text` (direct text content before any children)
     - Element's `.tail` (text content after the element's closing tag, before next sibling)
     - **All attributes** (except those in `IGNORE_ATTRIBUTES`)
4. Create flattened sequence of element tokens

**Text Normalization:**

- Normalize both `.text` and `.tail` separately
- Strip leading/trailing whitespace from each
- Collapse internal whitespace to single spaces
- Treat empty strings as None
- Case-sensitive comparison

**Handling Nested Elements (lxml model):**

In lxml's tree model:

- `.text` = text immediately inside element, before first child
- `.tail` = text immediately after element's closing tag

Example XML:

```xml
<note place="headnote"><page>1</page>Text of headnote<lb /></note>
```

Produces flattened sequence:

```python
[
  ("note", text=None, tail=None, {"place": "headnote"}),    # No text before <page>, no tail after </note>
  ("page", text="1", tail="Text of headnote", {}),          # Text "1" inside, "Text of headnote" after </page>
  ("lb", text=None, tail=None, {})                          # Self-closing, no text/tail
]
```

**Token Matching:**

Two element tokens match if ALL of the following are identical:

- Tag name
- Normalized `.text` value
- Normalized `.tail` value
- All attribute values (excluding those in `IGNORE_ATTRIBUTES`)

**Pairwise Agreement Calculation:**

For each pair of versions (A, B):

1. Extract flattened sequences: `seq_A` and `seq_B`
2. Compare position-by-position
3. Calculate metrics:
   - **Matches**: Count of matching tokens at same positions
   - **Total**: Maximum length of the two sequences
   - **Agreement**: `matches / total * 100` (percentage)

**Example:**

Version A:

```python
[
  ("note", None, None, {"place": "headnote"}),
  ("page", "1", "Text of headnote", {}),
  ("lb", None, None, {})
]
```

Version B:

```python
[
  ("note", None, None, {"place": "footnote"}),  # Different @place
  ("page", "1", "Text of headnote", {}),
  ("lb", None, None, {})
]
```

Comparison:

```text
Position 0: Different @place attribute           → DIFF
Position 1: All fields match                     → MATCH
Position 2: All fields match                     → MATCH

Matches: 2
Total: 3
Agreement: 66.67%
```

**Edge Cases:**

- Different sequence lengths: Use max length as denominator
- Empty `<text>` elements: Agreement = 0% or N/A
- Single version: No comparisons possible
- Different nesting depths: Handled by depth-first traversal
- Whitespace-only text/tail: Normalized to None

## Implementation Design

### Backend Plugin Structure

**File:** `fastapi_app/plugins/iaa-analyzer/plugin.py`

```python
from fastapi_app.lib.plugin_base import Plugin, PluginContext
from fastapi_app.lib.file_repository import FileRepository
from typing import Any
from lxml import etree
import logging

logger = logging.getLogger(__name__)

# Tags to ignore in element sequence comparison
IGNORE_TAGS = frozenset([
    # Add tags that should be skipped, e.g., 'pb', 'milestone'
])

# Attributes to ignore in element comparison
IGNORE_ATTRIBUTES = frozenset([
    'xml:id',  # Internal IDs vary between versions
    'xml:base',
    # Add other attributes that should be ignored
])

class IAAAnalyzerPlugin(Plugin):
    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "iaa-analyzer",
            "name": "Inter-Annotator Agreement",
            "description": "Compute agreement between annotation versions",
            "category": "analyzer",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [
                {
                    "name": "compute_agreement",
                    "label": "Compute Inter-Annotator Agreement",
                    "description": "Analyze agreement between all TEI versions for current PDF and variant",
                    "state_params": ["pdf", "variant"]
                }
            ]
        }

    def get_endpoints(self) -> dict[str, callable]:
        return {
            "compute_agreement": self.compute_agreement
        }

    async def compute_agreement(self, context: PluginContext, params: dict) -> dict:
        """
        Compute inter-annotator agreement for all TEI versions.

        Args:
            context: Plugin context with app and user
            params: Dict with 'pdf' (doc_id) and 'variant' (variant filter)

        Returns:
            Dict with 'html' key containing result table
        """
        doc_id = params.get('pdf')
        variant = params.get('variant')

        if not doc_id:
            return {"error": "No document selected"}

        # Get all TEI files for this document with matching variant
        file_repo = FileRepository(context.app.state.db_manager)
        tei_files = self._get_tei_files(file_repo, doc_id, variant)

        if len(tei_files) < 2:
            return {"html": "<p>Need at least 2 TEI versions to compare.</p>"}

        # Extract metadata and element sequences
        versions = []
        for tei_file in tei_files:
            metadata = self._extract_metadata(tei_file)
            elements = self._extract_element_sequence(tei_file)
            versions.append({
                "file": tei_file,
                "metadata": metadata,
                "elements": elements
            })

        # Compute pairwise agreements
        comparisons = self._compute_pairwise_agreements(versions)

        # Generate HTML table
        html = self._generate_html_table(comparisons)

        return {"html": html}

    def _get_tei_files(self, file_repo, doc_id, variant):
        """Get all TEI files for document matching variant filter."""
        all_files = file_repo.get_files_by_doc_id(doc_id)
        tei_files = [f for f in all_files if f.file_type == 'xml']

        if variant:
            tei_files = [f for f in tei_files if f.variant_id == variant]

        return tei_files

    def _extract_metadata(self, tei_file):
        """Extract document label and annotator from TEI header."""
        from fastapi_app.lib.dependencies import get_file_storage
        from fastapi_app.lib.tei_utils import extract_tei_metadata

        file_storage = get_file_storage()
        content_bytes = file_storage.read_file(tei_file.id, "tei")
        xml_content = content_bytes.decode("utf-8")
        root = etree.fromstring(xml_content.encode("utf-8"))

        # Use existing utility to extract metadata
        tei_metadata = extract_tei_metadata(root)

        # Get title - prefer edition_title, fallback to title
        title = tei_metadata.get("edition_title") or tei_metadata.get("title", "Untitled")

        # Extract last annotator from revisionDesc
        ns = {'tei': 'http://www.tei-c.org/ns/1.0'}
        last_change_elem = root.find('.//tei:revisionDesc/tei:change[last()]', ns)
        annotator = "Unknown"
        if last_change_elem is not None:
            annotator = last_change_elem.get('who', annotator)

        return {
            "title": title.strip(),
            "annotator": annotator.strip(),
            "stable_id": tei_file.stable_id
        }

    def _extract_element_sequence(self, tei_file):
        """Extract flattened sequence of element tokens from <text> element."""
        from fastapi_app.lib.dependencies import get_file_storage

        file_storage = get_file_storage()
        content_bytes = file_storage.read_file(tei_file.id, "tei")
        xml_content = content_bytes.decode("utf-8")
        root = etree.fromstring(xml_content.encode("utf-8"))

        ns = {'tei': 'http://www.tei-c.org/ns/1.0'}
        text_elem = root.find('.//tei:text', ns)

        if text_elem is None:
            return []

        sequence = []
        # Traverse all descendants in document order
        for elem in text_elem.iter():
            if elem == text_elem:
                continue  # Skip the <text> element itself

            # Skip non-element nodes (comments, processing instructions, etc.)
            if not isinstance(elem.tag, str):
                continue

            # Extract tag name without namespace
            tag = etree.QName(elem).localname

            # Skip ignored tags
            if tag in IGNORE_TAGS:
                continue

            # Normalize text and tail
            text = self._normalize_text(elem.text)
            tail = self._normalize_text(elem.tail)

            # Extract ALL attributes except ignored ones
            attrs = {}
            for attr_name, attr_value in elem.attrib.items():
                # Handle namespaced attributes
                if '}' in attr_name:
                    # Extract local name from {namespace}localname format
                    ns_uri, local = attr_name.split('}')
                    ns_prefix = 'xml' if 'www.w3.org/XML' in ns_uri else None
                    full_name = f'{ns_prefix}:{local}' if ns_prefix else local
                else:
                    full_name = attr_name

                if full_name not in IGNORE_ATTRIBUTES:
                    attrs[full_name] = attr_value

            sequence.append({
                "tag": tag,
                "text": text,
                "tail": tail,
                "attrs": attrs
            })

        return sequence

    def _normalize_text(self, text):
        """Normalize text content: strip, collapse whitespace, return None if empty."""
        if not text:
            return None
        normalized = " ".join(text.split())
        return normalized if normalized else None

    def _compute_pairwise_agreements(self, versions):
        """Compute agreement for all version pairs."""
        comparisons = []

        for i in range(len(versions)):
            for j in range(i + 1, len(versions)):
                v1 = versions[i]
                v2 = versions[j]

                matches = self._count_matches(v1['elements'], v2['elements'])
                total = max(len(v1['elements']), len(v2['elements']))
                agreement = (matches / total * 100) if total > 0 else 0

                comparisons.append({
                    "version1": v1['metadata'],
                    "version2": v2['metadata'],
                    "matches": matches,
                    "total": total,
                    "agreement": round(agreement, 2)
                })

        return comparisons

    def _count_matches(self, seq1, seq2):
        """Count matching element tokens at same positions."""
        matches = 0
        min_len = min(len(seq1), len(seq2))

        for i in range(min_len):
            elem1 = seq1[i]
            elem2 = seq2[i]

            # Elements match if tag, text, tail, and relevant attributes all match
            if (elem1['tag'] == elem2['tag'] and
                elem1['text'] == elem2['text'] and
                elem1['tail'] == elem2['tail'] and
                elem1['attrs'] == elem2['attrs']):
                matches += 1

        return matches

    def _generate_html_table(self, comparisons):
        """Generate HTML table from comparison results."""
        html = """
        <table border="1" cellpadding="8" cellspacing="0">
            <thead>
                <tr>
                    <th>Version 1</th>
                    <th>Annotator 1</th>
                    <th>Version 2</th>
                    <th>Annotator 2</th>
                    <th>Matches</th>
                    <th>Total</th>
                    <th>Agreement (%)</th>
                </tr>
            </thead>
            <tbody>
        """

        for comp in comparisons:
            v1 = comp['version1']
            v2 = comp['version2']
            html += f"""
                <tr>
                    <td>{v1['title']} ({v1['stable_id']})</td>
                    <td>{v1['annotator']}</td>
                    <td>{v2['title']} ({v2['stable_id']})</td>
                    <td>{v2['annotator']}</td>
                    <td>{comp['matches']}</td>
                    <td>{comp['total']}</td>
                    <td>{comp['agreement']}%</td>
                </tr>
            """

        html += """
            </tbody>
        </table>
        """

        return html
```

**File:** `fastapi_app/plugins/iaa-analyzer/__init__.py`

```python
from .plugin import IAAAnalyzerPlugin

plugin = IAAAnalyzerPlugin()
```

### Frontend Integration

Plugin discovery and execution handled automatically by existing `backend-plugins.js`:

1. Menu item labeled "Compute Inter-Annotator Agreement" appears under "Analyzer" category
2. On click, frontend extracts `state.pdf` and `state.variant`
3. Calls `POST /api/v1/plugins/iaa-analyzer/execute` with:

   ```json
   {
     "endpoint": "compute_agreement",
     "params": {
       "pdf": "<doc_id>",
       "variant": "<variant_id>"
     }
   }
   ```

4. Result HTML displayed in modal/alert

### Result Display Enhancement (Optional)

Current implementation uses `alert()` for results. For better HTML table display:

**Option 1: Use Shoelace Dialog**

Update `backend-plugins.js` `displayResult()`:

```javascript
displayResult(plugin, result) {
  if (result.html) {
    const dialog = document.createElement('sl-dialog');
    dialog.label = plugin.name;
    dialog.innerHTML = `
      <div style="max-width: 800px; overflow: auto;">
        ${result.html}
      </div>
      <sl-button slot="footer" variant="primary" onclick="this.closest('sl-dialog').hide()">Close</sl-button>
    `;
    document.body.appendChild(dialog);
    dialog.show();

    // Remove dialog when closed
    dialog.addEventListener('sl-after-hide', () => dialog.remove());
  } else {
    // Fallback for non-HTML results
    const resultText = JSON.stringify(result, null, 2);
    alert(`${plugin.name} Result:\n\n${resultText}`);
  }
}
```

**Option 2: Add Result Panel**

Create dedicated panel in UI for plugin results (out of scope for initial implementation).

## Implementation Steps

### Phase 1: Core Plugin

1. Create plugin directory: `fastapi_app/plugins/iaa-analyzer/`
2. Implement `plugin.py` with metadata and endpoints
3. Implement metadata extraction from TEI headers
4. Implement label sequence extraction
5. Implement pairwise agreement calculation
6. Implement HTML table generation
7. Create `__init__.py` for plugin registration

### Phase 2: Testing

8. Create test fixtures:
   - Sample TEI files with known element structures in `<text>` sections
   - Files with nested elements to test flattening
   - Files with elements containing text, tail, and attributes
   - Multiple variants for testing variant filtering
9. Write unit tests (`tests/unit/fastapi/test_iaa_analyzer.py`):
   - Test element extraction from `<text>` with nested structures
   - Test text/tail normalization (whitespace handling)
   - Test attribute extraction and comparison
   - Test agreement calculation with different sequence lengths
   - Test matching logic (tag + text + tail + attrs)
   - Test variant filtering
   - Test HTML output generation
10. Manual testing:
    - Upload multiple TEI versions
    - Select document and variant
    - Execute plugin from toolbar
    - Verify table accuracy

### Phase 3: Result Display Enhancement

11. Update `backend-plugins.js` to use Shoelace dialog for HTML results
12. Add CSS styling for result tables
13. Test dialog display and responsiveness

### Phase 4: Documentation

14. Update `docs/code-assistant/backend-plugins.md`:
    - Add IAA analyzer as example
    - Document multi-endpoint pattern
    - Document state parameter extraction
15. Add usage instructions to plugin metadata description

## Algorithm Details

### Longest Common Subsequence (LCS)

For more sophisticated alignment (optional enhancement):

```python
def lcs_length(seq1, seq2):
    """Compute LCS length using dynamic programming."""
    m, n = len(seq1), len(seq2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]

    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if seq1[i-1] == seq2[j-1]:
                dp[i][j] = dp[i-1][j-1] + 1
            else:
                dp[i][j] = max(dp[i-1][j], dp[i][j-1])

    return dp[m][n]
```

Initial implementation uses simple position-based matching. LCS can be added later for better handling of insertions/deletions.

### Alternative Agreement Metrics

**Cohen's Kappa:**

```python
def cohens_kappa(seq1, seq2):
    """
    Calculate Cohen's Kappa for inter-annotator agreement.
    Accounts for agreement by chance.
    """
    # Build confusion matrix
    # Calculate observed agreement (Po)
    # Calculate expected agreement (Pe)
    # Kappa = (Po - Pe) / (1 - Pe)
    pass  # Implementation details omitted for brevity
```

Can be added as additional column in results table.

## Key Files

- Plugin implementation: [fastapi_app/plugins/iaa-analyzer/plugin.py](../../fastapi_app/plugins/iaa-analyzer/plugin.py)
- Plugin registration: [fastapi_app/plugins/iaa-analyzer/**init**.py](../../fastapi_app/plugins/iaa-analyzer/__init__.py)
- File repository: [fastapi_app/lib/file_repository.py](../../fastapi_app/lib/file_repository.py)
- Frontend integration: [app/src/plugins/backend-plugins.js](../../app/src/plugins/backend-plugins.js)
- Tests: [tests/unit/fastapi/test_iaa_analyzer.py](../../tests/unit/fastapi/test_iaa_analyzer.py)

## Dependencies

- `lxml` library for TEI XML parsing (already used by `tei_utils.py`)
- `fastapi_app.lib.file_repository.FileRepository` for database access
- `fastapi_app.lib.tei_utils.extract_tei_metadata` for TEI metadata extraction
- `fastapi_app.lib.dependencies` for file storage access
- Existing plugin infrastructure for registration
- Frontend plugin system for execution

## Success Criteria

- Plugin appears in toolbar dropdown under "Analyzer" category
- Clicking plugin item automatically extracts doc_id and variant from state
- Plugin computes agreement for all TEI versions matching criteria
- HTML table displays pairwise comparisons with correct metrics
- Table includes document labels and annotator IDs from TEI headers
- Agreement percentages calculated correctly based on element position matching
- Element matching considers tag name, text, tail, and attributes
- Edge cases handled (0-1 versions, empty `<text>` elements, nested structures)
- Unit tests verify element extraction and agreement calculation
- Result displayed in user-friendly format (dialog or alert)

## Future Enhancements

- LCS-based alignment for handling insertions/deletions
- Cohen's Kappa for chance-corrected agreement
- Visualization (heatmap, confusion matrix)
- Support for different label types (by attribute)
- Weighted agreement (by label importance)
- Inter-rater reliability beyond pairwise (Fleiss' Kappa)

## Phase 5: Side-by-Side XML Diff Viewer

### Overview Phase 5

Add a standalone side-by-side XML diff viewer that shows only differences between TEI annotation versions. Identical sections are skipped. Long lines with partial differences show only the differing portions with inline cropping using visual markers.

**Important:** The diff viewer MUST use the same `IGNORE_TAGS` and `IGNORE_ATTRIBUTES` constants from the IAA plugin to ensure consistency. Both the quantitative metrics and the qualitative diff view should operate on the same filtered data.

### Requirements

**Functionality:**

- Show only sections that differ between documents
- Display line numbers for each diff section
- Skip all identical sections
- Crop identical content within long lines, marking with `<⋯>` visual indicator
- Side-by-side comparison for each difference
- Visual highlighting for added/removed/modified content
- Accessible via link from IAA results table

**Visual Design:**

- Each diff displayed as separate side-by-side block
- Line numbers on left of each pane
- Clear visual separator between diff blocks
- `<⋯>` marker for cropped inline content (styled distinctly)

**Technical Constraints:**

- Standalone HTML page (no integration into main app UI)
- No build dependencies - load all libraries from CDN
- Accept document identifiers via URL parameters
- Authenticate via session ID from query parameter

### Architecture

**Route Handler:**

File: `fastapi_app/plugins/iaa_analyzer/routes.py` (add new endpoint)

```python
def _preprocess_for_diff(elem: etree._Element, ignore_tags: frozenset, ignore_attrs: frozenset) -> etree._Element:
    """
    Create a copy of element tree with ignored tags removed and ignored attributes stripped.

    Args:
        elem: Root element to preprocess
        ignore_tags: Set of tag names to remove
        ignore_attrs: Set of attribute names to remove

    Returns:
        Preprocessed copy of element tree
    """
    # Deep copy to avoid modifying original
    import copy
    elem_copy = copy.deepcopy(elem)

    # Remove ignored tags
    for tag_name in ignore_tags:
        for ignored_elem in elem_copy.xpath(f'.//*[local-name()="{tag_name}"]'):
            ignored_elem.getparent().remove(ignored_elem)

    # Strip ignored attributes from all elements
    for el in elem_copy.iter():
        if not isinstance(el.tag, str):
            continue

        for attr_name in list(el.attrib.keys()):
            # Handle namespaced attributes
            if '}' in attr_name:
                ns_uri, local = attr_name.split('}')
                ns_prefix = 'xml' if 'www.w3.org/XML' in ns_uri else None
                full_name = f'{ns_prefix}:{local}' if ns_prefix else local
            else:
                full_name = attr_name

            if full_name in ignore_attrs:
                del el.attrib[attr_name]

    return elem_copy


@router.get("/diff")
async def show_diff(
    stable_id1: str,
    stable_id2: str,
    session_id: str | None = None,
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    db: Session = Depends(get_db),
):
    """
    Render standalone side-by-side XML diff page showing only differences.

    Query params:
        stable_id1: First document stable ID
        stable_id2: Second document stable ID
        session_id: Session ID for authentication (query param fallback)
    """
    # Authenticate
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(401, "Authentication required")

    # Validate session and get user
    from fastapi_app.lib.session_repository import SessionRepository
    session_repo = SessionRepository(db)
    user = session_repo.get_user_by_session_id(session_id_value)
    if not user:
        raise HTTPException(401, "Invalid session")

    # Fetch both documents
    from fastapi_app.lib.file_repository import FileRepository
    from fastapi_app.lib.dependencies import get_file_storage

    file_repo = FileRepository(db)
    file_storage = get_file_storage()

    file1 = file_repo.get_file_by_stable_id(stable_id1)
    file2 = file_repo.get_file_by_stable_id(stable_id2)

    if not file1 or not file2:
        raise HTTPException(404, "One or both documents not found")

    # Check user access to documents
    if not file_repo.user_has_access(user.id, file1.doc_id) or \
       not file_repo.user_has_access(user.id, file2.doc_id):
        raise HTTPException(403, "Access denied")

    # Read XML content
    xml1 = file_storage.read_file(file1.id, "tei").decode("utf-8")
    xml2 = file_storage.read_file(file2.id, "tei").decode("utf-8")

    # Extract metadata for headers
    from fastapi_app.lib.tei_utils import extract_tei_metadata
    root1 = etree.fromstring(xml1.encode("utf-8"))
    root2 = etree.fromstring(xml2.encode("utf-8"))

    meta1 = extract_tei_metadata(root1)
    meta2 = extract_tei_metadata(root2)

    title1 = meta1.get("edition_title") or meta1.get("title", "Document 1")
    title2 = meta2.get("edition_title") or meta2.get("title", "Document 2")

    # Extract <text> element content for comparison
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    text1_elem = root1.find(".//tei:text", ns)
    text2_elem = root2.find(".//tei:text", ns)

    if text1_elem is None or text2_elem is None:
        raise HTTPException(400, "Documents missing <text> element")

    # Import ignore lists from plugin module for consistency
    from fastapi_app.plugins.iaa_analyzer.plugin import IGNORE_TAGS, IGNORE_ATTRIBUTES

    # Preprocess: remove ignored elements and attributes
    text1_preprocessed = _preprocess_for_diff(text1_elem, IGNORE_TAGS, IGNORE_ATTRIBUTES)
    text2_preprocessed = _preprocess_for_diff(text2_elem, IGNORE_TAGS, IGNORE_ATTRIBUTES)

    # Serialize preprocessed content (pretty-printed)
    text1_xml = etree.tostring(text1_preprocessed, encoding="unicode", pretty_print=True)
    text2_xml = etree.tostring(text2_preprocessed, encoding="unicode", pretty_print=True)

    # Render HTML page with embedded XML
    html = _generate_diff_html(title1, title2, text1_xml, text2_xml)

    return Response(content=html, media_type="text/html")
```

**HTML Template Function:**

```python
def _generate_diff_html(title1: str, title2: str, xml1: str, xml2: str) -> str:
    """Generate standalone HTML page with side-by-side XML diff showing only differences."""

    # Escape XML for embedding in JavaScript
    import json
    xml1_escaped = json.dumps(xml1)
    xml2_escaped = json.dumps(xml2)

    return f"""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>XML Diff: {_escape_html(title1)} vs {_escape_html(title2)}</title>

    <!-- Load diff library from CDN -->
    <script src="https://cdn.jsdelivr.net/npm/diff@5.2.0/dist/diff.min.js"></script>

    <style>
        * {{
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }}

        body {{
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #f5f5f5;
            padding: 20px;
        }}

        .header {{
            background: white;
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}

        .header h1 {{
            font-size: 24px;
            margin-bottom: 10px;
            color: #333;
        }}

        .header .titles {{
            display: flex;
            justify-content: space-between;
            color: #666;
            font-size: 14px;
        }}

        .header .summary {{
            margin-top: 10px;
            padding: 10px;
            background: #f8f9fa;
            border-radius: 4px;
            font-size: 13px;
            color: #495057;
        }}

        .diff-block {{
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin-bottom: 20px;
            overflow: hidden;
        }}

        .diff-block-header {{
            background: #f8f9fa;
            padding: 8px 16px;
            border-bottom: 1px solid #dee2e6;
            font-size: 12px;
            color: #6c757d;
            font-weight: 600;
        }}

        .diff-container {{
            display: flex;
        }}

        .diff-pane {{
            flex: 1;
            padding: 16px;
            font-family: 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            line-height: 1.6;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-x: auto;
        }}

        .diff-pane:first-child {{
            border-right: 2px solid #dee2e6;
        }}

        .diff-line {{
            display: flex;
        }}

        .line-number {{
            color: #999;
            text-align: right;
            padding-right: 12px;
            min-width: 50px;
            user-select: none;
            flex-shrink: 0;
        }}

        .line-content {{
            flex: 1;
        }}

        /* Diff highlighting */
        .diff-added {{
            background-color: #d4edda;
        }}

        .diff-removed {{
            background-color: #f8d7da;
        }}

        .diff-modified {{
            background-color: #fff3cd;
        }}

        /* Inline diff highlighting */
        .inline-added {{
            background-color: #acf2bd;
            padding: 2px 0;
        }}

        .inline-removed {{
            background-color: #fdb8c0;
            padding: 2px 0;
        }}

        /* Ellipsis marker for cropped content */
        .ellipsis {{
            color: #999;
            font-style: italic;
            background: #f0f0f0;
            padding: 0 4px;
            margin: 0 2px;
            border-radius: 2px;
            font-size: 11px;
            user-select: none;
        }}

        .empty-message {{
            text-align: center;
            padding: 40px;
            color: #6c757d;
            font-style: italic;
        }}
    </style>
</head>
<body>
    <div class="header">
        <h1>TEI XML Comparison - Differences Only</h1>
        <div class="titles">
            <span>{_escape_html(title1)}</span>
            <span>{_escape_html(title2)}</span>
        </div>
        <div class="summary" id="summary"></div>
    </div>

    <div id="diffResults"></div>

    <script>
        // XML content
        const xml1 = {xml1_escaped};
        const xml2 = {xml2_escaped};

        // Crop identical content within a line, keeping context around differences
        function cropLine(line, isChanged) {{
            if (!isChanged || line.length < 80) {{
                return escapeHtml(line);
            }}

            // For changed lines, this is simplified - real implementation would use
            // character-level diff to identify exact changed portions
            // For now, show start and end with ellipsis in middle if very long
            const start = line.substring(0, 40);
            const end = line.substring(line.length - 40);

            return escapeHtml(start) + '<span class="ellipsis">&lt;⋯&gt;</span>' + escapeHtml(end);
        }}

        // HTML escape
        function escapeHtml(text) {{
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }}

        // Compute and render only differences
        function computeAndRenderDiffs() {{
            const lines1 = xml1.split('\\n');
            const lines2 = xml2.split('\\n');

            // Compute line-level diff
            const diff = Diff.diffLines(xml1, xml2);

            let diffBlocks = [];
            let line1 = 1;
            let line2 = 1;
            let blockCount = 0;

            diff.forEach(part => {{
                const lines = part.value.split('\\n').filter((l, i, arr) => {{
                    // Keep empty lines except the last one (from split)
                    return i < arr.length - 1 || l !== '';
                }});

                if (part.added || part.removed) {{
                    // Found a difference - create diff block
                    if (!diffBlocks.length || diffBlocks[diffBlocks.length - 1].closed) {{
                        diffBlocks.push({{
                            left: [],
                            right: [],
                            startLine1: line1,
                            startLine2: line2,
                            closed: false
                        }});
                        blockCount++;
                    }}

                    const currentBlock = diffBlocks[diffBlocks.length - 1];

                    if (part.removed) {{
                        lines.forEach((line, i) => {{
                            currentBlock.left.push({{
                                number: line1 + i,
                                content: line,
                                type: 'removed'
                            }});
                        }});
                        line1 += lines.length;
                    }} else if (part.added) {{
                        lines.forEach((line, i) => {{
                            currentBlock.right.push({{
                                number: line2 + i,
                                content: line,
                                type: 'added'
                            }});
                        }});
                        line2 += lines.length;
                    }}
                }} else {{
                    // Unchanged section - skip it, but advance line counters
                    line1 += lines.length;
                    line2 += lines.length;

                    // Close current diff block if any
                    if (diffBlocks.length && !diffBlocks[diffBlocks.length - 1].closed) {{
                        diffBlocks[diffBlocks.length - 1].closed = true;
                    }}
                }}
            }});

            // Render summary
            const summary = document.getElementById('summary');
            if (diffBlocks.length === 0) {{
                summary.textContent = 'No differences found.';
                document.getElementById('diffResults').innerHTML =
                    '<div class="empty-message">The documents are identical.</div>';
                return;
            }}

            summary.textContent = `Found ${{diffBlocks.length}} difference block(s)`;

            // Render diff blocks
            const resultsContainer = document.getElementById('diffResults');
            diffBlocks.forEach((block, idx) => {{
                const blockDiv = document.createElement('div');
                blockDiv.className = 'diff-block';

                const header = document.createElement('div');
                header.className = 'diff-block-header';
                header.textContent = `Difference #${{idx + 1}} - Lines ${{block.startLine1}} ↔ ${{block.startLine2}}`;
                blockDiv.appendChild(header);

                const container = document.createElement('div');
                container.className = 'diff-container';

                // Left pane
                const leftPane = document.createElement('div');
                leftPane.className = 'diff-pane';
                block.left.forEach(item => {{
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'diff-line diff-' + item.type;
                    lineDiv.innerHTML = `<span class="line-number">${{item.number}}</span><span class="line-content">${{cropLine(item.content, true)}}</span>`;
                    leftPane.appendChild(lineDiv);
                }});
                container.appendChild(leftPane);

                // Right pane
                const rightPane = document.createElement('div');
                rightPane.className = 'diff-pane';
                block.right.forEach(item => {{
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'diff-line diff-' + item.type;
                    lineDiv.innerHTML = `<span class="line-number">${{item.number}}</span><span class="line-content">${{cropLine(item.content, true)}}</span>`;
                    rightPane.appendChild(lineDiv);
                }});
                container.appendChild(rightPane);

                blockDiv.appendChild(container);
                resultsContainer.appendChild(blockDiv);
            }});
        }}

        // Initialize
        computeAndRenderDiffs();
    </script>
</body>
</html>
    """
```

### Enhanced Inline Diffing

For better inline cropping of identical portions within changed lines, use character-level diff:

```javascript
// Enhanced cropLine with character-level diff
function cropLineWithInlineDiff(line1, line2) {
    if (!line1 && !line2) return ['', ''];
    if (!line1) return ['', escapeHtml(line2)];
    if (!line2) return [escapeHtml(line1), ''];

    // Character-level diff
    const charDiff = Diff.diffChars(line1, line2);

    let html1 = '';
    let html2 = '';
    let lastWasIdentical = false;
    let identicalBuffer = '';
    const CONTEXT_CHARS = 20; // Characters to show around changes

    charDiff.forEach((part, idx) => {
        if (!part.added && !part.removed) {
            // Identical part - may need cropping
            identicalBuffer += part.value;

            // Check if this is the last part
            const isLast = idx === charDiff.length - 1;
            // Check if next part is different
            const nextIsDiff = idx < charDiff.length - 1 &&
                (charDiff[idx + 1].added || charDiff[idx + 1].removed);

            if (isLast || nextIsDiff) {
                // Flush buffer
                if (identicalBuffer.length > CONTEXT_CHARS * 2) {
                    // Crop middle
                    const start = lastWasIdentical ? '' : identicalBuffer.substring(0, CONTEXT_CHARS);
                    const end = isLast ? '' : identicalBuffer.substring(identicalBuffer.length - CONTEXT_CHARS);

                    if (start) {
                        html1 += escapeHtml(start);
                        html2 += escapeHtml(start);
                    }

                    if (start || end) {
                        html1 += '<span class="ellipsis">&lt;⋯&gt;</span>';
                        html2 += '<span class="ellipsis">&lt;⋯&gt;</span>';
                    }

                    if (end) {
                        html1 += escapeHtml(end);
                        html2 += escapeHtml(end);
                    }
                } else {
                    // Short enough - show all
                    html1 += escapeHtml(identicalBuffer);
                    html2 += escapeHtml(identicalBuffer);
                }

                identicalBuffer = '';
                lastWasIdentical = true;
            }
        } else if (part.removed) {
            lastWasIdentical = false;
            html1 += '<span class="inline-removed">' + escapeHtml(part.value) + '</span>';
        } else if (part.added) {
            lastWasIdentical = false;
            html2 += '<span class="inline-added">' + escapeHtml(part.value) + '</span>';
        }
    });

    return [html1, html2];
}
```

### Integration with IAA Plugin

Update `_generate_html_table()` in `plugin.py` to add diff viewer link:

```python
# In _generate_html_table method, add new column header
header_cells.append(
    '<th style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em; width: 80px;">Details</th>'
)

# In row generation, construct diff URL with session_id
diff_url = f'/api/plugins/iaa-analyzer/diff?stable_id1={v1["stable_id"]}&stable_id2={v2["stable_id"]}&session_id={session_id}'
view_diff_link = f'<a href="{diff_url}" target="_blank" rel="noopener" style="color: #0066cc; text-decoration: underline;">View Diff</a>'

row_cells.append(
    f'<td style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em;">{view_diff_link}</td>'
)
```

Update method signature to accept `session_id`:

```python
def _generate_html_table(self, comparisons: list[dict[str, Any]], session_id: str) -> str:
```

Update call in `compute_agreement()`:

```python
html = self._generate_html_table(comparisons, context.session_id)
```

### Testing

**Unit Tests:**

```python
# tests/unit/fastapi/test_iaa_analyzer_routes.py

def test_diff_route_authentication():
    """Diff route requires authentication."""
    response = client.get("/api/plugins/iaa-analyzer/diff?stable_id1=abc&stable_id2=def")
    assert response.status_code == 401

def test_diff_route_shows_only_differences():
    """Diff route shows only changed sections."""
    # Create test files with known differences
    response = client.get(
        f"/api/plugins/iaa-analyzer/diff?stable_id1={file1.stable_id}&stable_id2={file2.stable_id}&session_id={session.id}"
    )
    assert response.status_code == 200
    assert "Difference #1" in response.text
    # Should NOT contain large blocks of identical content
    assert response.text.count("<⋯>") > 0  # Has ellipsis markers
```

**Manual Testing:**

1. Run IAA analysis on documents with known differences
2. Click "View Diff" link
3. Verify only diff blocks shown
4. Check line numbers match source documents
5. Verify `<⋯>` markers appear for long identical sections
6. Test with documents that are identical (should show "No differences")
7. Test with completely different documents

### Implementation Steps

1. Add `show_diff()` route to `routes.py`
2. Implement `_generate_diff_html()` with basic line-level diff
3. Implement enhanced `cropLineWithInlineDiff()` for character-level cropping
4. Update `_generate_html_table()` to include diff links and accept `session_id`
5. Test authentication and access control
6. Test with TEI documents of varying similarity
7. Verify ellipsis markers render correctly
8. Test in multiple browsers

### Success Criteria

- Diff viewer shows only sections that differ
- Identical sections completely omitted
- Line numbers accurate for both sides
- Inline cropping with `<⋯>` marker works
- Character-level highlighting shows exact changes
- Authentication prevents unauthorized access
- Works without requiring application rebuild
- Link from IAA table opens in new tab

### Required Changes to Existing IAA Plugin

To support Phase 5 and ensure consistency, the existing IAA plugin implementation needs these updates:

1. **Add ignore constants** at module level (top of `plugin.py`):
   ```python
   IGNORE_TAGS = frozenset([])
   IGNORE_ATTRIBUTES = frozenset(['xml:id', 'xml:base'])
   ```

2. **Update `_extract_element_sequence()` method**:
   - Change from extracting only specific attributes (`place`, `type`, `who`, `when`, `corresp`, `n`)
   - To extracting ALL attributes except those in `IGNORE_ATTRIBUTES`
   - Add check to skip elements in `IGNORE_TAGS`
   - Handle namespaced attributes properly (convert `{namespace}local` to `prefix:local`)

3. **Update `_generate_html_table()` signature**:
   - Add `session_id: str` parameter
   - Add "Details" column with "View Diff" link

4. **Update `compute_agreement()` call**:
   - Pass `context.session_id` to `_generate_html_table()`

These changes ensure the IAA calculation and diff viewer use identical filtering logic.

## Implementation Summary

The Inter-Annotator Agreement plugin has been fully implemented with the following features:

### Core Implementation

**Plugin Structure:**

- [fastapi_app/plugins/iaa_analyzer/plugin.py](../../fastapi_app/plugins/iaa_analyzer/plugin.py) (440 lines)
- [fastapi_app/plugins/iaa_analyzer/routes.py](../../fastapi_app/plugins/iaa_analyzer/routes.py) (160 lines)
- [fastapi_app/plugins/iaa_analyzer/\_\_init\_\_.py](../../fastapi_app/plugins/iaa_analyzer/__init__.py)

**Algorithm:**

- Extracts flattened element sequences from TEI `<text>` elements using depth-first traversal
- Each element token includes: tag, text content, tail text, and relevant attributes (place, type, who, when, corresp, n)
- Compares sequences position-by-position, matching when all four fields are identical
- Normalizes whitespace in text/tail content
- Handles nested structures by flattening via `elem.iter()`
- Skips non-element nodes (comments, processing instructions)

**Features:**

- Pairwise comparison of all TEI annotation versions
- Variant filtering support
- Color-coded agreement percentages (green ≥80%, yellow ≥60%, red <60%)
- CSV export endpoint at `/api/plugins/iaa-analyzer/export`
- Interactive HTML links using Plugin Sandbox (see below)
- Comprehensive error handling and logging

### Plugin Sandbox Infrastructure

Created generic sandbox interface for all plugins to interact with application state from generated HTML:

**Implementation:**

- [app/src/plugins/backend-plugins.js](../../app/src/plugins/backend-plugins.js) - Added `PluginSandbox` class
- Available as `window.pluginSandbox` when plugin HTML is displayed
- Provides methods:
  - `updateState(updates)` - Update application state fields
  - `closeDialog()` - Close result dialog
  - `openDocument(stableId)` - Open document and close dialog
  - `openDiff(stableId1, stableId2)` - Open diff view and close dialog

**Usage in IAA Plugin:**

- Stable IDs are clickable links that call `pluginSandbox.openDocument()`
- Match counts are clickable links that call `pluginSandbox.openDiff()`
- Clicking either link updates state and closes the result dialog

**Documentation:**

- [docs/code-assistant/backend-plugins.md](../../docs/code-assistant/backend-plugins.md) - Added "Interactive HTML Content" section with examples and API reference

### Testing

**Unit Tests:**

- [tests/unit/fastapi/test_iaa_analyzer.py](../../tests/unit/fastapi/test_iaa_analyzer.py) (400 lines, 20 tests)
- All tests passing
- Coverage includes:
  - Element sequence extraction with nested structures
  - Text/tail normalization and whitespace handling
  - Attribute extraction and comparison
  - Matching logic (tag + text + tail + attrs)
  - Pairwise agreement calculation
  - HTML table generation with color coding
  - Edge cases (empty text, missing elements, different lengths)

### Technical Highlights

**Non-Element Node Handling:**

Fixed issue where lxml's `iter()` returns non-element nodes (comments, processing instructions). Added type check:

```python
if not isinstance(elem.tag, str):
    continue
```

**Code Reuse Pattern:**

Routes.py reuses plugin methods to avoid duplication:

```python
plugin = IAAAnalyzerPlugin()
metadata = plugin._extract_metadata(xml_content, file_metadata)
elements = plugin._extract_element_sequence(xml_content)
```

This pattern ensures consistency between plugin endpoint and custom routes.
