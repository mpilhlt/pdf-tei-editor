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

### Universal Deployment Script

Use `bin/deploy-container.sh` for all deployment scenarios:

```bash
# Production deployment with persistent volumes
sudo bin/deploy-container.sh \
  --image cboulanger/pdf-tei-editor:latest \
  --fqdn editor.company.com \
  --type production \
  --admin-password secure_password \
  --data-dir /opt/pdf-data \
  --config-dir /opt/pdf-config \
  --db-dir /opt/pdf-db

# Demo deployment (non-persistent)
sudo bin/deploy-container.sh \
  --image cboulanger/pdf-tei-editor:latest \
  --fqdn demo.example.com \
  --type demo \
  --admin-password demo123

# Local testing without SSL
bin/deploy-container.sh \
  --image pdf-tei-editor:dev \
  --fqdn localhost \
  --port 8080 \
  --no-ssl \
  --no-nginx \
  --admin-password admin
```

### Demo Auto-Reset

Set up nightly demo resets for a public instance that can serve as a playground:

```bash
# Setup nightly reset at 2 AM
bin/setup-cron.sh \
  --image cboulanger/pdf-tei-editor:latest \
  --fqdn demo.example.com

# Custom schedule and passwords
bin/setup-cron.sh \
  --image pdf-tei-editor:latest \
  --fqdn demo.example.com \
  --time "0 3 * * *" \
  --admin-password mypassword
```

## Production Deployment

### Local Production Server

For non-containerized production deployments:

```bash
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

2. **Configure environment variables** in `.env`:

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

3. **Set up reverse proxy** (nginx example):

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

### Container Production Deployment

For production container deployments with persistent data:

```bash
# Deploy with external volumes for data persistence
sudo bin/deploy-container.sh \
  --image cboulanger/pdf-tei-editor:latest \
  --fqdn editor.company.com \
  --type production \
  --admin-password "$(openssl rand -base64 12)" \
  --demo-password "$(openssl rand -base64 12)" \
  --data-dir /opt/pdf-tei-editor/data \
  --config-dir /opt/pdf-tei-editor/config \
  --db-dir /opt/pdf-tei-editor/db \
  --gemini-key "$GEMINI_API_KEY"
```

## Development Workflow

### Build and Test Locally

```bash
# 1. Build image locally for testing
bin/image-build-and-push.js --build-only v1.0.0

# 2. Test locally without SSL/nginx
bin/deploy-container.sh \
  --image pdf-tei-editor:v1.0.0 \
  --fqdn localhost \
  --port 8080 \
  --no-ssl \
  --no-nginx \
  --admin-password admin

# 3. Push to registry when ready
bin/image-build-and-push.js v1.0.0
```

### Container Updates

```bash
# Production: Update while preserving data
sudo bin/deploy-container.sh \
  --image cboulanger/pdf-tei-editor:v2.0.0 \
  --fqdn editor.company.com \
  --type production \
  --admin-password existing_password \
  --data-dir /opt/pdf-tei-editor/data \
  --config-dir /opt/pdf-tei-editor/config \
  --db-dir /opt/pdf-tei-editor/db

# Demo: Simple redeployment (data is reset)
sudo bin/deploy-container.sh \
  --image cboulanger/pdf-tei-editor:v2.0.0 \
  --fqdn demo.example.com \
  --type demo
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
# Generate secure passwords
ADMIN_PASSWORD=$(openssl rand -base64 16)
DEMO_PASSWORD=$(openssl rand -base64 16)

# Use secure deployment
sudo bin/deploy-container.sh \
  --image cboulanger/pdf-tei-editor:latest \
  --fqdn secure.company.com \
  --type production \
  --admin-password "$ADMIN_PASSWORD" \
  --demo-password "$DEMO_PASSWORD" \
  --data-dir /secure/pte-data \
  --config-dir /secure/pte-config \
  --db-dir /secure/pte-db
```

## Monitoring and Maintenance

### Container Management

```bash
# View logs
podman logs -f pdf-tei-editor-your-domain-com

# Monitor container status
podman ps

# Update container
sudo bin/deploy-container.sh \
  --image cboulanger/pdf-tei-editor:latest \
  --fqdn your-domain.com \
  --type production \
  [... same parameters as initial deployment]
```

### Backup and Recovery

```bash
# Backup persistent data (production deployments)
tar -czf backup-$(date +%Y%m%d).tar.gz \
  /opt/pdf-tei-editor/data \
  /opt/pdf-tei-editor/config \
  /opt/pdf-tei-editor/db

# Restore data
tar -xzf backup-20241201.tar.gz -C /
```

### Demo Management

```bash
# View reset logs
tail -f /var/log/pdf-tei-editor-reset.log

# Manual demo reset
sudo bin/deploy-container.sh \
  --image cboulanger/pdf-tei-editor:latest \
  --fqdn demo.example.com \
  --type demo

# Remove scheduled reset
crontab -l | grep -v 'deploy-container.sh.*--fqdn demo.example.com' | crontab -
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
