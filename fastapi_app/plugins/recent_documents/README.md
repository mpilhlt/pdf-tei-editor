# Recent Documents Plugin

Contributes a "Recently edited" box to the [dashboard](../dashboard/README.md): up to five documents per project that the user saved most recently, with projects ordered by their most recent edit. Clicking a document opens it.

## How edits are recorded

The files table only records who created a file. This plugin therefore listens to the `document.saved` event (emitted by `fastapi_app/routers/files_save.py` after every successful save) and keeps a per-user record in `data/plugins/recent_documents/recent_edits.json` (up to 300 files per user). On its first start it seeds the record from each TEI file's creator (`created_by`) and last update time.

## Route

`GET /api/plugins/recent-documents/recent` returns `{projects: [{id, name, documents: [...]}]}` for the projects the user can see (all non-archived projects for admins). Each document entry has the TEI and PDF stable ids, the document (PDF) label as `title`, the TEI file's `label`, variant, status, collections and `edited_at`. Documents in collections that belong only to archived projects are not listed.

## Implementation

- [plugin.py](plugin.py): extension registration, event subscription, seeding
- [edit_store.py](edit_store.py): the per-user edit record
- [routes.py](routes.py): the route above
- [extensions/recent-documents.js](extensions/recent-documents.js): the dashboard box

Depends on the `dashboard` plugin.
