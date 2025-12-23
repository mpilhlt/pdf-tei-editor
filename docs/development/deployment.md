# Deployment Guide (Developer Documentation)

This guide covers deployment implementation details for developers working on the PDF TEI Editor deployment infrastructure.

**For common deployment scenarios:** See the [User Manual: Docker Deployment Guide](../user-manual/docker-deployment.md)

## Quick Reference

The deployment system consists of three layers:

1. **User-facing wrapper** (`bin/deploy.js`) - Environment file-based deployment
2. **Container management** (`bin/container.js deploy`) - Low-level container operations
3. **Container runtime** - Docker/Podman commands

## Deployment Wrapper Script

### Overview

`bin/deploy.js` provides a simplified deployment interface using `.env` files:

```bash
npm run deploy .env.deploy.example.org
# Executes: node bin/deploy.js .env.deploy.example.org
```

### Implementation

The script:

1. Parses environment file using `dotenv`
2. Splits variables into deployment options (`DEPLOY_*`) and container environment variables
3. Converts `DEPLOY_*` variables to command-line options:
   - `DEPLOY_FQDN=example.org` → `--fqdn example.org`
   - `DEPLOY_DATA_DIR=/path` → `--data-dir /path`
   - `DEPLOY_REBUILD=true` → `--rebuild`
   - `DEPLOY_REBUILD=(''|0|false|off)` → (omitted)
4. Detects localhost deployments (`localhost` or `127.0.0.1`) and adds `--no-nginx --no-ssl`
5. Passes all non-`DEPLOY_*` variables to container via `--env VAR_NAME`
6. Executes `bin/container.js deploy` with constructed arguments

**Source:** [bin/deploy.js](../../bin/deploy.js)

### Example Environment File

```bash
# Deployment options
DEPLOY_FQDN=editor.company.com
DEPLOY_TYPE=production
DEPLOY_DATA_DIR=/opt/pdf-tei-editor/data
DEPLOY_TAG=latest

# Container environment (passed via --env)
APP_ADMIN_PASSWORD=secure-password
GEMINI_API_KEY=your-key
LOG_LEVEL=WARNING
```

Translates to:

```bash
node bin/container.js deploy \
  --fqdn editor.company.com \
  --type production \
  --data-dir /opt/pdf-tei-editor/data \
  --tag latest \
  --env APP_ADMIN_PASSWORD \
  --env GEMINI_API_KEY \
  --env LOG_LEVEL
```

## Container Management Script

### Deploy Command

`bin/container.js deploy` handles the complete deployment workflow:

```bash
node bin/container.js deploy \
  --fqdn editor.company.com \
  --type production \
  --data-dir /opt/pdf-tei-editor/data \
  --env GEMINI_API_KEY \
  --env LOG_LEVEL=WARNING
```

### Implementation Details

The deploy command ([bin/container.js](../../bin/container.js:1245-1476)):

1. **Platform check** - Ensures Linux for nginx/SSL features
2. **FQDN validation** - Requires `--fqdn` parameter
3. **Permission check** - Requires sudo if nginx or SSL enabled
4. **Dependency check** - Verifies nginx/certbot availability
5. **Image verification** - Checks if image exists (or rebuilds with `--rebuild`)
6. **Container cleanup** - Stops and removes existing container
7. **Container start** - Calls `startContainer()` with configuration
8. **Nginx setup** - Configures reverse proxy (if not `--no-nginx`)
9. **SSL setup** - Requests Let's Encrypt certificate (if not `--no-ssl`)
10. **DNS verification** - Validates domain resolution before SSL

### Key Functions

**`startContainer(config)`** ([bin/container.js](../../bin/container.js:545-611))

Creates and starts a container with specified configuration:

```javascript
await startContainer({
  name: 'pdf-tei-editor-editor-company-com',
  imageName: 'pdf-tei-editor:latest',
  port: 8001,
  detach: true,
  restart: 'unless-stopped',
  env: ['GEMINI_API_KEY', 'LOG_LEVEL'],
  volumes: [{ host: '/opt/pdf-tei-editor/data', container: '/app/data' }],
  additionalEnvVars: [{ key: 'DATA_ROOT', value: '/app/data' }]
});
```

Emitted command:

```bash
podman run -d \
  --name pdf-tei-editor-editor-company-com \
  -p 8001:8000 \
  -e PORT=8000 \
  -e DATA_ROOT=/app/data \
  -e GEMINI_API_KEY \
  -e LOG_LEVEL \
  --restart unless-stopped \
  -v /opt/pdf-tei-editor/data:/app/data \
  pdf-tei-editor:latest
```

