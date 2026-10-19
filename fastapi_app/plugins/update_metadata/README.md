# Update Metadata Plugin

Admin plugin that updates the bibliographic metadata (`<biblStruct>` in `<sourceDesc>`) of all TEI documents in batch.

## Features

- Looks up metadata by DOI via CrossRef/DataCite
- Optional LLM extraction from the PDF when no DOI is available
- Optionally overwrites existing `<biblStruct>` elements
- Progress bar via SSE, with cancellation
- Summary page with update statistics

## Usage

1. Open the "Backend Plugins" menu
2. Select "Update All Metadata"
3. Choose the options:
   - **Metadata retrieval and extraction**: DOI lookup, with LLM extraction as fallback
   - **Metadata retrieval only**: DOI lookup only; documents without DOI are skipped
   - **Overwrite existing metadata**: Replace existing `<biblStruct>` elements
4. Click "Start"

## Routes

All routes except `cancel` require the admin role.

- `GET /api/plugins/update-metadata/options` - Options form
- `GET /api/plugins/update-metadata/execute?force=<bool>&extraction_fallback=<bool>&limit=<n>` - Run the update and return the summary page. `limit` restricts the number of PDFs processed.
- `POST /api/plugins/update-metadata/cancel/<progress_id>` - Cancel a running update

## Implementation

- **Plugin file**: [plugin.py](plugin.py)
- **Routes file**: [routes.py](routes.py)
- **Update logic**: `update_tei_metadata()` in `fastapi_app/lib/services/metadata_update_utils.py`
- **Tests**: [tests/test_routes_auth.py](tests/test_routes_auth.py)

## Technical Details

- Category: `admin`
- Requires: Admin role
- State parameters: none
- Processes PDF entries, enriches their metadata, then updates all TEI files linked by `doc_id`
