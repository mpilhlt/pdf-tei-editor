# GROBID Training Data Download with Progress Widget

## Summary

This feature enables downloading GROBID training data packages from the application, with a progress widget that provides user feedback during the potentially long-running fetch from the GROBID server.

The work consists of the following parts:

1. A reusable SSE-controlled progress widget plugin for the frontend (multi-instance)
2. SSE-based notification system for user feedback
3. Integration of the progress widget into the GROBID training data download route
4. Collection-based batch download with caching of original training data
5. Centralized plugin data directory in settings
6. Event bus integration for file deletion cleanup

## Implementation

### 1. Progress Widget Plugin (Multi-Instance)

The progress widget supports multiple simultaneous instances, each identified by a unique `progress_id` assigned by the backend. Widgets stack vertically (centered when maximized, bottom-left when minimized).

**Files to modify:**

#### `app/src/templates/progress.html`

- Change the outer container to be a template that can be cloned
- Remove minimize/maximize buttons, replace with click-to-toggle behavior
- Add `data-progress-id` attribute for instance identification
- Update CSS for stacking multiple widgets

```html
<template id="progress-widget-template">
  <div class="progress-widget" data-progress-id="">
    <style>
      .progress-widget {
        position: fixed;
        z-index: 10000;
        background: var(--sl-color-neutral-0);
        border-radius: 8px;
        padding: 16px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        min-width: 300px;
        cursor: pointer;
        transition: all 0.3s ease;
      }
      .progress-widget.maximized {
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
      }
      .progress-widget.minimized {
        bottom: 50px;
        left: 50px;
        transform: none;
        min-width: 80px;
        width: 10vw;
        padding: 8px;
      }
      /* Stacking for multiple minimized widgets */
      .progress-widget.minimized[data-stack-index="1"] { bottom: 110px; }
      .progress-widget.minimized[data-stack-index="2"] { bottom: 170px; }
      .progress-widget.minimized[data-stack-index="3"] { bottom: 230px; }
      /* Stacking for multiple maximized widgets */
      .progress-widget.maximized[data-stack-index="1"] { top: calc(50% + 80px); }
      .progress-widget.maximized[data-stack-index="2"] { top: calc(50% + 160px); }
      .progress-widget.maximized[data-stack-index="3"] { top: calc(50% + 240px); }
      /* ... rest of styles ... */
    </style>
    <div class="progress-row">
      <sl-progress-bar name="progressBar" value="0"></sl-progress-bar>
      <sl-icon-button data-name="cancelBtn" name="x-circle" library="default" title="Cancel"></sl-icon-button>
    </div>
    <div name="labelRow" class="label-row"></div>
  </div>
</template>
```

#### `app/src/plugins/progress.js`

- Maintain a Map of active progress widget instances by `progress_id`
- SSE events include `progress_id` in their data
- Click on widget toggles minimized/maximized state
- Cancel button emits event via event bus with `progress_id`
- Update stacking indices when widgets are added/removed

**SSE Event Types (revised):**

| Event | Data | Description |
|-------|------|-------------|
| `progressShow` | `{"progress_id": "abc123", "label": "...", "value": null, "cancellable": true}` | Shows widget instance |
| `progressValue` | `{"progress_id": "abc123", "value": 50}` or `{"progress_id": "abc123", "value": null}` | Sets progress |
| `progressLabel` | `{"progress_id": "abc123", "label": "Processing..."}` | Sets text label |
| `progressHide` | `{"progress_id": "abc123"}` | Hides widget instance |

**Cancel handling:**

When cancel is clicked, the widget sends a POST request to `/api/plugins/grobid/cancel/{progress_id}`. This is a direct communication between the progress widget and the backend route that created it - no event bus needed.

### 2. SSE Notification Listener

**File to modify:** `app/src/plugins/sse.js`

Add listener for notification events that trigger toast notifications:

```javascript
// In establishConnection() after standard message channels:
eventSource.addEventListener('notification', (evt) => {
  try {
    const data = JSON.parse(evt.data)
    const { message, variant, icon } = data
    // variant: "info", "success", "warning", "error" (maps to sl-alert variants)
    // "error" maps to "danger" for Shoelace
    const slVariant = variant === 'error' ? 'danger' : variant
    notify(message, slVariant, icon)
  } catch (e) {
    logger.warn(`Failed to parse notification event: ${e}`)
  }
})
```

**Backend support in `sse_utils.py`:**