**`setupNginx(fqdn, port)`** ([bin/container.js](../../bin/container.js:1042-1144))

Generates nginx configuration with:

- Reverse proxy to container port
- API endpoint no-cache headers (fixes #114)
- SSE support with extended timeouts
- File upload size limits (100MB)
- Proxy headers preservation

Writes to `/etc/nginx/sites-available/pdf-tei-editor-{fqdn}` and symlinks to `sites-enabled`.

**`setupSSL(fqdn, email)`** ([bin/container.js](../../bin/container.js:1200-1225))

Requests SSL certificate:

```bash
certbot --nginx \
  -d editor.company.com \
  --non-interactive \
  --agree-tos \
  --email admin@company.com
```

Includes DNS resolution check before attempting certificate request.

### Deploy Command Options

| Option | Type | Description |
|--------|------|-------------|
| `--fqdn <fqdn>` | Required | Fully qualified domain name |
| `--name <name>` | Optional | Container name (default: `pdf-tei-editor-{fqdn}`) |
| `--tag <tag>` | Optional | Image tag (default: `latest`) |
| `--port <port>` | Optional | Host port (default: `8001`) |
| `--type <type>` | Optional | `production` or `demo` (default: `production`) |
| `--data-dir <dir>` | Optional | Persistent data directory (production only) |
| `--env <var>` | Multiple | Environment variables (`FOO` or `FOO=bar`) |
| `--no-nginx` | Flag | Skip nginx configuration |
| `--no-ssl` | Flag | Skip SSL certificate setup |
| `--email <email>` | Optional | Email for SSL certificate (default: `admin@<fqdn>`) |
| `--rebuild` | Flag | Rebuild image before deploying |
| `--no-cache` | Flag | Force rebuild all layers (use with `--rebuild`) |
| `--yes` | Flag | Skip confirmation prompt |

## Low-Level Container Commands

For reference, the actual Docker/Podman commands emitted by the deployment system:

### Build Image

```bash
# Executed by: npm run container:build -- --tag v1.0.0
podman build \
  --target production \
  -t pdf-tei-editor:v1.0.0 \
  -t pdf-tei-editor:latest \
  .
```

### Start Container (Basic)

```bash
# Executed by: npm run container:start -- --port 8080
podman run -d \
  --name pdf-tei-editor-latest \
  -p 8080:8000 \
  -e PORT=8000 \
  --restart unless-stopped \
  pdf-tei-editor:latest
```

### Start Container (Production)

```bash
# Executed by: npm run container:start -- --data-dir /opt/data --env GEMINI_API_KEY
podman run -d \
  --name pdf-tei-editor-latest \
  -p 8000:8000 \
  -e PORT=8000 \
  -e DATA_ROOT=/app/data \
  -e GEMINI_API_KEY=${GEMINI_API_KEY} \
  -v /opt/data:/app/data \
  --restart unless-stopped \
  pdf-tei-editor:latest
```

### Deploy Container (Full Stack)

```bash
# Executed by: sudo npm run deploy .env.deploy.example.org

# 1. Build image (if --rebuild)
podman build --target production -t pdf-tei-editor:latest .

# 2. Stop existing container
podman stop pdf-tei-editor-editor-company-com
podman rm pdf-tei-editor-editor-company-com

# 3. Start new container
podman run -d \
  --name pdf-tei-editor-editor-company-com \
  -p 8001:8000 \
  -e PORT=8000 \
  -e DATA_ROOT=/app/data \
  -e APP_ADMIN_PASSWORD=${APP_ADMIN_PASSWORD} \
  -e GEMINI_API_KEY=${GEMINI_API_KEY} \
  -e LOG_LEVEL=${LOG_LEVEL} \
  --restart unless-stopped \
  -v /opt/pdf-tei-editor/data:/app/data \
  pdf-tei-editor:latest

# 4. Configure nginx (writes /etc/nginx/sites-available/pdf-tei-editor-editor-company-com)
nginx -t
systemctl reload nginx

# 5. Setup SSL
certbot --nginx \
  -d editor.company.com \
  --non-interactive \
  --agree-tos \
  --email admin@company.com
```

### Manage Containers

```bash
# List containers
podman ps -a --filter "name=pdf-tei-editor"

# View logs
podman logs -f pdf-tei-editor-editor-company-com

# Stop container
podman stop pdf-tei-editor-editor-company-com

# Remove container
podman rm pdf-tei-editor-editor-company-com

# Inspect container
podman inspect pdf-tei-editor-editor-company-com
```

## Development Workflow

### Local Testing

```bash
# 1. Build and test locally
npm run container:build -- --tag dev-test

# 2. Test without deployment infrastructure
npm run container:start -- \
  --tag dev-test \
  --port 8080 \
  --no-detach  # Run in foreground for debugging

# 3. Test with deployment wrapper
npm run deploy .env.deploy.demo.localhost
```

### Production Release

```bash
# 1. Build production image
npm run container:build -- --tag v1.2.0

# 2. Tag for registry
podman tag pdf-tei-editor:v1.2.0 cboulanger/pdf-tei-editor:v1.2.0
podman tag pdf-tei-editor:v1.2.0 cboulanger/pdf-tei-editor:latest

# 3. Push to Docker Hub
npm run container:push -- --tag v1.2.0

# 4. Deploy to production
# Edit .env.deploy.production: DEPLOY_TAG=v1.2.0
sudo npm run deploy .env.deploy.production
```

## Implementation Notes

### Environment Variable Processing

**In `bin/deploy.js`:**

The `processEnvParameters()` function handles two formats:

- `--env FOO` → Transfers `FOO` from host environment to container
- `--env FOO=bar` → Sets `FOO=bar` in container

**In `bin/container.js`:**

The `startContainer()` function processes three environment variable sources:

1. Built-in: `PORT=8000` (always set)
2. Additional: `DATA_ROOT=/app/data` (when data directory mounted)
3. User-specified: From `--env` parameters

### Container Naming

Container names follow the pattern: `pdf-tei-editor-{sanitized-fqdn}`

Examples:

- `editor.company.com` → `pdf-tei-editor-editor-company-com`
- `localhost` → `pdf-tei-editor-localhost`
- `demo.example.org` → `pdf-tei-editor-demo-example-org`

### Data Directory Structure

When `--data-dir` is specified, the directory is mounted as `/app/data` and contains:

```text
/app/data/
├── files/          # Content-addressable file storage (SHA-256 hashes)
│   ├── ab/
│   │   └── cd12...  # PDF/XML files
│   └── ...
├── db/             # Application databases
│   ├── metadata.db # Main SQLite database
│   ├── users.json
│   ├── roles.json
│   └── config.json
└── versions/       # File version history
```

The environment variable `DATA_ROOT=/app/data` is automatically set when a data directory is mounted.

### Nginx Configuration

The generated nginx config includes:

1. **API endpoint handling** - Disables caching for `/api/` paths
2. **SSE support** - Extended timeouts for `/sse/` paths
3. **General proxy** - Standard reverse proxy for all other paths
4. **Security headers** - X-Forwarded-* headers for backend
5. **Upload limits** - 100MB max body size
6. **Timeouts** - 300s read/connect/send timeouts

See [nginx-cache-control.md](./nginx-cache-control.md) for caching implementation details.

### SSL Certificate Management

Let's Encrypt certificates:

- Automatically renewed by certbot
- Stored in `/etc/letsencrypt/live/{fqdn}/`
- Nginx automatically reloads on renewal
- DNS must resolve before certificate request

## Troubleshooting

### Build Failures

```bash
# Check Dockerfile syntax
docker build --target production -t test .

# Build with no cache
npm run container:build -- --no-cache

# Check for missing dependencies
npm run container:build -- --tag test 2>&1 | grep -i error
```

### Deployment Failures

```bash
# Check nginx configuration
sudo nginx -t

# Verify DNS resolution
nslookup editor.company.com

# Check certbot logs
sudo cat /var/log/letsencrypt/letsencrypt.log

# Test container startup manually
podman run --rm -it -p 8080:8000 pdf-tei-editor:latest
```

### Permission Issues

```bash
# Fix data directory ownership
sudo chown -R $(id -u):$(id -g) /opt/pdf-tei-editor/data

# Check SELinux contexts (if applicable)
ls -lZ /opt/pdf-tei-editor/data

# Add SELinux context
sudo chcon -R -t container_file_t /opt/pdf-tei-editor/data
```

## Related Documentation

- **User Manual:** [Docker Deployment Guide](../user-manual/docker-deployment.md) - Common deployment scenarios
- **Developer:** [Testing Guide](./testing.md) - Container testing
- **Developer:** [CI/CD Pipeline](../code-assistant/ci.md) - Automated builds
- **Reference:** [Nginx Cache Control](./nginx-cache-control.md) - API caching implementation
