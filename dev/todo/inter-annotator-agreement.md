# Inter-Annotator Agreement Plugin Implementation Plan

## Overview

Backend plugin that computes inter-annotator agreement between all versions of a TEI annotation variant for a PDF document. Returns HTML table with pairwise comparison statistics.

## Technical Requirements

### Input Parameters

Plugin receives from frontend state:
- `pdf` (state field) - Document ID of the PDF file
- `variant` (state field) - Currently selected variant filter

### Output

HTML table showing:
- Pairwise comparisons between all TEI versions
- Document label from `/teiHeader/editionStmt/title`
- Annotator ID from `/teiHeader/revisionDesc/change` (last change element)
- Agreement metrics for each pair

### Algorithm: Sequence-Based Token Agreement

**Label Sequence Extraction:**

1. Parse TEI XML and extract all `<label>` elements in document order
2. Get text content of each label, normalize whitespace:
   - Strip leading/trailing whitespace
   - Collapse internal whitespace to single spaces
   - Case-sensitive comparison (preserve original case)
3. Create sequence of label texts: `["label1", "label2", "label3", ...]`

**Pairwise Agreement Calculation:**

For each pair of versions (A, B):

1. Extract label sequences: `seq_A` and `seq_B`
2. Align sequences using Longest Common Subsequence (LCS)
3. Calculate metrics:
   - **Matches**: Number of labels in same position with identical text
   - **Total**: Maximum length of the two sequences
   - **Agreement**: `matches / total * 100` (percentage)
   - **Cohen's Kappa** (optional): Accounts for chance agreement

**Example:**

```
Version A: ["Person", "Location", "Date"]
Version B: ["Person", "Place", "Date"]

Alignment:
  A: Person | Location | Date
  B: Person | Place    | Date
     MATCH    DIFF      MATCH

Matches: 2
Total: 3
Agreement: 66.67%
```

**Edge Cases:**

- Different sequence lengths: Use max length as denominator
- Empty sequences: Agreement = 0% or N/A
- Single version: No comparisons possible

## Implementation Design

### Backend Plugin Structure

**File:** `fastapi_app/plugins/iaa-analyzer/plugin.py`

```python
from fastapi_app.lib.plugin_base import Plugin, PluginContext
from fastapi_app.lib.file_repository import FileRepository
from typing import Any
import xml.etree.ElementTree as ET

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

        # Extract metadata and label sequences
        versions = []
        for tei_file in tei_files:
            metadata = self._extract_metadata(tei_file)
            labels = self._extract_label_sequence(tei_file)
            versions.append({
                "file": tei_file,
                "metadata": metadata,
                "labels": labels
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
        # Parse TEI XML from storage
        tree = ET.parse(tei_file.storage_path)
        root = tree.getroot()

        # Extract title (with TEI namespace handling)
        ns = {'tei': 'http://www.tei-c.org/ns/1.0'}
        title_elem = root.find('.//tei:editionStmt/tei:title', ns)
        title = title_elem.text if title_elem is not None else "Unknown"

        # Extract last annotator from revisionDesc
        changes = root.findall('.//tei:revisionDesc/tei:change', ns)
        annotator = "Unknown"
        if changes:
            last_change = changes[-1]
            # Try @who attribute, fallback to text content
            annotator = last_change.get('who', last_change.text or "Unknown")

        return {
            "title": title.strip(),
            "annotator": annotator.strip(),
            "stable_id": tei_file.stable_id
        }

    def _extract_label_sequence(self, tei_file):
        """Extract normalized sequence of label texts."""
        tree = ET.parse(tei_file.storage_path)
        root = tree.getroot()

        ns = {'tei': 'http://www.tei-c.org/ns/1.0'}
        labels = root.findall('.//tei:label', ns)

        sequence = []
        for label in labels:
            text = label.text or ""
            # Normalize whitespace
            normalized = " ".join(text.split())
            if normalized:
                sequence.append(normalized)

        return sequence

    def _compute_pairwise_agreements(self, versions):
        """Compute agreement for all version pairs."""
        comparisons = []

        for i in range(len(versions)):
            for j in range(i + 1, len(versions)):
                v1 = versions[i]
                v2 = versions[j]

                matches = self._count_matches(v1['labels'], v2['labels'])
                total = max(len(v1['labels']), len(v2['labels']))
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
        """Count matching labels at same positions."""
        matches = 0
        min_len = min(len(seq1), len(seq2))

        for i in range(min_len):
            if seq1[i] == seq2[i]:
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
   - Sample TEI files with known label sequences
   - Multiple variants for testing variant filtering
9. Write unit tests (`tests/unit/fastapi/test_iaa_analyzer.py`):
   - Test label extraction with various whitespace patterns
   - Test agreement calculation with different sequence lengths
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
- Plugin registration: [fastapi_app/plugins/iaa-analyzer/__init__.py](../../fastapi_app/plugins/iaa-analyzer/__init__.py)
- File repository: [fastapi_app/lib/file_repository.py](../../fastapi_app/lib/file_repository.py)
- Frontend integration: [app/src/plugins/backend-plugins.js](../../app/src/plugins/backend-plugins.js)
- Tests: [tests/unit/fastapi/test_iaa_analyzer.py](../../tests/unit/fastapi/test_iaa_analyzer.py)

## Dependencies

- Python standard library: `xml.etree.ElementTree` for TEI parsing
- Existing file repository for database access
- Existing plugin infrastructure for registration
- Frontend plugin system for execution

## Success Criteria

- Plugin appears in toolbar dropdown under "Analyzer" category
- Clicking plugin item automatically extracts doc_id and variant from state
- Plugin computes agreement for all TEI versions matching criteria
- HTML table displays pairwise comparisons with correct metrics
- Table includes document labels and annotator IDs from TEI headers
- Agreement percentages calculated correctly
- Edge cases handled (0-1 versions, empty sequences)
- Unit tests verify label extraction and agreement calculation
- Result displayed in user-friendly format (dialog or alert)

## Future Enhancements

- LCS-based alignment for handling insertions/deletions
- Cohen's Kappa for chance-corrected agreement
- CSV export of results
- Visualization (heatmap, confusion matrix)
- Support for different label types (by attribute)
- Weighted agreement (by label importance)
- Inter-rater reliability beyond pairwise (Fleiss' Kappa)
