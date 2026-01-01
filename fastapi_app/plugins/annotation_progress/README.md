# Annotation Progress Plugin

Backend plugin that provides an overview of annotation progress for documents in a collection.

## Features

- Displays all documents in the current collection
- Shows annotation labels with revision counts for each document
- Groups annotations by document ID
- Clickable annotation labels to open documents
- Includes documents without annotations
- Filters by variant when specified

## Usage

1. Select a collection in the application
2. Open the "Backend Plugins" menu
3. Select "Show Annotation Progress"

## Output

The plugin generates a sortable DataTables page with:

- **Document ID**: The identifier for each document in the collection
- **Annotations**: Comma-separated list of annotation labels with revision counts in brackets
  - Example: `Manual Annotation (5), Gold Standard (3)`
  - Each label is clickable and opens the corresponding annotation

Documents without any annotations are listed with "No annotations" in the annotations column.

## Implementation

- **Plugin file**: [plugin.py](plugin.py)
- **Routes file**: [routes.py](routes.py)
- **Tests**: [tests/test_annotation_progress.py](tests/test_annotation_progress.py)

## Technical Details

- Category: `collection` (appears under Collection menu)
- Requires: User role or higher
- State parameters: `collection`, `variant`
- Uses DataTables for sortable, searchable table display
- Extracts edition title from TEI `<editionStmt>` or falls back to main title
- Counts all `<change>` elements in `<revisionDesc>` for revision count