```python
def send_notification(
    sse_service: SSEService,
    session_id: str,
    message: str,
    variant: str = "info",  # "info", "success", "warning", "error"
    icon: str | None = None
) -> bool:
    """Send a notification to display as a toast."""
    data = {"message": message, "variant": variant}
    if icon:
        data["icon"] = icon
    return sse_service.send_message(
        client_id=session_id,
        event_type="notification",
        data=json.dumps(data)
    )
```

### 3. Backend ProgressBar Class (Updated)

Update `fastapi_app/lib/sse_utils.py` to support multi-instance progress bars:

```python
import uuid

class ProgressBar:
    """
    Controls a frontend progress widget instance via SSE events.
    Each instance gets a unique progress_id for identification.
    """

    def __init__(self, sse_service: SSEService, session_id: str, progress_id: str | None = None):
        self._sse_service = sse_service
        self._session_id = session_id
        self._progress_id = progress_id or str(uuid.uuid4())[:8]

    @property
    def progress_id(self) -> str:
        return self._progress_id

    def show(self, label: str | None = None, value: int | None = None, cancellable: bool = True) -> bool:
        data = {
            "progress_id": self._progress_id,
            "cancellable": cancellable
        }
        if label is not None:
            data["label"] = label
        if value is not None:
            data["value"] = value
        return self._sse_service.send_message(
            client_id=self._session_id,
            event_type="progressShow",
            data=json.dumps(data)
        )

    def hide(self) -> bool:
        return self._sse_service.send_message(
            client_id=self._session_id,
            event_type="progressHide",
            data=json.dumps({"progress_id": self._progress_id})
        )

    def set_value(self, value: int | None) -> bool:
        data = {"progress_id": self._progress_id, "value": value}
        return self._sse_service.send_message(
            client_id=self._session_id,
            event_type="progressValue",
            data=json.dumps(data)
        )

    def set_label(self, label: str) -> bool:
        data = {"progress_id": self._progress_id, "label": label}
        return self._sse_service.send_message(
            client_id=self._session_id,
            event_type="progressLabel",
            data=json.dumps(data)
        )
```

### 4. Supported Variants Configuration

**File to create:** `fastapi_app/plugins/grobid/config.py`

Define supported GROBID training variants in a canonical location:

```python
"""GROBID plugin configuration."""

# Supported training data variants
# These correspond to GROBID training model types
SUPPORTED_VARIANTS = [
    "grobid.training.segmentation",
    "grobid.training.references.referenceSegmenter",
    "grobid.training.references",
]

def get_supported_variants() -> list[str]:
    """Return list of supported GROBID training variants."""
    return SUPPORTED_VARIANTS.copy()
```

Update `extractor.py` to import from this config:

```python
from fastapi_app.plugins.grobid.config import get_supported_variants

@classmethod
def get_info(cls) -> Dict[str, Any]:
    return {
        # ...
        "options": {
            "variant_id": {
                "type": "string",
                "options": get_supported_variants()
            },
            # ...
        }
    }
```

### 5. GROBID Download Route - Collection-Based with Caching

**File to modify:** `fastapi_app/plugins/grobid/routes.py`

Change the download endpoint to process all documents in a collection, including all variants that have gold files:

```python
@router.get("/download")
async def download_training_package(
    collection: str = Query(..., description="Collection ID"),
    flavor: str = Query("default", description="GROBID processing flavor"),
    force_refresh: bool = Query(False, description="Force re-download from GROBID (ignore cached data)"),
    gold_only: bool = Query(False, description="Only include documents/variants with gold standard files"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    sse_service=Depends(get_sse_service),
):
    """
    Download GROBID training package for all documents in a collection as ZIP.

    For each document and variant:
    - If gold standard file exists: include gold file as main, GROBID output as .generated
    - If no gold standard file: include GROBID output as main (unless gold_only=True)

    Args:
        gold_only: If True, only include variants that have gold standard files,
                   and skip documents without any gold files. Default: False (include all).
        force_refresh: Force re-download from GROBID (ignore cached data)
    """
```

**Key implementation details:**

