# Edit History Plugin

Backend plugin that lists the most recent change of every TEI document in a collection.

## Features

- Reads the last `<change>` element of each document's `<revisionDesc>`
- Sorted by change date, newest first
- Clickable annotation labels to open documents
- Filters by variant when specified
- CSV export

## Usage

1. Select a collection in the application
2. Open the "Backend Plugins" menu
3. Select "Show Edit History"

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

Both check collection access for the current user.

## Implementation

- **Plugin file**: [plugin.py](plugin.py)
- **Routes file**: [routes.py](routes.py)
- **Tests**: [tests/test_edit_history_export.py](tests/test_edit_history_export.py)

## Technical Details

- Category: `collection`
- Requires: User role or higher
- State parameters: `collection`, `variant`
- For a feed of all changes, not only the last one per document, see [Revision Feed](../revision_feed/README.md)
