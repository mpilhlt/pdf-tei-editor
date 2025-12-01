# Docker Development Guide

Comprehensive guide for building, testing, and deploying Docker images for PDF TEI Editor.

## Overview

The application uses a multi-stage Dockerfile that creates optimized production images:

- **Base stage**: System dependencies and Python/Node.js setup
- **Builder stage**: Builds frontend assets and installs dependencies
- **Test stage**: Includes test dependencies and fixtures
- **Production stage**: Minimal runtime image

## Building Images

### NPM Commands

Use npm scripts for convenience (Docker/Podman auto-detected):

```bash
# Start/stop containers
npm run container:start
npm run container:start -- --tag v1.0.0 --port 8080
npm run container:stop
npm run container:stop -- --name pdf-tei-editor-v1.0.0

# Build image locally (no push)
npm run container:build -- v1.0.0

# Build without cache (force rebuild all layers)
npm run container:build:no-cache -- v1.0.0

# Build and push to registry
npm run container:push -- v1.0.0

# Push existing image (skip build)
npm run container:push -- --no-build v1.0.0
```

### Build Script

Or use the build script directly:

```bash
# Build only (no push to registry)
bin/image-build-and-push.js --build-only v1.0.0

# Build and push to Docker Hub
bin/image-build-and-push.js v1.0.0
```

### Manual Build

```bash
# Production image
docker build -t pdf-tei-editor:latest --target production .

# Test image
docker build -t pdf-tei-editor:test --target test .

# Specific version
docker build -t pdf-tei-editor:v1.0.0 --target production .
```

### Build Stages

#### Base Stage

Sets up the foundation:

- Ubuntu 24.04 base
- Python 3.12 via uv
- Node.js 22 via nvm
- System dependencies (libmagic, curl, etc.)

#### Builder Stage

Creates production assets:

- Installs Python dependencies
- Installs Node.js dependencies
- Builds frontend (bundles JavaScript, processes CSS)
- Removes development dependencies

#### Test Stage

Extends builder with test requirements:

- Includes Playwright browsers
- Copies test fixtures
- Retains development dependencies

#### Production Stage

Minimal runtime image:

- Copies only production files from builder
- Includes demo data and import script
- Sets production mode in config
- Runs as unprivileged user

## Environment Variables

### Build-Time Variables

None currently required. All configuration is runtime.

### Runtime Variables