1. **Iterate over collection documents and variants:**

   ```python
   from fastapi_app.plugins.grobid.config import get_supported_variants

   # Get all PDF files in the collection
   pdf_files = file_repo.get_files_by_collection(collection, file_type="pdf")
   supported_variants = get_supported_variants()

   progress = ProgressBar(sse_service, session_id_value)
   progress.show(label=f"Processing {len(pdf_files)} documents...", cancellable=True)

   for i, pdf_file in enumerate(pdf_files):
       doc_id = pdf_file.doc_id
       progress.set_label(f"Document {i+1}/{len(pdf_files)}: {doc_id}")
       progress.set_value(int((i / len(pdf_files)) * 100))

       # Get all gold standard TEI files for this document
       all_files = file_repo.get_files_by_doc_id(doc_id)
       gold_files = [f for f in all_files if f.file_type == "tei" and f.is_gold_standard]

       # Build map of variant -> gold file
       gold_by_variant = {}
       for gold_file in gold_files:
           if gold_file.variant in supported_variants:
               gold_by_variant[gold_file.variant] = gold_file

       # Determine which variants to process
       if gold_only:
           # Only variants with gold files
           if not gold_by_variant:
               continue  # Skip document entirely if no gold files
           variants_to_process = list(gold_by_variant.keys())
       else:
           # All supported variants
           variants_to_process = supported_variants

       for variant in variants_to_process:
           has_gold = variant in gold_by_variant
           # Process this variant...
           # - If has_gold: gold file as main, GROBID as .generated
           # - If not has_gold: GROBID as main (no .generated suffix)
   ```

2. **Check for cached training data:**

   ```python
   # Check if we have cached training data
   cache_dir = settings.data_dir / "plugins" / "grobid" / "extractions"
   training_data_id = get_training_data_id_from_tei(tei_file)  # Read from TEI header

   if training_data_id and not force_refresh:
       cached_zip = cache_dir / f"{training_data_id}.zip"
       if cached_zip.exists():
           # Use cached data instead of fetching from GROBID
           ...
   ```

3. **Store original training data:**

   ```python
   # After fetching from GROBID:
   # 1. Extract the training_data_id from filename (the hash prefix)
   training_data_id = extracted_files[0].split(".")[0]  # e.g., "a1a2f2f2sg2g2h2..."

   # 2. Save copy of ZIP to cache directory
   cache_dir = settings.data_dir / "plugins" / "grobid" / "extractions"
   cache_dir.mkdir(parents=True, exist_ok=True)
   shutil.copy(zip_path, cache_dir / f"{training_data_id}.zip")

   # 3. Update TEI file with training-data-id
   update_tei_training_data_id(tei_file_path, training_data_id)
   ```

4. **TEI header modification:**

   Add `<label type="training-data-id">` to the GROBID application element:

   ```xml
   <application version="0.8.3-SNAPSHOT" ident="GROBID" when="..." type="extractor">
     <desc>GROBID - A machine learning software...</desc>
     <label type="revision">e13aa19</label>
     <label type="flavor">article/dh-law-footnotes</label>
     <label type="variant-id">grobid.training.segmentation</label>
     <label type="training-data-id">a1a2f2f2sg2g2h2e2f3344ffee</label>
     <ref target="https://github.com/kermitt2/grobid"/>
   </application>
   ```

5. **Output structure:**

   Default behavior (`gold_only=False`): Include all supported variants for all documents.
   - If gold exists: gold file as main `.tei.xml`, GROBID output as `.generated.tei.xml`
   - If no gold: GROBID output as main `.tei.xml` (no `.generated` suffix)

   With `gold_only=True`: Only include variants that have gold files, skip documents without any.

   ```
   collection-training-data.zip
   ├── doc_id_1/                                            # has gold for all variants
   │   ├── doc_id_1.training.segmentation.tei.xml          # gold file
   │   ├── doc_id_1.training.segmentation.generated.tei.xml # GROBID output
   │   ├── doc_id_1.training.references.referenceSegmenter.tei.xml
   │   ├── doc_id_1.training.references.referenceSegmenter.generated.tei.xml
   │   ├── doc_id_1.training.references.tei.xml
   │   └── doc_id_1.training.references.generated.tei.xml
   ├── doc_id_2/                                            # has gold only for segmentation
   │   ├── doc_id_2.training.segmentation.tei.xml          # gold
   │   ├── doc_id_2.training.segmentation.generated.tei.xml
   │   ├── doc_id_2.training.references.referenceSegmenter.tei.xml  # no gold, GROBID only
   │   └── doc_id_2.training.references.tei.xml            # no gold, GROBID only
   └── doc_id_3/                                            # no gold files at all
       ├── doc_id_3.training.segmentation.tei.xml          # GROBID only
       ├── doc_id_3.training.references.referenceSegmenter.tei.xml
       └── doc_id_3.training.references.tei.xml
   ```

### 6. Cancel Handling

**Backend listening for cancel events:**

