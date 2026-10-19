# Annotation History Plugin

Shows the annotation history of a PDF document: all its TEI versions with the revisions recorded in their `revisionDesc/change` elements (description, annotator, status, date).

## Usage

Select a document and choose "Show Annotation History" from the backend plugins menu. The history opens in a dialog as a nested table: one row per TEI version (gold versions first, then by last change) that expands to its revisions. Clicking a title opens that version. The history can be exported as CSV.

## Routes

| Route | Description |
| --- | --- |
| `GET /api/plugins/annotation-history/view?pdf=<stable_id>&variant=<variant>` | HTML view of the history; `variant=all` shows all variants |
| `GET /api/plugins/annotation-history/export?pdf=<stable_id>&variant=<variant>` | The same data as CSV, one row per revision |

For the latest changes across all documents of a collection, or of all accessible projects, see [Edit History](../edit_history/README.md).
