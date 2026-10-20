# Edit History Plugin

Backend plugin that lists the most recent change of every TEI document in a collection, or in all projects the user can access. It also contributes a "Recent edits" box to the dashboard.

## Features

- Reads the last `<change>` element of each document's `<revisionDesc>`
- Sorted by change date, newest first
- Clickable annotation labels to open documents
- Filters by variant when specified
- CSV export
- Edit history of all accessible, non-archived projects
- Dashboard box with the ten latest edits

## Usage

1. Select a collection in the application
2. Open the "Backend Plugins" menu
3. Select "Show Edit History" for the current collection, or "Show Edit History of All Projects"

If the [dashboard](../dashboard/README.md) plugin is active, its "Recent edits" box lists the ten latest changes; clicking a change opens the document, and "See all" in the box's title bar opens the edit history of all projects.

## Output

A sortable DataTables page with the columns:

- **Change Date**: `@when` of the last change
- **Document ID**
- **Annotation Label**: Edition title, falling back to the main title
- **Change Description**: Text of `<desc>` or of the `<change>` element
- **Who**: Annotator name, resolved from `@who` via `<respStmt>`
- **Status**: `@status` of the change (defaults to `draft`)

The CSV export (`edit-history-<collection>.csv`) has the same columns, with annotator ID and name in separate columns.

## Routes

- `GET /api/plugins/edit-history/view?collection=<id>&variant=<variant>` - HTML page
- `GET /api/plugins/edit-history/export?collection=<id>&variant=<variant>` - CSV download

- `GET /api/plugins/edit-history/all` - HTML page for all non-archived projects the user can access (admins: all)
- `GET /api/plugins/edit-history/recent?limit=10` - JSON `{"edits": [...]}` with the latest changes in the same projects, used by the dashboard box. Only the `2 × limit` most recently updated files are read.

All check collection access for the current user.

## Implementation

- **Plugin file**: [plugin.py](plugin.py)
- **Routes file**: [routes.py](routes.py)
- **Dashboard box**: [extensions/edit-history-dashboard.js](extensions/edit-history-dashboard.js)
- **Tests**: [tests/test_edit_history_export.py](tests/test_edit_history_export.py), [tests/test_all_projects.py](tests/test_all_projects.py), [tests/edit-history-dashboard.test.js](tests/edit-history-dashboard.test.js) (run with `node --test`)

## Technical Details

- Category: `collection`
- Requires: User role or higher
- Endpoints: `show_history` (state parameters `collection`, `variant`), `show_all` (none)
- For a feed of all changes, not only the last one per document, see [Revision Feed](../revision_feed/README.md)
