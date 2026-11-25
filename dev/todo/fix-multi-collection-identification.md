# Fix Multi-Collection Document Identification

**GitHub Issue:** [#152](https://github.com/mpilhlt/pdf-tei-editor/issues/152)

## Problem

A document can belong to several collections. Code that needed "the" collection of a document used `collections[0]`, so opening a document switched `state.collection` to its first collection instead of keeping the user's current one.

## Status

### Done

- **`services.load()`** - fixed in 5796137c (#897). `#getCollectionChanges` in [app/src/plugins/services.js](app/src/plugins/services.js) keeps `state.collection` if the document belongs to it, and only otherwise switches `collection`/`project` (and a `collectionFilter` that excludes the document).
- **Selectbox handlers** - `#onChangePdfSelection` and `#onChangeXmlSelection` in [app/src/plugins/file-selection.js](app/src/plugins/file-selection.js) choose the collection with `pickDocumentCollection(file.collections, state.collection, state.collectionFilter)` ([app/src/modules/file-data-utils.js](app/src/modules/file-data-utils.js)): current collection, then the filter, then the first collection. The PDF handler now also sets `project`.
- **File selection drawer** - tree items in [app/src/plugins/file-selection-drawer.js](app/src/plugins/file-selection-drawer.js) carry the collection group they are listed under instead of `file.collections[0]`, so clicking a document under collection B opens it in B. Items in the `__unfiled` pseudo-group carry no collection (previously the string `"undefined"`).

### Remaining (low impact, no collection context available)

- `findCollectionById()` and `findCorrespondingSource()` in [app/src/modules/file-data-utils.js](app/src/modules/file-data-utils.js) return the first collection.
- Dashboard widgets `review_queue` and `recent_documents` (`fastapi_app/plugins/*/extensions/*.js`) call `dashboard.openDocument(..., doc.collections[0])`. They have no collection context; `services.load()` keeps the current collection if it contains the document only when no collection is passed, so these could pass `null` instead if the dashboard should preserve context.
- Extraction dialog default (`collections[0].id` in [app/src/plugins/extraction.js](app/src/plugins/extraction.js)) refers to the list of all collections, not a document's collections - not part of this bug.
- URL hash: `collection` is not persisted in the hash. After a reload, `services.load()` falls back to the session's collection/filter if it contains the document, otherwise the first collection.

## Testing

1. Document in a single collection - unchanged behavior.
2. Document in collections A and B, current collection B: selecting it in the selectbox or under B in the drawer keeps B; selecting it under A in the drawer switches to A.
3. Move/copy to another collection switches to the destination.
4. Unit tests: `tests/unit/js/file-data-utils-collection.test.js`.
