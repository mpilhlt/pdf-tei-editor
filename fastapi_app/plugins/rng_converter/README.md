# RelaxNG Schema Generator Plugin

Generates a RelaxNG schema from the structure of the currently open TEI document.

## Features

- Collects all elements, their children and attributes used in the document
- Keeps namespace prefixes and declares the `xml` namespace for `xml:id` and similar attributes
- Makes attributes optional ("balanced" strictness), so the schema validates documents with a similar but not identical structure
- Downloads the schema as `<doc_id>-<variant>.rng`

## Usage

1. Open a TEI document
2. Open the "Backend Plugins" menu
3. Select "Generate RelaxNG Schema"
4. Click "Export" in the result dialog to download the schema

## Routes

- `GET /api/plugins/rng-converter/download?file_id=<stable_id>&variant=<variant>` - Generate and download the schema. Checks collection access for the document.

## Implementation

- **Plugin file**: [plugin.py](plugin.py)
- **Routes file**: [routes.py](routes.py)
- **Schema generation**: [rng_generator.py](rng_generator.py) (`generate_rng_schema()`, `SchemaAnalyzer`)
- **Tests**: [tests/](tests/)

## Technical Details

- Category: `converter`
- Requires: Reviewer role or higher
- State parameters: `xml`, `variant`