The backend needs to listen for `progressCancel` SSE events and abort the download. This requires:

1. **Cancellation token pattern:**

   ```python
   class CancellationToken:
       def __init__(self):
           self._cancelled = False

       def cancel(self):
           self._cancelled = True

       @property
       def is_cancelled(self) -> bool:
           return self._cancelled

   # In download route:
   cancellation_tokens: dict[str, CancellationToken] = {}

   # Register token when starting
   token = CancellationToken()
   cancellation_tokens[progress.progress_id] = token

   # Check during iteration
   for pdf_file in pdf_files:
       if token.is_cancelled:
           send_notification(sse_service, session_id, "Download cancelled", "warning")
           break
       # Process document...
   ```

2. **Cancel endpoint:**

   ```python
   @router.post("/cancel/{progress_id}")
   async def cancel_progress(progress_id: str):
       if progress_id in cancellation_tokens:
           cancellation_tokens[progress_id].cancel()
           return {"status": "cancelled"}
       return {"status": "not_found"}
   ```

3. **Frontend sends cancel via POST:**

   ```javascript
   async function handleCancel(progressId) {
       await client.request('POST', `/api/plugins/grobid/cancel/${progressId}`)
   }
   ```

### 7. Settings: Plugin Data Directory

**File to modify:** `fastapi_app/config.py`

Add a `plugins_dir` property to centralize plugin data storage location:

```python
@property
def plugins_dir(self) -> Path:
    """Plugin data directory - always data_root/plugins"""
    return self.data_root / "plugins"
```

Update all references to plugin data directories to use `settings.plugins_dir`:

```python
# Before:
cache_dir = settings.data_dir / "plugins" / "grobid" / "extractions"

# After:
cache_dir = settings.plugins_dir / "grobid" / "extractions"
```

### 8. Event Bus: File Deletion Events

**File to modify:** `fastapi_app/routers/files_delete.py`

Emit a `file.deleted` event via the application event bus when files are deleted:

```python
from fastapi_app.lib.event_bus import get_event_bus

@router.post("/delete", response_model=DeleteFilesResponse)
async def delete_files(...):
    # ... existing deletion logic ...

    # After successful deletion, emit event for each deleted file
    event_bus = get_event_bus()
    for stable_id in deleted_stable_ids:
        await event_bus.emit("file.deleted", stable_id=stable_id)

    return DeleteFilesResponse(result="ok")
```

### 9. GROBID Plugin: Cache Cleanup on File Deletion

**File to modify:** `fastapi_app/plugins/grobid/__init__.py`

Register an event handler to clean up cached training data when files are deleted:

```python
from fastapi_app.lib.event_bus import get_event_bus
from fastapi_app.config import get_settings
import logging

logger = logging.getLogger(__name__)

async def on_file_deleted(stable_id: str, **kwargs):
    """
    Clean up cached GROBID training data when a file is deleted.

    Looks up the training_data_id from the TEI file and removes the
    corresponding ZIP from the cache directory.
    """
    settings = get_settings()

    # Look up training_data_id for this stable_id
    # This requires reading the TEI file or a mapping table
    training_data_id = await get_training_data_id_for_file(stable_id)

    if training_data_id:
        cache_path = settings.plugins_dir / "grobid" / "extractions" / f"{training_data_id}.zip"
        if cache_path.exists():
            cache_path.unlink()
            logger.info(f"Deleted cached training data: {cache_path}")


def register_event_handlers():
    """Register GROBID plugin event handlers."""
    event_bus = get_event_bus()
    event_bus.on("file.deleted", on_file_deleted)
```

**Mapping training_data_id to stable_id:**

Option A: Query the TEI file content before deletion (requires pre-deletion hook)
Option B: Maintain a mapping table in `data/plugins/grobid/training_data_map.json`

```python
# Option B implementation:
import json

def get_training_data_id_for_file(stable_id: str) -> str | None:
    """Look up training_data_id from mapping file."""
    settings = get_settings()
    map_path = settings.plugins_dir / "grobid" / "training_data_map.json"

    if not map_path.exists():
        return None

    with open(map_path) as f:
        mapping = json.load(f)

    return mapping.get(stable_id)


def save_training_data_mapping(stable_id: str, training_data_id: str):
    """Save stable_id -> training_data_id mapping."""
    settings = get_settings()
    map_path = settings.plugins_dir / "grobid" / "training_data_map.json"
    map_path.parent.mkdir(parents=True, exist_ok=True)

    mapping = {}
    if map_path.exists():
        with open(map_path) as f:
            mapping = json.load(f)

    mapping[stable_id] = training_data_id

    with open(map_path, "w") as f:
        json.dump(mapping, f, indent=2)
```

