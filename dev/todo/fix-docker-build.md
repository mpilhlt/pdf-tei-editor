# Fix Docker Build for FastAPI Migration

## Critical Issues Found

### 1. Dockerfile Line 87-89: Flask Legacy Paths

```dockerfile
COPY --from=builder /app/server /app/server        # ❌ Flask server - doesn't exist
COPY --from=builder /app/config /app/db            # ❌ Wrong: copies config to db
COPY --from=builder /app/demo/data /app/data       # ⚠️  Wrong location and incomplete
```

**Current FastAPI Architecture:**
- `fastapi_app/` - Backend code (replaces `/server`)
- `config/` - Default configuration templates (read-only)
- `data/db/` - Runtime database and JSON files (created from config/)
- `data/files/` - Content-addressable file storage
- Demo data needs to be **imported** to database, not just copied

### 2. Missing Demo Data Import

The Dockerfile copies `demo/data` to `/app/data`, but this doesn't work because:
- Files must be imported via `FileImporter` to be stored in content-addressable hash structure
- Files must be registered in `metadata.db` to be accessible via API
- Simply copying files doesn't make them available to the application

See [tests/lib/fixture-loader.js:91-150](../../tests/lib/fixture-loader.js#L91-L150) for correct import pattern.

### 3. docker-compose.test.yml Line 13: Flask Environment Variable

```yaml
- FLASK_ENV=testing  # ❌ Flask-specific, no longer used
```

### 4. Incorrect Comment in entrypoint-test.sh:69

```bash
# Start server using the production startup script (waitress)  # ❌ Uses uvicorn, not waitress
```

## Proposed Fixes

### Fix 1: Update Dockerfile Production Stage (Lines 84-95)

**Replace lines 84-95:**
```dockerfile
# Copy only production files from builder (no node_modules needed!)
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/app/web /app/app/web
COPY --from=builder /app/server /app/server
COPY --from=builder /app/config /app/config
COPY --from=builder /app/config /app/db

# Set production mode in the container
RUN sed -i 's/"application.mode": "development"/"application.mode": "production"/' /app/config/config.json
COPY --from=builder /app/bin /app/bin
COPY --from=builder /app/schema /app/schema
COPY --from=builder /app/demo/data /app/data
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pyproject.toml /app/pyproject.toml
```

**With:**
```dockerfile
# Copy only production files from builder
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/app/web /app/app/web
COPY --from=builder /app/fastapi_app /app/fastapi_app
COPY --from=builder /app/config /app/config
# Note: data/db/ is created at runtime from config/ by db_init.py

# Set production mode in the container
RUN sed -i 's/"application.mode": "development"/"application.mode": "production"/' /app/config/config.json
COPY --from=builder /app/bin /app/bin
COPY --from=builder /app/schema /app/schema
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pyproject.toml /app/pyproject.toml
COPY --from=builder /app/run_fastapi.py /app/run_fastapi.py

# Copy demo data and import script
COPY docker/demo-data /app/docker/demo-data
COPY docker/import-demo-data.sh /app/docker/import-demo-data.sh
RUN chmod +x /app/docker/import-demo-data.sh
```

### Fix 2: Move demo/data to docker/demo-data

Since `demo/data` is only used by Docker and E2E tests (which copy from it), consolidate:

```bash
mkdir -p docker/demo-data
mv demo/data/* docker/demo-data/
rmdir demo/data
```

Update references in:
- [tests/e2e/tests/extraction-workflow.spec.js:231](../../tests/e2e/tests/extraction-workflow.spec.js#L231)
- [tests/e2e/tests/helpers/extraction-helper.js:22](../../tests/e2e/tests/helpers/extraction-helper.js#L22)

Change `demo/data/` to `docker/demo-data/` in both files.

### Fix 3: Create docker/import-demo-data.sh Script

Create new file to import demo data properly:

```bash
#!/bin/bash
# Import demo data using FileImporter for content-addressable storage

set -e

if [ ! -d "/app/docker/demo-data" ]; then
    echo "Demo data directory not found, skipping import"
    exit 0
fi

if [ ! -f "/app/docker/demo-data/tei/example/10.5771__2699-1284-2024-3-149.tei.xml" ]; then
    echo "Demo data files not found, skipping import"
    exit 0
fi

echo "Importing demo data to database..."
.venv/bin/python bin/import_files.py \
    docker/demo-data \
    --db-path data/db/metadata.db \
    --storage-root data/files \
    --collection example \
    2>&1 | grep -E "(Importing|imported|Error)" || true

echo "✓ Demo data import completed"
```

### Fix 4: Update docker/entrypoint.sh

Add after line 61 (after setting up demo user):

```bash


# Import demo data if it exists
if [ -f "/app/docker/import-demo-data.sh" ]; then
    echo "Importing demo data..."
    bash /app/docker/import-demo-data.sh || echo "Warning: Demo data import failed"
fi
```

### Fix 5: Update docker/entrypoint-test.sh

Replace lines 25-38 (demo data checking) with:

```bash
echo "Importing demo data..."
if [ -f "/app/docker/import-demo-data.sh" ]; then
    bash /app/docker/import-demo-data.sh || echo "Warning: Demo data import failed"
else
    echo "⚠ Demo data import script not found"
fi
```

Also fix comment at line 69:

```bash
# Start server using the production startup script (uvicorn)
```

### Fix 6: Update docker-compose.test.yml

Replace line 13:
```yaml
- FASTAPI_APPLICATION_MODE=testing  # Replaces FLASK_ENV
```

## Implementation Order

1. Create `docker/import-demo-data.sh` (new file)
2. Move `demo/data/` to `docker/demo-data/`
3. Update [Dockerfile](../../Dockerfile) lines 84-100
4. Update [docker/entrypoint.sh](../../docker/entrypoint.sh) - add import call
5. Update [docker/entrypoint-test.sh](../../docker/entrypoint-test.sh) - replace demo checks, fix comment
6. Update [docker-compose.test.yml](../../docker-compose.test.yml) - environment variable
7. Update E2E test files to use new path:
   - [tests/e2e/tests/extraction-workflow.spec.js](../../tests/e2e/tests/extraction-workflow.spec.js)
   - [tests/e2e/tests/helpers/extraction-helper.js](../../tests/e2e/tests/helpers/extraction-helper.js)

## Testing

After changes:
```bash
# Build and test production image
docker build -t pdf-tei-editor:test .
docker run -p 8000:8000 pdf-tei-editor:test

# Verify demo data imported
curl http://localhost:8000/api/v1/files | jq .

# Build and test the test image
docker build --target test -t pdf-tei-editor:test-env .
docker run -p 8000:8000 pdf-tei-editor:test-env
```

## Files to Modify

- [Dockerfile](../../Dockerfile) - Fix paths, remove `/server`, add `/fastapi_app`, handle demo data import
- [docker/entrypoint.sh](../../docker/entrypoint.sh) - Add demo data import call
- [docker/entrypoint-test.sh](../../docker/entrypoint-test.sh) - Replace demo data checks with import, fix comment
- [docker-compose.test.yml](../../docker-compose.test.yml) - Replace `FLASK_ENV` with `FASTAPI_APPLICATION_MODE`
- [tests/e2e/tests/extraction-workflow.spec.js](../../tests/e2e/tests/extraction-workflow.spec.js) - Update path
- [tests/e2e/tests/helpers/extraction-helper.js](../../tests/e2e/tests/helpers/extraction-helper.js) - Update path

## Files to Create

- `docker/import-demo-data.sh` - Script to import demo data using FileImporter

## Directories to Move

- `demo/data/` → `docker/demo-data/`
