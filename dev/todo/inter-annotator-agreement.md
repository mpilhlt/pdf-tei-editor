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

**Element Sequence Extraction:**

1. Parse TEI XML and locate the `<text>` element
2. Traverse all descendant elements within `<text>` in document order (depth-first)
3. For each element, create a token with:
   - Element tag name (without namespace prefix)
   - Element's `.text` (direct text content before any children)
   - Element's `.tail` (text content after the element's closing tag, before next sibling)
   - Relevant attributes (e.g., `@place`, `@type`)
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
- Relevant attribute values

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

            # Extract tag name without namespace
            tag = etree.QName(elem).localname

            # Normalize text and tail
            text = self._normalize_text(elem.text)
            tail = self._normalize_text(elem.tail)

            # Extract relevant attributes (customize as needed)
            attrs = {}
            for attr_name in ['place', 'type', 'who', 'when']:
                if attr_name in elem.attrib:
                    attrs[attr_name] = elem.attrib[attr_name]

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
