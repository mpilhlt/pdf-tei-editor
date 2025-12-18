# Diff Viewer Refactoring Summary

## Changes Made

### 1. Refactored JavaScript (diff-viewer.js)

**Separation of Concerns:**
- Extracted `computeDiffBlocks()` - Pure function that computes diff blocks from XML
- Kept `initDiffViewer()` - UI initialization and event handlers
- Wrapped in UMD pattern for both Node.js (testing) and browser use

**Benefits:**
- `computeDiffBlocks()` is now testable without DOM
- Clear separation between diff calculation and UI rendering
- Can be imported in Node.js tests

### 2. Created Comprehensive Unit Tests (tests/unit/js/diff-viewer.test.js)

**Test Coverage:**

#### All Differences Mode (WORKING) ✅
- Detects simple text changes
- Detects attribute changes
- Handles line offsets correctly
- Shows accurate line numbers from original documents

#### Semantic Differences Mode (NOT WORKING) ❌
Tests document the **expected** behavior that currently doesn't work:

**Expected Behavior:**
1. Diff preprocessed XML (with ignored attributes/tags removed)
2. Display content from ORIGINAL XML (with all attributes)
3. Map preprocessed line numbers back to original line numbers
4. Use original line numbers for navigation

**Current Issues:**
1. Line mapping doesn't work correctly
2. Mismatched content between left and right sides
3. Wrong line numbers displayed
4. Empty or missing content in some cases

**Example Test Case:**
```javascript
// Original XML with xml:id
const xml1Original = '<text>\n<p xml:id="p1">Hello</p>\n</text>';
const xml2Original = '<text>\n<p xml:id="p2">Hello</p>\n</text>';

// Preprocessed XML with xml:id removed
const xml1Preprocessed = '<text>\n<p>Hello</p>\n</text>';
const xml2Preprocessed = '<text>\n<p>Hello</p>\n</text>';

// EXPECTED: No differences (preprocessed XML is identical)
// ACTUAL: May show incorrect differences
```

### 3. File Organization

```
fastapi_app/plugins/iaa_analyzer/
├── diff-viewer.js          # Refactored, testable JavaScript
├── diff-viewer.css         # Extracted CSS
├── plugin.py               # IAA calculation logic
└── routes.py               # Route handlers, loads JS/CSS

tests/unit/js/
└── diff-viewer.test.js     # Comprehensive unit tests
```

## Running Tests

```bash
node --test tests/unit/js/diff-viewer.test.js
```

## Why Semantic Mode Doesn't Work

The current implementation has a fundamental flaw:

1. **Computes diff** on preprocessed XML (fewer lines, different content)
2. **Tracks line numbers** based on preprocessed XML
3. **Tries to map** those line numbers back to original XML
4. **Problem**: The mapping assumes line-for-line correspondence, but:
   - Preprocessed XML may have fewer lines (removed elements)
   - Content doesn't match between preprocessed and original
   - Line numbers get out of sync

## Potential Fix

To make semantic mode work correctly, we would need to:

1. Build line mapping **during preprocessing** (not after)
2. Track which original lines correspond to each preprocessed line
3. When diff identifies a preprocessed line as changed:
   - Look up its original line number(s) in the mapping
   - Extract content from those original line(s)
   - Display with correct line numbers

This requires changes to both the Python preprocessing code and the JavaScript diff logic.

## Current Recommendation

**Use "All Differences" mode** (default) which works correctly and shows all changes including attributes.

The semantic mode toggle remains in the UI but doesn't function as intended. It's documented in tests as a known limitation.
