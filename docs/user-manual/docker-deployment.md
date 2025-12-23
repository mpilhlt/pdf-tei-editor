# Docker Deployment Guide

This guide covers deploying PDF TEI Editor using Docker containers with the simplified deployment script.

## Quick Start

The easiest way to deploy PDF TEI Editor is using deployment configuration files:

```bash
# Local demo (no persistence, localhost only)
npm run deploy .env.deploy.demo.localhost

# Production deployment with SSL and persistent data
sudo npm run deploy .env.deploy.example.org
```

## Deployment Configuration Files

Deployment is configured using `.env` files that contain both deployment options (`DEPLOY_*`) and container environment variables.

### Demo Deployment (Local Testing)

Example: `.env.deploy.demo.localhost`

```bash
# Deployment Configuration
DEPLOY_FQDN=localhost          # Localhost = no nginx/SSL
DEPLOY_TYPE=demo               # Non-persistent storage
DEPLOY_PORT=8080               # Local port
DEPLOY_TAG=latest              # Image version
DEPLOY_YES=true                # Skip confirmation
DEPLOY_REBUILD=true            # Build image if needed

# Container Environment
LOG_LEVEL=INFO
# GEMINI_API_KEY=your-key-here
```

Run with:

```bash
npm run deploy .env.deploy.demo.localhost
```

Access at: **<http://localhost:8080>**

- Login: `admin` / `admin` or `demo` / `demo` (default passwords)
- Data: Non-persistent (resets on container restart)
- No SSL/nginx required

### Production Deployment

Example: `.env.deploy.example.org`

```bash
# Deployment Configuration
DEPLOY_FQDN=editor.company.com          # Your domain
DEPLOY_TYPE=production                  # Persistent storage
DEPLOY_DATA_DIR=/opt/pdf-tei-editor/data  # Data directory
DEPLOY_PORT=8001                        # Internal port
DEPLOY_TAG=latest                       # Image version
DEPLOY_EMAIL=admin@company.com          # For SSL cert

# User Account Setup (REQUIRED FOR PRODUCTION)
APP_ADMIN_PASSWORD=secure-admin-password
APP_DEMO_PASSWORD=secure-demo-password

# Container Environment
LOG_LEVEL=WARNING
GEMINI_API_KEY=your-gemini-api-key
GROBID_SERVER_URL=https://cloud.science-miner.com/grobid
```

Run with:

```bash
sudo npm run deploy .env.deploy.example.org
```

**What happens:**

1. Checks DNS resolution for the domain
2. Builds image if needed (with `--rebuild` option)
3. Starts container with persistent data directory
4. Configures nginx reverse proxy
5. Sets up SSL certificate with Let's Encrypt (requires sudo)

Access at: **<https://editor.company.com>**

## Configuration Variables

### Deployment Options (DEPLOY_*)

These variables control how the container is deployed:

| Variable | Description | Example |
|----------|-------------|---------|
| `DEPLOY_FQDN` | Fully qualified domain name | `editor.company.com` or `localhost` |
| `DEPLOY_TYPE` | Deployment type | `production` or `demo` |
| `DEPLOY_DATA_DIR` | Persistent data directory (production only) | `/opt/pdf-tei-editor/data` |
| `DEPLOY_PORT` | Host port binding | `8001` (default for deploy) |
| `DEPLOY_TAG` | Container image tag | `latest`, `v1.0.0` |
| `DEPLOY_EMAIL` | Email for SSL certificate | `admin@company.com` |
| `DEPLOY_YES` | Skip confirmation prompt | `true` or `false` |
| `DEPLOY_REBUILD` | Rebuild image before deploy | `true` or `false` |
| `DEPLOY_NO_CACHE` | Force rebuild all layers | `true` or `false` |

**Special values:**

- `DEPLOY_FQDN=localhost` or `127.0.0.1` → Automatically skips nginx/SSL (no sudo needed)
- No `DEPLOY_FQDN` → Automatically adds `--no-nginx --no-ssl`

### Container Environment Variables

These variables are passed to the running container:

#### Authentication (Production Required)

| Variable | Description | Default |
|----------|-------------|---------|
| `APP_ADMIN_PASSWORD` | Admin user password | `admin` (demo only) |
| `APP_DEMO_PASSWORD` | Demo user password | `demo` (demo only) |
| `APP_LOGIN_MESSAGE` | Custom HTML login message | Security warning |

**Default accounts:**

- Admin: `admin` / `APP_ADMIN_PASSWORD` (full access)
- Demo: `demo` / `APP_DEMO_PASSWORD` (user, annotator, reviewer)

#### AI/ML Services (Optional)

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key for AI extraction |
| `GROBID_SERVER_URL` | GROBID server for bibliographic parsing |
| `KISSKI_API_KEY` | KISSKI Academic Cloud API key |

