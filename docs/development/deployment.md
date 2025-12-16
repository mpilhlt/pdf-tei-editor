# Deployment Guide

This guide covers all deployment options for the PDF TEI Editor, from Docker containers to production servers.

## Quick Start with Docker

**The fastest way to try PDF TEI Editor:**

```bash
# Run with Docker (includes all dependencies)
docker run -p 8000:8000 -e APP_ADMIN_PASSWORD=admin123 cboulanger/pdf-tei-editor:latest
```

Then visit: **<http://localhost:8000>**

- Login: `admin` / `admin123`

**For detailed Docker setup and configuration options:** [**→ Docker Testdrive Guide**](testdrive-docker.md)

## Container Deployment with Scripts

The repository includes streamlined deployment scripts for production and demo scenarios.

### Container Management Script

Use `npm run container:deploy -- [options]` or `bin/container.js deploy [options]` for all container operations including deployment:

```bash
# Production deployment with persistent data directory
sudo npm run container:deploy -- \
  --fqdn editor.company.com \
  --data-dir /opt/pdf-tei-editor/data \
  --env GEMINI_API_KEY=your-key \
  --env LOG_LEVEL=WARNING

# Demo deployment (non-persistent, data resets on restart)
sudo npm run container:deploy -- \
  --fqdn demo.example.com \
  --type demo

# Local testing without SSL/nginx (no sudo needed)
npm run container:deploy -- \
  --fqdn localhost \
  --port 8080 \
  --no-ssl \
  --no-nginx

# With custom tag and environment variables
sudo npm run container:deploy -- \
  --fqdn editor.company.com \
  --tag v1.0.0 \
  --data-dir /opt/pdf-tei-editor/data \
  --env GEMINI_API_KEY \
  --env GROBID_SERVER_URL=https://cloud.science-miner.com/grobid

# Automated deployment (skip confirmation, for CI/CD)
sudo npm run container:deploy -- \
  --fqdn editor.company.com \
  --data-dir /opt/pdf-tei-editor/data \
  --env GEMINI_API_KEY=your-key \
  --yes
```

**Available environment variables** (see `.env.production` for complete list):
- `GEMINI_API_KEY` - Google Gemini API key for AI features
- `GROBID_SERVER_URL` - GROBID server URL for PDF processing
- `KISSKI_API_KEY` - KISSKI Academic Cloud API key
- `LOG_LEVEL` - Logging level (DEBUG, INFO, WARNING, ERROR)
- `WEBDAV_ENABLED` - Enable WebDAV filesystem integration
- `DOCS_FROM_GITHUB` - Load documentation from GitHub

**Environment variable syntax:**
- `--env FOO` - Transfer FOO from host environment to container
- `--env FOO=bar` - Set FOO to "bar" in container

## Production Deployment

### Local Production Server

For non-containerized production deployments:

```bash
# Configure environment for production
cp .env.production .env

# Start production server
npm run start:prod

# Or directly with specific host/port
./bin/start-prod 0.0.0.0 3001
```


### Production Configuration

1. **Set production mode** in `config/config.json`:

   ```json
   {
     "application": {
       "mode": "production"
     }
   }
   ```

2. **Enable GitHub documentation** (optional but recommended):

   By default, the application serves documentation from local files bundled with the code. For production deployments, you can enable loading documentation directly from GitHub, which allows users to see updated documentation without rebuilding or redeploying the application.

   Set the environment variable in `.env`:

   ```bash
   DOCS_FROM_GITHUB=true
   ```

   This fetches documentation from the GitHub repository tag matching your application version (e.g., `v0.1.0`). The application automatically falls back to local documentation if GitHub is unreachable.

   **Benefits:**
   - Documentation updates are immediately available without redeployment
   - Useful for long-running production instances
   - Reduces time between documentation improvements and user visibility

3. **Configure environment variables** in `.env` (copy from `.env.production`):

   ```bash
   GEMINI_API_KEY=your_gemini_api_key_here
   GROBID_SERVER_URL=https://cloud.science-miner.com/grobid

   # Optional: Docker Hub credentials for image pushing
   DOCKER_HUB_USERNAME=your_username
   DOCKER_HUB_TOKEN=your_access_token

   # Optional: Custom login message with HTML support
   APP_LOGIN_MESSAGE="<strong>Welcome!</strong> This is a demo instance."

   # Optional: Admin and demo user passwords
   APP_ADMIN_PASSWORD=secure_admin_password
   APP_DEMO_PASSWORD=demo_user_password
   ```

4. **Set up reverse proxy** (nginx example):

   ```nginx
   server {
       listen 443 ssl;
       server_name your-domain.com;

       ssl_certificate /path/to/cert.pem;
       ssl_certificate_key /path/to/key.pem;

       location / {
           proxy_pass http://127.0.0.1:3001;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto https;
       }
   }
   ```
This is automatically done buy the `npm run container:deploy` command documented in the next section.

### Container Production Deployment

For production container deployments with persistent data:

```bash
# Deploy with external data directory for persistence
# Note: data-dir contains files/ and db/ subdirectories
sudo npm run container:deploy -- \
  --fqdn editor.company.com \
  --type production \
  --data-dir /opt/pdf-tei-editor/data \
  --env GEMINI_API_KEY \
  --env GROBID_SERVER_URL \
  --env LOG_LEVEL=WARNING

# The deploy command will:
# - Check DNS resolution for the FQDN
# - Start the container with the specified data directory
# - Configure nginx as reverse proxy
# - Set up SSL certificate with Let's Encrypt
```

**Data directory structure:**
```
/opt/pdf-tei-editor/data/
├── files/          # User-uploaded PDF and TEI files
└── db/             # SQLite databases (metadata, users, etc.)
```

## Development Workflow

### Build and Test Locally

```bash
# 1. Build image locally for testing
npm run container:build -- --tag v1.0.0

# 2. Test locally without SSL/nginx
npm run container:start -- \
  --tag v1.0.0 \
  --port 8080 \
  --env GEMINI_API_KEY

# 3. Push to registry when ready (requires DOCKER_HUB_USERNAME and DOCKER_HUB_TOKEN in .env)
npm run container:push -- --tag v1.0.0
```

### Container Updates

```bash
# Production: Update while preserving data
sudo npm run container:deploy -- \
  --fqdn editor.company.com \
  --tag v2.0.0 \
  --type production \
  --data-dir /opt/pdf-tei-editor/data \
  --env GEMINI_API_KEY \
  --env LOG_LEVEL=WARNING

# Demo: Simple redeployment (data is reset)
sudo npm run container:deploy -- \
  --fqdn demo.example.com \
  --tag v2.0.0 \
  --type demo

# Stop a container
npm run container:stop -- --name pdf-tei-editor-latest

# Restart with rebuild
npm run container:restart -- \
  --name pdf-tei-editor-latest \
  --rebuild
```

## Security Considerations

### Application Security

- **Production mode**: Set `"application.mode": "production"` in `config/config.json` to disable access to development files (`/src/` and `/node_modules/`)
- **File upload validation**: Uses libmagic package to prevent malicious file content
- **HTTPS middleware**: Proper handling of X-Forwarded-Proto headers from reverse proxies
- **User authentication**: Secure password hashing with configurable user roles

### Container Security

- **Non-root user**: Container runs as unprivileged user
- **Minimal image**: Multi-stage build removes development dependencies
- **Environment isolation**: Uses environment variables for sensitive configuration
- **Network security**: Only exposes required ports

### Deployment Security

```bash
# Set environment variables for deployment
export GEMINI_API_KEY="your-secure-api-key"
export LOG_LEVEL="WARNING"

# Deploy with environment variables
sudo npm run container:deploy -- \
  --fqdn secure.company.com \
  --type production \
  --data-dir /secure/pdf-tei-editor/data \
  --env GEMINI_API_KEY \
  --env LOG_LEVEL

# Or specify values directly (less secure - visible in process list)
sudo npm run container:deploy -- \
  --fqdn secure.company.com \
  --type production \
  --data-dir /secure/pdf-tei-editor/data \
  --env GEMINI_API_KEY=your-key \
  --env LOG_LEVEL=WARNING
```

## Monitoring and Maintenance

### Container Management

```bash
# View logs (container name format: pdf-tei-editor-{fqdn-with-dashes})
docker logs -f pdf-tei-editor-editor-company-com
# or
podman logs -f pdf-tei-editor-editor-company-com

# Monitor container status
docker ps
# or
podman ps

# Update container (redeploy with new tag)
sudo npm run container:deploy -- \
  --fqdn your-domain.com \
  --tag latest \
  --type production \
  --data-dir /opt/pdf-tei-editor/data \
  --env GEMINI_API_KEY \
  --env LOG_LEVEL=WARNING

# Stop all containers
npm run container:stop -- --all

# Stop specific container
npm run container:stop -- --name pdf-tei-editor-editor-company-com --remove
```

### Backup and Recovery

```bash
# Backup persistent data directory (production deployments)
tar -czf backup-$(date +%Y%m%d).tar.gz \
  /opt/pdf-tei-editor/data

# Restore data
tar -xzf backup-20241201.tar.gz -C /opt/pdf-tei-editor/

# The data directory contains:
# - files/: All uploaded PDF and TEI files
# - db/: SQLite databases (metadata.db, users.json, etc.)
```


## Troubleshooting

### Common Issues

**Container won't start:**

```bash
# Check if port is available
lsof -i :8000

# Check container logs
podman logs container-name

# Verify image exists
podman images
```

**SSL certificate issues:**

```bash
# Test nginx configuration
nginx -t

# Renew certificates manually
certbot renew

# Check certificate status
certbot certificates
```

**Permission issues:**

```bash
# Fix ownership of persistent directories
sudo chown -R $(id -u):$(id -g) /opt/pdf-tei-editor/
```