See [Docker Deployment Guide](../user-manual/docker-deployment.md#environment-variables) for user-facing variables.

Development-specific variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATA_ROOT` | Parent directory for files/ and db/ | `data` |
| `IMPORT_DATA_PATH` | Path to import data from | `docker/demo-data` |
| `TEST_IN_PROGRESS` | Enables test mode features | Not set |
| `FASTAPI_APPLICATION_MODE` | Application mode (testing/production) | From config |

## Entrypoint Scripts

### Production Entrypoint (`docker/entrypoint.sh`)

Handles production container initialization:

1. Sets default port (8000)
2. Creates default admin/demo users if no passwords provided
3. Applies custom login message if set
4. Updates user passwords from environment variables
5. Imports demo data if present
6. Starts production server (waitress)

### Test Entrypoint (`docker/entrypoint-test.sh`)

Handles test container initialization:

1. Sources nvm for Node.js
2. Creates data directories
3. Imports data if `IMPORT_DATA_PATH` is set
4. Copies test fixtures
5. Creates fallback test user
6. Sets testing mode in config
7. Starts test server

## Data Import System

### Import Script (`docker/import-demo-data.sh`)

Generic script for importing PDF and XML files into the database:

```bash
#!/bin/bash
# Uses IMPORT_DATA_PATH environment variable

IMPORT_PATH="${IMPORT_DATA_PATH:-docker/demo-data}"

# Validates directory exists and contains PDF/XML files
# Imports using bin/import_files.py with --recursive-collections
# Collections determined by top-level subdirectory names
# Stores files in content-addressable storage (data/files)
# Creates metadata entries in database (data/db/metadata.db)
```

**Collection Assignment:**

- Uses `--recursive-collections` flag for automatic collection naming
- Top-level subdirectories become collection names
- Organizational directories (`pdf`, `tei`, `versions`, `version`) are skipped
- Files in the root of `IMPORT_PATH` have no collection

### Usage in Containers

#### Production

Always imports demo data on startup:

```dockerfile
# Import demo data if present
if [ -f /app/docker/import-demo-data.sh ]; then
    echo "Importing demo data..."
    /app/docker/import-demo-data.sh
fi
```

#### Testing

Conditionally imports based on `IMPORT_DATA_PATH`:

```dockerfile
# Import data if IMPORT_DATA_PATH is set
if [ -n "$IMPORT_DATA_PATH" ] && [ -f "/app/docker/import-demo-data.sh" ]; then
    echo "Importing data from $IMPORT_DATA_PATH..."
    bash /app/docker/import-demo-data.sh
fi
```

### Custom Data Import

Mount custom data and set `IMPORT_DATA_PATH`:

```bash
docker run -p 8000:8000 \
  -v $(pwd)/my-documents:/app/custom-data:ro \
  -e IMPORT_DATA_PATH=custom-data \
  pdf-tei-editor:latest
```

The script will:

1. Check if `/app/custom-data` exists
2. Search for `.pdf` and `.xml` files recursively
3. Assign collections based on top-level subdirectories
   - Files in `/app/custom-data/collection1/` → "collection1" collection
   - Files in `/app/custom-data/collection1/pdf/` → "collection1" collection (skips "pdf")
   - Files in `/app/custom-data/` (root) → no collection
4. Store files using content-addressable hashing in `/app/data/files`
5. Create metadata entries in `/app/data/db/metadata.db`

## Testing

### Test Container

The test stage includes E2E test infrastructure:

```bash
# Build test image
docker build -t pdf-tei-editor:test --target test .

# Run with docker-compose
docker-compose -f docker-compose.test.yml up
```

### Test Configuration

`docker-compose.test.yml` settings:

```yaml
environment:
  - FASTAPI_APPLICATION_MODE=testing
  - TEST_IN_PROGRESS=1
  - IMPORT_DATA_PATH=docker/demo-data

volumes:
  - ./tests/e2e/fixtures:/app/test-data:ro
```

### Running E2E Tests Against Container

```bash
# Start test container
docker-compose -f docker-compose.test.yml up -d

# Wait for health check
docker-compose -f docker-compose.test.yml ps

# Run tests from host
npm run test:e2e

# Cleanup
docker-compose -f docker-compose.test.yml down
```

## Deployment Scripts

### Container Deployment (`bin/deploy-container.sh`)

Automated deployment script with multiple modes:

```bash
# Production deployment
sudo bin/deploy-container.sh \
  --image cboulanger/pdf-tei-editor:latest \
  --fqdn editor.company.com \
  --type production \
  --admin-password secure_password \
  --data-dir /opt/pdf-data \
  --config-dir /opt/pdf-config \
  --db-dir /opt/pdf-db

# Demo deployment (ephemeral)
sudo bin/deploy-container.sh \
  --image cboulanger/pdf-tei-editor:latest \
  --fqdn demo.example.com \
  --type demo \
  --admin-password demo123

# Local testing
bin/deploy-container.sh \
  --image pdf-tei-editor:dev \
  --fqdn localhost \
  --port 8080 \
  --no-ssl \
  --no-nginx
```

Features:

- Automatic SSL certificate management (Let's Encrypt)
- Nginx reverse proxy configuration
- Persistent volume management
- Container lifecycle management (stop old, start new)

### Cron Setup (`bin/setup-cron.sh`)

Automated demo resets:

```bash
# Nightly reset at 2 AM
bin/setup-cron.sh \
  --image cboulanger/pdf-tei-editor:latest \
  --fqdn demo.example.com

# Custom schedule
bin/setup-cron.sh \
  --image cboulanger/pdf-tei-editor:latest \
  --fqdn demo.example.com \
  --time "0 3 * * *"
```

## Development Workflow

### Local Development Build and Test

```bash
# 1. Build dev image locally
bin/image-build-and-push.js --build-only dev

# 2. Test locally without SSL
bin/deploy-container.sh \
  --image pdf-tei-editor:dev \
  --fqdn localhost \
  --port 8080 \
  --no-ssl \
  --no-nginx \
  --admin-password admin

# 3. Access at http://localhost:8080
# Login: admin/admin

# 4. View logs
docker logs -f pdf-tei-editor-localhost
```

### Version Release

```bash
# 1. Update version in package.json
npm version 1.2.0

# 2. Build and tag
bin/image-build-and-push.js --build-only v1.2.0

# 3. Test the version
bin/deploy-container.sh \
  --image pdf-tei-editor:v1.2.0 \
  --fqdn localhost \
  --port 8080 \
  --no-ssl \
  --no-nginx

# 4. Push to Docker Hub
bin/image-build-and-push.js v1.2.0

# 5. Tag as latest if stable
docker tag pdf-tei-editor:v1.2.0 cboulanger/pdf-tei-editor:latest
docker push cboulanger/pdf-tei-editor:latest
```

### Docker Hub Publishing

Requires environment variables in `.env`:

```bash
DOCKER_HUB_USERNAME=your_username
DOCKER_HUB_TOKEN=your_access_token
```

The build script automatically:

1. Logs into Docker Hub
2. Builds the image
3. Tags with version and `latest`
4. Pushes to registry

## File Structure

### Build Context

```
.
├── Dockerfile              # Multi-stage build definition
├── docker/
│   ├── entrypoint.sh      # Production entrypoint
│   ├── entrypoint-test.sh # Test entrypoint
│   ├── import-demo-data.sh # Data import script
│   └── demo-data/         # Demo PDF/XML files
├── bin/
│   ├── deploy-container.sh    # Deployment automation
│   ├── setup-cron.sh          # Cron scheduling
│   └── image-build-and-push.js # Build script
└── docker-compose.test.yml    # Test composition
```

### Runtime Directories

Inside container:

```
/app/
├── .venv/                 # Python virtual environment
├── app/web/               # Built frontend assets
├── fastapi_app/           # Backend API
├── bin/                   # Management scripts
├── schema/                # XSD schemas
├── config/                # Configuration (mountable)
├── data/                  # Data storage (mountable)
│   ├── files/            # Content-addressable file storage
│   ├── db/               # Application databases
│   │   ├── metadata.db   # SQLite metadata database
│   │   ├── users.json    # User accounts
│   │   └── roles.json    # Role definitions
│   └── versions/         # File version history
└── docker/
    ├── demo-data/        # Demo files for import
    └── import-demo-data.sh
```

**Configuration:**

- `DATA_ROOT` environment variable controls the parent data directory (default: `data`)
- File storage is always at `DATA_ROOT/files`
- Database is always at `DATA_ROOT/db`
- This consolidated structure simplifies mounting and backups

## Dockerfile Details

### Key Sections

```dockerfile
# Base: System setup
FROM ubuntu:24.04 as base
RUN apt-get update && apt-get install -y \
    python3.12 libmagic1 curl ...

# Builder: Build frontend and install deps
FROM base as builder
RUN npm run build
RUN uv sync --frozen

# Test: Add test dependencies
FROM builder as test
RUN npx playwright install --with-deps chromium

# Production: Minimal runtime
FROM base as production
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/app/web /app/app/web
COPY docker/demo-data /app/docker/demo-data
COPY docker/import-demo-data.sh /app/docker/import-demo-data.sh
```

### Optimization Techniques

1. **Multi-stage build**: Keeps final image small (~500MB vs ~2GB)
2. **Layer caching**: Dependencies installed before code copy
3. **Minimal runtime**: Only production files in final stage
4. **Cleanup**: Removes `.pyc`, `__pycache__`, `node_modules`

## Security

### Container Security

- Non-root user (app runs as `root` currently, TODO: add unprivileged user)
- Minimal attack surface (only required ports exposed)
- No unnecessary packages in production stage
- Environment-based secrets (not baked into image)

### Image Scanning

Recommended tools:

```bash
# Trivy
trivy image pdf-tei-editor:latest

# Docker Scout
docker scout cves pdf-tei-editor:latest
```

## Troubleshooting

### Build Failures

```bash
# Clean build (no cache)
docker build --no-cache -t pdf-tei-editor:latest --target production .

# Check build logs
docker build -t pdf-tei-editor:latest --target production . 2>&1 | tee build.log
```

### Runtime Issues

```bash
# Access container shell
docker exec -it <container_id> /bin/bash

# Check logs
docker logs -f <container_id>

# Inspect running processes
docker exec -it <container_id> ps aux

# Check disk usage
docker exec -it <container_id> df -h
```

### Common Issues

**Import script not found:**

```bash
# Verify script is executable
docker exec -it <container_id> ls -la /app/docker/import-demo-data.sh
```

**Demo data not importing:**

```bash
# Check IMPORT_DATA_PATH
docker exec -it <container_id> env | grep IMPORT

# Check data directory
docker exec -it <container_id> ls -la /app/docker/demo-data
```

**Database issues:**

```bash
# Check database directory structure
docker exec -it <container_id> ls -la /app/data/db/

# Verify database file exists
docker exec -it <container_id> stat /app/data/db/metadata.db

# Check file storage
docker exec -it <container_id> ls -la /app/data/files/
```

## Performance

### Image Size

```bash
# Check image sizes
docker images pdf-tei-editor

# Expected sizes:
# production: ~500MB
# test: ~2GB (includes Playwright browsers)
# builder: ~1.5GB (not pushed to registry)
```

### Startup Time

- Production: ~3-5 seconds
- Test (with import): ~10-15 seconds
- Test (without import): ~3-5 seconds

### Resource Usage

Recommended minimums:

- **Memory**: 512MB (1GB recommended)
- **CPU**: 1 core (2 cores recommended)
- **Disk**: 2GB for image + 1GB for data

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Build and Push Docker Image

on:
  push:
    tags:
      - 'v*'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Build image
        run: |
          docker build -t pdf-tei-editor:${{ github.ref_name }} \
            --target production .

      - name: Login to Docker Hub
        uses: docker/login-action@v2
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_TOKEN }}

      - name: Push image
        run: |
          docker tag pdf-tei-editor:${{ github.ref_name }} \
            cboulanger/pdf-tei-editor:${{ github.ref_name }}
          docker push cboulanger/pdf-tei-editor:${{ github.ref_name }}
```

## Best Practices

1. **Always specify versions** - Don't use `latest` in production
2. **Use health checks** - Implement proper container health monitoring
3. **Separate concerns** - Use volumes for data, environment for config
4. **Test before deploying** - Build locally and test before pushing
5. **Monitor resources** - Set memory/CPU limits in production
6. **Regular updates** - Keep base image and dependencies updated
7. **Secure secrets** - Never commit credentials, use environment variables
8. **Log aggregation** - Send logs to external system for analysis
