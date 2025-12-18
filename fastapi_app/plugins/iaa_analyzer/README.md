# Inter-Annotator Agreement (IAA) Analyzer Plugin

## For End Users

### Purpose

The IAA Analyzer helps assess annotation quality by comparing multiple TEI versions of the same document. It measures agreement between annotators and highlights disagreements for review.

### Workflow Integration

1. **Multiple Annotations**: Create multiple TEI versions of the same PDF using different annotators or extraction methods (GROBID variants, manual annotation, etc.)

2. **Agreement Analysis**: The plugin computes pairwise agreement percentages between versions by comparing element sequences (tags, attributes, text content)

3. **Disagreement Review**: View side-by-side diffs of disagreements with two modes:
   - **All Differences**: Shows every difference including formatting, IDs, and structural variations
   - **Semantic Differences**: Filters out configured attributes (like `xml:id`, `rendition`) and ignored elements (like `<pb>`) to focus on meaningful content differences

4. **Navigation**: Click on any difference line to open the corresponding document at that location for correction

5. **Export**: Download agreement metrics as CSV for further analysis

### Use Cases

- Quality control for automated extraction tools
- Training data validation for machine learning models
- Identifying systematic disagreements between annotators
- Evaluating impact of different extraction configurations

---

## For Developers

### Architecture

**Backend** (`plugin.py`, `routes.py`, `diff_utils.py`):

- Element sequence extraction and comparison
- XML preprocessing (tag/attribute filtering, whitespace normalization)
- Agreement metric computation
- Diff HTML generation

**Frontend** (`diff-viewer.js`):

- Line-based diff visualization
- Two-mode diff rendering
- Click-to-navigate integration

### Diff Modes

#### All Differences Mode

1. Serialize both documents with `pretty_print=True`
2. Run `Diff.diffLines()` on serialized strings
3. Display all added/removed lines with line numbers
4. Line numbers map directly to source document lines

**Use case**: Debugging extraction issues, reviewing all changes including formatting

#### Semantic Differences Mode

1. **Preprocessing** (`preprocess_for_diff()`):
   - Remove ignored tags (e.g., `<pb>`, `<note>` if configured)
   - Strip ignored attributes (e.g., `xml:id`, `rendition`, `facs`)
   - Normalize whitespace in text content
   - Inject `data-line` attributes preserving original line numbers

2. **Serialization** (`serialize_with_linebreaks()`):
   - Serialize without pretty-printing to preserve element order
   - Add newline after each closing tag for line-based diffing

3. **Diffing** (`computeDiffBlocks()` in semantic mode):
   - **Strip `data-line` attributes** before diffing to avoid false positives
   - Run `Diff.diffLines()` on stripped preprocessed strings
   - Extract original line numbers from unstripped preprocessed strings
   - Map diff blocks back to original document lines for navigation

4. **Display**:
   - Show only lines that differ in semantic content
   - Display line numbers hidden (empty) - click handlers use `data-line` values
   - Content shown without `data-line` attributes

**Key insight**: `data-line` attributes serve dual purpose:

- Preserve line mapping for click navigation
- Must be stripped before diffing to avoid identical content appearing different

**Use case**: Reviewing semantic disagreements, ignoring structural/formatting variations

### Configuration

**Ignored Tags** (`IGNORE_TAGS` in `plugin.py`):

```python
frozenset(['teiHeader'])  # Example
```

**Ignored Attributes** (`IGNORE_ATTRIBUTES` in `plugin.py`):

```python
frozenset(['status'])  # Example
```

Modify these sets to customize what semantic mode considers "non-semantic".

### Testing

**Backend**: `tests/test_diff_utils.py`, `tests/test_iaa_analyzer.py`

- Preprocessing correctness
- Serialization order preservation
- False positive prevention (identical content, different line numbers)

**Frontend**: `tests/diff-viewer.test.js`

- Diff block computation
- Line number extraction
- Mode switching behavior

Run: `npm run test:changed` after modifying diff logic.

### API Endpoints

- `GET /api/plugins/iaa-analyzer/export?pdf={stable_id}&variant={variant}` - Export CSV
- `GET /api/plugins/iaa-analyzer/diff?stable_id1={id1}&stable_id2={id2}&content_xpath={xpath}` - Render diff viewer