### 10. TEI Utility Functions

**Add to `fastapi_app/lib/tei_utils.py`:**

```python
def get_training_data_id(tei_root: etree._Element) -> str | None:
    """
    Extract training-data-id from TEI header.

    Returns the value of /TEI/teiHeader/encodingDesc/appInfo/
    application[@ident="GROBID"]/label[@type="training-data-id"]
    """
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    label = tei_root.find(
        ".//tei:encodingDesc/tei:appInfo/tei:application[@ident='GROBID']/"
        "tei:label[@type='training-data-id']",
        namespaces=ns
    )
    return label.text if label is not None else None


def set_training_data_id(tei_root: etree._Element, training_data_id: str) -> bool:
    """
    Set or update training-data-id in TEI header.

    Adds <label type="training-data-id"> to the GROBID application element.
    Returns True if successful, False if GROBID application element not found.
    """
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    grobid_app = tei_root.find(
        ".//tei:encodingDesc/tei:appInfo/tei:application[@ident='GROBID']",
        namespaces=ns
    )
    if grobid_app is None:
        return False

    # Check if label already exists
    existing_label = grobid_app.find("tei:label[@type='training-data-id']", namespaces=ns)
    if existing_label is not None:
        existing_label.text = training_data_id
    else:
        # Insert before <ref> element if present, otherwise append
        label = etree.Element("label", type="training-data-id")
        label.text = training_data_id
        ref = grobid_app.find("tei:ref", namespaces=ns)
        if ref is not None:
            ref.addprevious(label)
        else:
            grobid_app.append(label)

    return True
```

## Status

### Completed

- Progress widget template with minimize/maximize functionality
- Progress plugin with SSE event handling (singleton version)
- Session storage persistence for minimized state
- Backend `ProgressBar` class in `sse_utils.py` (singleton version)
- UI system `data-name` attribute support
- Plugin registration and type definitions
- Integration in GROBID download route (single document)

### Remaining Work

1. **Progress Widget Multi-Instance Support**
   - Convert progress widget to use templates for cloning
   - Maintain Map of active instances by progress_id
   - Implement widget stacking (CSS and JS)
   - Change minimize/maximize to click-to-toggle
   - Update SSE event handlers for progress_id

2. **SSE Notification System**
   - Add notification event listener in `sse.js`
   - Add `send_notification()` helper in `sse_utils.py`

3. **Settings: Plugin Data Directory**
   - Add `plugins_dir` property to `fastapi_app/config.py`
   - Update existing code to use `settings.plugins_dir`

4. **Event Bus: File Deletion Events**
   - Modify `files_delete.py` to emit `file.deleted` event
   - Emit event for each deleted stable_id

5. **GROBID Plugin: Cache Cleanup**
   - Register event handler for `file.deleted` event
   - Implement mapping table for stable_id -> training_data_id
   - Delete cached ZIP when file is deleted

6. **Supported Variants Configuration**
   - Create `fastapi_app/plugins/grobid/config.py` with `SUPPORTED_VARIANTS`
   - Update `extractor.py` to import from config

7. **Collection-Based Download**
   - Update route to accept `collection` instead of `pdf`
   - Add `gold_only` parameter (default: False)
   - Iterate over all documents in collection
   - Process all supported variants per document
   - Include gold files as main, GROBID as .generated when gold exists
   - Create subdirectory structure in output ZIP
   - Send progress updates per document

8. **Training Data Caching**
   - Extract training_data_id from GROBID output filenames
   - Save ZIP copies to `settings.plugins_dir/grobid/extractions/`
   - Add TEI utility functions for training-data-id
   - Update extractor to save training-data-id in TEI header
   - Save stable_id -> training_data_id mapping
   - Check cache before fetching from GROBID
   - Add `force_refresh` parameter to override caching

9. **Cancel Functionality**
   - Implement CancellationToken pattern
   - Add cancel endpoint
   - Frontend POST to cancel endpoint
   - Check cancellation during iteration
   - Send notification on cancellation

10. **Testing**

- Test progress widget multi-instance behavior
- Test widget stacking and state persistence
- Test collection download with multiple documents
- Test caching behavior (cache hit/miss)
- Test force_refresh parameter
- Test cancellation mid-download
- Verify SSE notification delivery
- Test cache cleanup on file deletion
