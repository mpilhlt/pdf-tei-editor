# Docker Deployment

This guide covers containerized deployment options for the PDF-TEI Editor, from simple Docker runs to production deployments with automatic SSL and nightly resets.

## Quick Start

The fastest way to try PDF TEI Editor:

```bash
# Run with Docker (includes all dependencies)
docker run -p 8000:8000 -e APP_ADMIN_PASSWORD=admin123 cboulanger/pdf-tei-editor:latest
```

Then visit: **<http://localhost:8000>**

- Login: `admin` / `admin123`

For detailed configuration options, see the [Docker Testdrive Guide](testdrive-docker.md).

## Docker Image

The official Docker images are available at:
**<https://hub.docker.com/r/cboulanger/pdf-tei-editor>**

### Available Tags

| Tag | Description |
|-----|-------------|
| `latest` | Latest stable version from main branch |
| `v1.x.x` | Specific version releases |
| `branch-hash` | Development builds from feature branches |

## Environment Variables

Configure the container using environment variables:

### User Authentication

| Variable | Description | Default |
|----------|-------------|---------|
| `APP_ADMIN_PASSWORD` | Password for admin user (full access) | `admin` |
| `APP_DEMO_PASSWORD` | Password for demo user (limited access) | Not created if not set |

### AI Services (Optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Google Gemini API key for LLamore extraction | Disabled |
| `GROBID_SERVER_URL` | Grobid server URL for bibliographic parsing | `http://localhost:8070` |

### Server Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Internal server port | `8000` |

## Basic Deployment

### Simple Docker Run

```bash
# Basic usage with custom admin password
docker run -p 8000:8000 \
  -e APP_ADMIN_PASSWORD=mysecurepassword \
  cboulanger/pdf-tei-editor:latest

# With both admin and demo users
docker run -p 8000:8000 \
  -e APP_ADMIN_PASSWORD=admin123 \
  -e APP_DEMO_PASSWORD=demo123 \
  cboulanger/pdf-tei-editor:latest
```

### Docker Compose

Create a `docker-compose.yml` file:

```yaml
version: '3.8'
services:
  pdf-tei-editor:
    image: cboulanger/pdf-tei-editor:latest
    ports:
      - "8000:8000"
    environment:
      - APP_ADMIN_PASSWORD=secure_admin_password
      - APP_DEMO_PASSWORD=demo123
      - GEMINI_API_KEY=your_gemini_api_key_here
      - GROBID_SERVER_URL=https://cloud.science-miner.com/grobid
    volumes:
      - pdf_data:/app/data
      - pdf_config:/app/config
      - pdf_db:/app/db

volumes:
  pdf_data:
  pdf_config:
  pdf_db:
```

Run with:

```bash
docker-compose up -d
```

## Production Deployment

### Persistent Data

To persist data across container restarts, mount these directories:

```bash
docker run -p 8000:8000 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/db:/app/db \
  -e APP_ADMIN_PASSWORD=mysecurepassword \
  cboulanger/pdf-tei-editor:latest
```

### Data Directories

- **`/app/data`**: Uploaded PDFs, extracted TEI files, processed documents
- **`/app/config`**: Application configuration files, prompts, settings
- **`/app/db`**: User accounts, sessions, application metadata

### Reverse Proxy with SSL

For production use, deploy behind a reverse proxy with SSL termination:

```bash
# Deploy with Docker
./bin/start-docker-image.sh your-domain.com 8001

# Enable nginx configuration
sudo ln -sf /etc/nginx/sites-available/pdf-tei-editor-your-domain.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Add SSL certificate
sudo certbot --nginx -d your-domain.com
```

Example nginx configuration:

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

The Docker container runs the waitress server on the specified port while nginx on the host handles SSL termination and reverse proxying. Application data persists in Docker volumes across container restarts.

## Interactive Demo Setup

For a complete demo deployment with automatic configuration:

```bash
# Run interactive setup (prompts for domain, SSL, admin password, API keys)
sudo ./docker/setup-demo.sh
```

This script will:

- Configure nginx with SSL certificates via Let's Encrypt
- Set up persistent data directories per domain in `/opt/pdf-tei-editor-data/$FQDN/`
- Create admin user with specified password
- Configure API keys for LLamore (Gemini) and Grobid services
- Deploy the application with production settings

**Data Persistence:**

- Initial configuration: `/opt/pdf-tei-editor-data/$FQDN/config/` - Production settings
- Application configuration database: `/opt/pdf-tei-editor-data/$FQDN/db/` - Live configuration values, user accounts and other metadata
- File Data: `/opt/pdf-tei-editor-data/$FQDN/data/` - Uploaded PDFs and TEI files
- Environment: `/opt/pdf-tei-editor-data/$FQDN/.env` - API keys and service configuration

## Demo Sandbox with Nightly Reset

For demo/sandbox environments that reset automatically:

```bash
# Interactively set up the demo instance
sudo ./docker/setup-demo.sh

# Configure nightly reset (run once)
./docker/setup-cron.sh <FQDN> <PORT> "$(realpath .)"
```

The nightly reset (2 AM daily):

- Preserves user accounts, passwords, configuration, API keys
- Resets file data (uploaded PDFs, processed TEI files) by restoring the sample data from repository
- Updates application code from latest GitHub version

This creates a sandbox environment where users can experiment freely, knowing their accounts persist but the file workspace resets to a clean state each night.

## Building Custom Images

To build your own images:

```bash
# Build locally
docker build -t my-pdf-tei-editor .

# Build and push to Docker Hub
./docker/build-and-push.sh
```

The build script supports both Docker and Podman with auto-detection and includes git-based versioning.

## User Accounts

After starting the container:

### Admin User

- **Username**: `admin`
- **Password**: Value of `APP_ADMIN_PASSWORD` or `admin` if not set
- **Permissions**: Full access to all features, user management, configuration

### Demo User (Optional)

- **Username**: `demo`
- **Password**: Value of `APP_DEMO_PASSWORD`
- **Permissions**: Standard user access, cannot manage other users
- **Created only if**: `APP_DEMO_PASSWORD` environment variable is set

## Production Security Considerations

1. **Use HTTPS**: Deploy behind a reverse proxy (nginx, Traefik) with SSL
2. **Persistent Volumes**: Mount data directories to preserve work
3. **Backup Strategy**: Regularly backup the `/app/db` and `/app/data` directories
4. **Security**: Use strong passwords and restrict network access
5. **Resource Limits**: Set appropriate CPU/memory limits

## Troubleshooting

### Container Won't Start

- Check if port 8000 is available: `lsof -i :8000`
- Verify environment variables are set correctly
- Check container logs: `docker logs <container_name>`

### Cannot Login

- Verify `APP_ADMIN_PASSWORD` was set when starting container
- Try restarting container with a new password
- Check logs for user creation messages

### AI Features Not Working

- Verify `GEMINI_API_KEY` is valid and has quota
- Check if `GROBID_SERVER_URL` is accessible
- Look for API error messages in container logs

## Related Documentation

- [Docker Testdrive Guide](testdrive-docker.md) - Detailed Docker configuration options
- [Installation Guide](installation.md) - Local development setup
- [User Management](user-management.md) - Managing users and authentication
