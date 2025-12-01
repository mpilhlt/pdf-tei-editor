#!/bin/bash
# Import data using FileImporter for content-addressable storage
# Uses IMPORT_DATA_PATH environment variable to specify source directory

set -e

# Use IMPORT_DATA_PATH if set, otherwise default to docker/demo-data
IMPORT_PATH="${IMPORT_DATA_PATH:-docker/demo-data}"

if [ ! -d "/app/$IMPORT_PATH" ]; then
    echo "Import data directory not found: $IMPORT_PATH, skipping import"
    exit 0
fi

# Check for any .pdf or .xml files
if ! find "/app/$IMPORT_PATH" -type f \( -name "*.pdf" -o -name "*.xml" \) | grep -q .; then
    echo "No PDF or XML files found in $IMPORT_PATH, skipping import"
    exit 0
fi

echo "Importing data from $IMPORT_PATH to database..."
.venv/bin/python bin/import_files.py \
    "$IMPORT_PATH" \
    --db-path data/db/metadata.db \
    --storage-root data/files \
    --recursive-collections \
    2>&1 | grep -E "(Importing|imported|Error)" || true

echo "✓ Data import completed from $IMPORT_PATH"
