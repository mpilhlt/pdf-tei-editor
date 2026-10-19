# Collection Coverage Overview Plugin

Backend plugin that shows gold-standard coverage and annotation lifecycle progress for every collection/variant combination the current user can access.

## Features

- One row per collection and annotation variant, with document count, gold-standard count and average lifecycle progress
- Summary figures: collections in scope, documents tracked, combinations, rows needing attention
- Facet filters for collection and variant, and a "needs attention only" toggle (low average progress or no dominant lifecycle stage)
- "Open progress" link per row that opens the [Annotation Progress](../annotation_progress/README.md) view for that collection and variant
- CSV export of the full, unfiltered overview

## Usage

1. Open the "Backend Plugins" menu
2. Select "Show Collection Coverage"

The view is not scoped to the currently selected collection or document.

## Routes

- `GET /api/plugins/collection-overview/view` - HTML page shell
- `GET /api/plugins/collection-overview/data` - Rows and lifecycle order as JSON
- `GET /api/plugins/collection-overview/export` - CSV download (`collection-coverage-overview.csv`)

## Implementation

- **Plugin file**: [plugin.py](plugin.py)
- **Routes file**: [routes.py](routes.py)
- **View**: [static/view.html](static/view.html), [static/view.js](static/view.js), [static/styles.css](static/styles.css)
- **Tests**: [tests/test_collection_overview.py](tests/test_collection_overview.py)

## Technical Details

- Category: `collection`
- Requires: User role or higher
- Depends on: `annotation-progress`
- State parameters: none
- Accessible collections are resolved via project membership (`get_user_collections()`)
- Row data comes from `build_overview_rows()` in `fastapi_app/lib/services/statistics.py`; lifecycle stages come from the `annotation.lifecycle.order` config key