#### Application Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging level | `INFO` |
| `LOG_CATEGORIES` | Log categories | `app,api,plugins` |
| `DOCS_FROM_GITHUB` | Load docs from GitHub | `false` |
| `WEBDAV_ENABLED` | Enable WebDAV integration | `false` |
| `WEBDAV_BASE_URL` | WebDAV server URL | - |

See `.env.production` for complete list.

## Data Persistence

### Demo Deployments

- Use container-internal storage
- Data is **lost** when container is removed
- Ideal for testing and demonstrations

### Production Deployments

Data persists in the mounted `DEPLOY_DATA_DIR` directory:

```text
/opt/pdf-tei-editor/data/
├── files/          # PDF and XML files (content-addressable)
├── db/             # SQLite databases and JSON configs
│   ├── metadata.db
│   ├── users.json
│   └── roles.json
└── versions/       # File version history
```

**Backup:**

```bash
# Stop container
npm run container:stop -- --name pdf-tei-editor-editor-company-com

# Backup data
tar -czf backup-$(date +%Y%m%d).tar.gz /opt/pdf-tei-editor/data

# Restart container
npm run deploy .env.deploy.example.org
```

## Security

### Production Checklist

- ✅ Set `APP_ADMIN_PASSWORD` and `APP_DEMO_PASSWORD`
- ✅ Use HTTPS with valid SSL certificate
- ✅ Set `LOG_LEVEL=WARNING` or `ERROR`
- ✅ Secure the data directory with proper file permissions
- ✅ Keep API keys in environment variables, not config files
- ✅ Use firewall rules to limit access

### Password Generation

```bash
# Generate secure passwords
ADMIN_PASSWORD=$(openssl rand -base64 16)
DEMO_PASSWORD=$(openssl rand -base64 16)

# Add to deployment config
echo "APP_ADMIN_PASSWORD=$ADMIN_PASSWORD" >> .env.deploy.mysite
echo "APP_DEMO_PASSWORD=$DEMO_PASSWORD" >> .env.deploy.mysite
```

## Common Scenarios

### Local Testing

```bash
# Quick demo on localhost
npm run deploy .env.deploy.demo.localhost
```

### Production Server

```bash
# Create production config
cp .env.deploy.example.org .env.deploy.mycompany

# Edit configuration
nano .env.deploy.mycompany

# Deploy with SSL
sudo npm run deploy .env.deploy.mycompany
```

### Updates and Maintenance

```bash
# Update to new version
# Edit .env file: DEPLOY_TAG=v2.0.0
sudo npm run deploy .env.deploy.mycompany

# View logs
npm run container:logs -- --name pdf-tei-editor-editor-company-com --follow

# Stop container
npm run container:stop -- --name pdf-tei-editor-editor-company-com
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
npm run container:logs -- --name pdf-tei-editor-localhost

# Verify image exists
docker images | grep pdf-tei-editor
# or
podman images | grep pdf-tei-editor
```

### Port Already in Use

```bash
# Check what's using the port
lsof -i :8080

# Or use different port in config
# Edit .env file: DEPLOY_PORT=8081
```

### SSL Certificate Issues

```bash
# Check DNS resolution
nslookup editor.company.com

# Test nginx configuration
sudo nginx -t

# Renew certificate manually
sudo certbot renew
```

### Permission Issues

```bash
# Fix data directory ownership
sudo chown -R $(id -u):$(id -g) /opt/pdf-tei-editor/data

# Fix permissions
chmod -R 755 /opt/pdf-tei-editor/data
```

## Advanced: Direct Docker Commands

For users who prefer Docker/Podman directly without the deployment script:

### Basic Run

```bash
docker run -p 8000:8000 \
  -e APP_ADMIN_PASSWORD=secure_password \
  cboulanger/pdf-tei-editor:latest
```

### With Persistent Data

```bash
docker run -p 8000:8000 \
  -v /opt/pdf-tei-editor/data:/app/data \
  -e APP_ADMIN_PASSWORD=secure_password \
  -e GEMINI_API_KEY=your_key \
  cboulanger/pdf-tei-editor:latest
```

### Docker Compose

Create `docker-compose.yml`:

```yaml
version: '3.8'
services:
  pdf-tei-editor:
    image: cboulanger/pdf-tei-editor:latest
    ports:
      - "8000:8000"
    environment:
      - APP_ADMIN_PASSWORD=secure_admin_password
      - APP_DEMO_PASSWORD=demo_password
      - GEMINI_API_KEY=your_gemini_api_key
    volumes:
      - pdf_data:/app/data

volumes:
  pdf_data:
```

Run with: `docker-compose up -d`

**For more details on the deployment script implementation:** See the [Developer Deployment Guide](../development/deployment.md)
