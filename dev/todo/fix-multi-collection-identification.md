# Fix Multi-Collection Document Identification

**GitHub Issue:** [#152](https://github.com/mpilhlt/pdf-tei-editor/issues/152)

## Problem

When a document belongs to multiple collections, collection identification fails because the code always uses the first collection in the `collections` array (`collections[0]`). This causes unwanted UI mutations - when loading a document that's in multiple collections, the UI switches to whichever collection happens to be first in the array, rather than preserving the user's current collection context.

## Root Causes

### 1. services.load() always uses first collection
- [app/src/plugins/services.js:232](app/src/plugins/services.js#L232) - Sets collection for PDF files
- [app/src/plugins/services.js:242](app/src/plugins/services.js#L242) - Sets collection for XML artifacts
- Both use `fileData.collections[0]` unconditionally

### 2. File selection change handlers use first collection
- [app/src/plugins/file-selection.js:636](app/src/plugins/file-selection.js#L636) - XML selection change uses `file.collections[0]`

### 3. Utility functions default to first collection
- [app/src/modules/file-data-utils.js:301](app/src/modules/file-data-utils.js#L301) - `findCollectionById()`
- [app/src/modules/file-data-utils.js:370](app/src/modules/file-data-utils.js#L370) - `findCorrespondingSource()`

### 4. Extraction dialog defaults to first collection
- [app/src/plugins/extraction.js:366](app/src/plugins/extraction.js#L366) - Uses `collections[0].id`

## Solution

### 1. Update services.load() to accept collection context

Modify `load()` function signature to accept optional `collection` parameter:

```javascript
/**
 * Loads the given XML and/or PDF file(s) into the editor and viewer
 * @param {{xml?: string | null, pdf?: string | null, collection?: string | null}} files
 */
async function load({ xml, pdf, collection }) {
```

Update collection assignment logic (around lines 222-250):

```javascript
// Set collection and variant based on loaded documents
if (currentState.fileData && (pdf || xml)) {
  for (const file of currentState.fileData) {
    const fileData = /** @type {any} */ (file);
    let foundMatch = false;

    // Check source id
    if (pdf && fileData.source && fileData.source.id === pdf) {
      // Only update collection if explicitly provided or no current collection
      if (collection) {
        // Validate provided collection
        if (fileData.collections.includes(collection)) {
          stateChanges.collection = collection;
        } else {
          logger.warn(`Document ${pdf} is not in collection ${collection}`);
        }
      } else if (!currentState.collection) {
        // No collection context - use first as fallback
        stateChanges.collection = fileData.collections[0];
      }
      // Else: preserve currentState.collection
      foundMatch = true;
    }

    // Check XML id in artifacts
    if (xml) {
      const matchingArtifact = fileData.artifacts &&
        fileData.artifacts.find(artifact => artifact.id === xml);
      if (matchingArtifact) {
        // Only update collection if explicitly provided or no current collection
        if (collection) {
          if (fileData.collections.includes(collection)) {
            stateChanges.collection = collection;
          } else {
            logger.warn(`Document ${xml} is not in collection ${collection}`);
          }
        } else if (!currentState.collection) {
          stateChanges.collection = fileData.collections[0];
        }
        // Else: preserve currentState.collection

        if (matchingArtifact.variant) {
          stateChanges.variant = matchingArtifact.variant;
        }
        foundMatch = true;
      }
    }

    if (foundMatch) break;
  }
}
```

### 2. Update callers to pass collection context

Update these callers to preserve or specify collection context:

**file-selection.js:**
```javascript
// Line ~609 - onChangeFileSelection
const collection = file.collections[0]; // Get from selected file
await services.load({ ...filesToLoad, collection });

// Line ~643 - onChangeXmlSelection
await services.load({ xml, collection: state.collection });
```

**move-files.js:**
```javascript
// Line ~197 - After move/copy
await services.load({
  pdf: result.new_pdf_id,
  xml: result.new_xml_id,
  collection: destinationCollection
});
```

**file-selection-drawer.js:**
```javascript
// Line ~695
await services.load({ ...filesToLoad, collection: state.collection });
```

### 3. Update file-selection.js XML change handler

At line ~636, instead of always setting to first collection, preserve current state or validate:

```javascript
// Find the collection for this XML file
for (const file of state.fileData) {
  const hasArtifactMatch = file.artifacts &&
    file.artifacts.some(artifact => artifact.id === xml);

  if (hasArtifactMatch) {
    // Only update if current collection is not in file's collections
    if (!state.collection || !file.collections.includes(state.collection)) {
      await app.updateState({ collection: file.collections[0] });
    }
    break;
  }
}
```

### 4. Consider URL hash persistence

Review whether the URL hash should persist `collection` parameter to maintain context across page reloads. Check current URL hash handling in:
- [app/src/plugins/start.js](app/src/plugins/start.js) - Initial URL hash parsing
- Any code using `UrlHash.set()` or `UrlHash.get()` for collection

### 5. Update utility functions (optional)

Consider updating helper functions to accept optional collection parameter or return all collections:

```javascript
// file-data-utils.js
export function findCollectionById(id, preferredCollection = null) {
  const entry = getFileDataById(id);
  if (!entry || !entry.file.collections) return null;

  // If preferred collection is specified and document is in it, use it
  if (preferredCollection && entry.file.collections.includes(preferredCollection)) {
    return preferredCollection;
  }

  // Otherwise return first collection
  return entry.file.collections[0];
}
```

## Testing

After implementation, test these scenarios:

1. Document in single collection - should work as before
2. Document in multiple collections:
   - Load document in collection A
   - Switch to collection B view
   - Load same document - should stay in collection B context
3. Move/copy document to different collection - should switch to destination collection
4. URL with collection parameter - should respect the collection in URL
5. Refresh page while viewing multi-collection document - should preserve collection context

## Additional Considerations

- Handle case where document is removed from current collection while being viewed
- Consider whether variant filtering interacts with collection context
- Update any documentation about collection handling
- Ensure backward compatibility for code that doesn't pass collection parameter
