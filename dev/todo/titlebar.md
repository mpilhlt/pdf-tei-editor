# PDF Viewer Title Bar Display Issues

## Context
The PDF viewer has a headerbar that displays:
- **Left side**: Title widget showing document title (format: "Author (Year) Title")
- **Right side**: Filename widget showing doc_id

## Completed Changes

### 1. Fixed doc_id Display
**File**: `app/src/plugins/pdfviewer.js:133`

Changed from accessing non-existent `.file?.fileref` to `.file?.doc_id`:
```javascript
filenameWidget.text = getFileDataById(state.pdf)?.file?.doc_id || ''
```

### 2. Updated Label Format in Backend
**File**: `fastapi_app/routers/extraction.py:320-341`

Changed label format from "Author, Title (Year)" to "Author (Year) Title":
- Puts shorter author/date info first
- Leaves more space for title to display before truncation
- Example: "van Gestel (2013) Why Methodology Matters..."

### 3. Added Tooltip to Title Widget
**File**: `app/src/plugins/pdfviewer.js:137-144`

Added tooltip property to show full title on hover when truncated:
```javascript
titleWidget.tooltip = title || 'PDF Document';
```

### 4. Enhanced CSS for Title Widget Ellipsis
**File**: `app/src/modules/panels/status-bar.js:70-75`

Updated CSS for `.title-widget` class:
```css
::slotted(.title-widget) {
  flex-grow: 1;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}
```

The `StatusText` component already had `text-overflow: ellipsis` configured.

## Remaining Issue: Minimum Width Threshold

### Problem
On very narrow viewports, the title gets compressed to unusable text like "van..." which provides no context. The title widget should be completely hidden when the available space becomes too narrow to be useful (< 100px).

### Attempted Solution
**File**: `app/src/modules/panels/status-bar.js:158-215`

Added `checkTitleWidgetMinimumWidth()` method that:
1. Calculates available space for title widget by subtracting other widgets' widths
2. Hides title widget when available space < 100px
3. Shows title widget when available space >= 100px
4. Runs before normal priority-based overflow detection

The title widget is excluded from normal priority-based hiding in `getAllWidgetsWithPriority()`.

### Status: NOT WORKING YET

The title widget still shows truncated unusable text on very narrow viewports instead of hiding completely. The calculation logic or timing may be incorrect.

## Next Steps

1. **Debug the width calculation**: Add logging to understand what widths are being calculated
   - Log `availableWidth`, `nonTitleWidthInSlot`, `otherSlotsWidth`, `availableForTitle`
   - Check if the 100px threshold is appropriate
   - Verify the calculation accounts for all spacing correctly (padding, gaps)

2. **Check timing**: The issue might be a race condition where:
   - Width is measured before/after flexbox layout completes
   - Multiple resize events interfere with each other
   - The title widget's width changes after being measured

3. **Alternative approaches to consider**:
   - Use ResizeObserver directly on the title widget
   - Set a CSS `min-width` on title-widget and let it participate in normal hiding
   - Calculate based on text content length rather than rendered width
   - Use a completely different approach: always hide title widget when viewport < certain width

4. **Test scenarios**:
   - Very narrow viewport (< 400px)
   - Medium viewport (400-800px)
   - Wide viewport (> 800px)
   - Resizing from wide to narrow and back
   - Different title lengths

## Related Files

- `app/src/plugins/pdfviewer.js` - PDF viewer plugin, title/filename widgets
- `app/src/modules/panels/status-bar.js` - StatusBar component with overflow logic
- `app/src/modules/panels/widgets/status-text.js` - StatusText widget component
- `app/src/modules/file-data-utils.js` - File data utilities
- `fastapi_app/routers/extraction.py` - Backend label generation

## Key Code Locations

- Title widget creation: `app/src/plugins/pdfviewer.js:82-90`
- Title widget update: `app/src/plugins/pdfviewer.js:132-146`
- Overflow detection: `app/src/modules/panels/status-bar.js:134-156`
- Title width check: `app/src/modules/panels/status-bar.js:158-215`
- Title widget CSS: `app/src/modules/panels/status-bar.js:70-75`
- StatusText ellipsis: `app/src/modules/panels/widgets/status-text.js:51-58`
