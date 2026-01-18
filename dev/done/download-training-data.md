# GROBID Training Data Download with Progress Widget

## Summary

This feature enables downloading GROBID training data packages from the application, with a progress widget that provides user feedback during the potentially long-running fetch from the GROBID server.

The work consists of two main parts:
1. A reusable SSE-controlled progress widget plugin for the frontend
2. Integration of the progress widget into the GROBID training data download route

## Implementation

### 1. Progress Widget Plugin

Created a new frontend plugin that provides a modal progress indicator controlled via SSE events.

**Files created:**

- `app/src/templates/progress.html` - Template with:
  - Modal pane centered in viewport with drop shadow
  - `sl-progress-bar` component for progress display
  - Cancel, minimize, and maximize icon buttons
  - Text label row
  - CSS for minimized state (10vw width, bottom-left position, smaller progress bar, hidden label)
  - Uses `data-name` attribute for buttons since `sl-icon-button` uses `name` for icon names

- `app/src/plugins/progress.js` - Plugin that:
  - Listens for SSE events: `progressShow`, `progressValue`, `progressLabel`, `progressHide`
  - Persists minimized state in sessionStorage (survives page reloads)
  - Provides public API: `show()`, `hide()`, `setValue()`, `setLabel()`, `isVisible()`

**SSE Event Types:**

| Event | Data | Description |
|-------|------|-------------|
| `progressShow` | `{"label": "...", "value": null, "cancellable": true}` | Shows widget |
| `progressValue` | `"50"` or `"null"` | Sets progress (0-100) or indeterminate |
| `progressLabel` | `"Processing..."` | Sets text label |
| `progressHide` | (empty) | Hides widget |

### 2. Backend ProgressBar Class

Added `ProgressBar` class to `fastapi_app/lib/sse_utils.py`:

```python
from fastapi_app.lib.sse_utils import ProgressBar

progress = ProgressBar(sse_service, session_id)
progress.show(label="Processing...", cancellable=True)
progress.set_value(50)  # 50% or None for indeterminate
progress.set_label("Step 2...")
progress.hide()
```

### 3. UI System Enhancement

Updated `app/src/modules/ui-system.js` to support `data-name` attribute as an alternative to `name` for UI navigation. This is necessary for Shoelace components like `sl-icon-button` that use the `name` attribute for their own purposes (icon name).

### 4. Plugin Registration

- Registered progress plugin in `app/src/plugins.js`
- Added `progressWidgetPart` typedef and exports in `app/src/ui.js`
- Added `SlIconButton` and `SlProgressBar` exports to `app/src/ui.js`

### 5. GROBID Download Route Integration

Updated `fastapi_app/plugins/grobid/routes.py` to show the progress widget while fetching training data from the GROBID server:

```python
progress = ProgressBar(sse_service, session_id_value)
progress.show(label="Retrieving training data from GROBID...", cancellable=False)

try:
    # Fetch training package from GROBID
    extractor = GrobidTrainingExtractor()
    temp_dir, extracted_files = extractor._fetch_training_package(...)
finally:
    progress.hide()
```

## Status

### Completed
- Progress widget template with minimize/maximize functionality
- Progress plugin with SSE event handling
- Session storage persistence for minimized state
- Backend `ProgressBar` class in `sse_utils.py`
- UI system `data-name` attribute support
- Plugin registration and type definitions
- Integration in GROBID download route

### Remaining Work
- Test the progress widget in the browser
- Verify SSE connectivity and event delivery
- Test minimize/maximize behavior and persistence
- Add cancel functionality if needed (currently sends `progressCancel` SSE event to server)
