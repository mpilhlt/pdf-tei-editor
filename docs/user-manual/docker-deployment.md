# Docker Deployment Guide

This guide covers deploying PDF TEI Editor using Docker containers for production and testing.

## Quick Start

For a quick test, see the [Testdrive Guide](testdrive-docker.md).

## Docker Hub

Official images: **<https://hub.docker.com/r/cboulanger/pdf-tei-editor>**

## Configuration

### Environment Variables

Configure the container using environment variables:

#### Authentication

| Variable | Description | Default |
|----------|-------------|---------|
| `APP_ADMIN_PASSWORD` | Password for admin user | `admin` (demo mode) |
| `APP_DEMO_PASSWORD` | Password for demo user | `demo` (demo mode) |
| `APP_LOGIN_MESSAGE` | Custom HTML message on login dialog | Security warning if defaults used |

#### AI Services (Optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Google Gemini API key for AI extraction | Disabled |
| `GROBID_SERVER_URL` | Grobid server URL for bibliographic parsing | `http://localhost:8070` |

#### Data Import

| Variable | Description | Default |
|----------|-------------|---------|
| `IMPORT_DATA_PATH` | Path to import PDF/XML files from on startup | `docker/demo-data` |

#### Server

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Internal server port | `8000` |

## Basic Usage

### With Custom Passwords

```bash
docker run -p 8000:8000 \
  -e APP_ADMIN_PASSWORD=secure_password \
  -e APP_DEMO_PASSWORD=demo_password \
  cboulanger/pdf-tei-editor:latest
```

### With AI Services

```bash
docker run -p 8000:8000 \
  -e APP_ADMIN_PASSWORD=secure_password \
  -e GEMINI_API_KEY=your_api_key \
  -e GROBID_SERVER_URL=https://cloud.science-miner.com/grobid \
  cboulanger/pdf-tei-editor:latest
```

### With Custom Login Message

```bash
docker run -p 8000:8000 \
  -e APP_ADMIN_PASSWORD=secure_password \
  -e APP_LOGIN_MESSAGE="<h3>Company PDF Editor</h3><p>Contact IT for credentials</p>" \
  cboulanger/pdf-tei-editor:latest
```

## Production Deployment

### Persistent Data

Mount volumes to preserve data across container restarts:

```bash
docker run -p 8000:8000 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/config:/app/config \
  -e APP_ADMIN_PASSWORD=secure_password \
  cboulanger/pdf-tei-editor:latest
```

#### Data Directories

The application uses a consolidated data directory structure:

- `/app/data/` - Main data directory containing:
  - `/app/data/files/` - Content-addressable file storage (PDFs, XMLs)
  - `/app/data/db/` - Application databases (metadata.db, users.json, roles.json)
  - `/app/data/versions/` - File version history
- `/app/config/` - Application configuration files

**Recommended:** Mount only `/app/data` and `/app/config` for simplified backup and management.

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
      - GROBID_SERVER_URL=https://cloud.science-miner.com/grobid
    volumes:
      - pdf_data:/app/data
      - pdf_config:/app/config

volumes:
  pdf_data:
  pdf_config:
```

Run with:

```bash
docker-compose up -d
```

### Reverse Proxy (nginx)

Example nginx configuration for production:

```nginx
server {
    listen 443 ssl;
    server_name editor.example.com;

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

## Importing Custom Data

### At Container Startup

Mount a directory with your PDF and XML files and set `IMPORT_DATA_PATH`:

```bash
docker run -p 8000:8000 \
  -v $(pwd)/my-documents:/app/my-data:ro \
  -e IMPORT_DATA_PATH=my-data \
  -e APP_ADMIN_PASSWORD=secure_password \
  cboulanger/pdf-tei-editor:latest
```

The container will import all PDF and XML files from the mounted directory on startup.

### Directory Structure

The import script automatically assigns collections based on top-level subdirectories:

```
my-documents/
├── collection1/
│   ├── document1.pdf
│   └── document1.xml
├── collection2/
│   ├── pdf/
│   │   └── document2.pdf
│   └── tei/
│   │   └── document2.xml
└── document3.pdf          # Files in root have no collection
```

- Files in `collection1/` → imported to "collection1" collection
- Files in `collection2/pdf/` → imported to "collection2" collection (skips "pdf" directory)
- Files in `collection2/tei/` → imported to "collection2" collection (skips "tei" directory)
- Files in root → no collection assigned

**Note:** Organizational directories (`pdf`, `tei`, `versions`, `version`) are automatically skipped when determining the collection name.

## User Accounts

After starting the container:

### Admin User

- **Username**: `admin`
- **Password**: Value of `APP_ADMIN_PASSWORD` (or `admin` if not set)
- **Permissions**: Full access to all features

### Demo User

- **Username**: `demo`
- **Password**: Value of `APP_DEMO_PASSWORD` (or `demo` if not set)
- **Permissions**: Standard user access (annotator, reviewer)

### Additional Users

Create additional users by accessing the container:

```bash
# Using docker exec
docker exec -it <container_id> /bin/bash
.venv/bin/python bin/manage.py user add username \
  --password password \
  --fullname "Full Name" \
  --roles "user,annotator" \
  --email user@example.com
```

## Security

### Default Accounts

When no passwords are configured, the container creates default demo accounts (`admin/admin` and `demo/demo`) with a security warning. **Always set custom passwords for production.**

### Secure Password Generation

```bash
# Generate secure passwords
ADMIN_PASSWORD=$(openssl rand -base64 16)
DEMO_PASSWORD=$(openssl rand -base64 16)

# Use in deployment
docker run -p 8000:8000 \
  -e APP_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -e APP_DEMO_PASSWORD="$DEMO_PASSWORD" \
  cboulanger/pdf-tei-editor:latest
```

### HTTPS

Always use HTTPS in production via a reverse proxy (nginx, Apache, Caddy, etc.).

## Monitoring

### View Logs

```bash
docker logs -f <container_id>
```

### Container Status

```bash
docker ps
```

## Backup and Recovery

### Backup Data

```bash
# Stop container
docker stop <container_id>

# Backup data directory (contains files, db, and versions)
tar -czf backup-$(date +%Y%m%d).tar.gz \
  ./data \
  ./config

# Restart container
docker start <container_id>
```

### Restore Data

```bash
# Stop container
docker stop <container_id>

# Restore files
tar -xzf backup-20241201.tar.gz

# Start container
docker start <container_id>
```

## Troubleshooting

### Port Already in Use

```bash
# Check what's using port 8000
lsof -i :8000

# Or use a different port
docker run -p 8080:8000 cboulanger/pdf-tei-editor:latest
```

### Container Won't Start

```bash
# Check logs
docker logs <container_id>

# Check if image exists
docker images | grep pdf-tei-editor
```

### Permission Issues

Ensure mounted volumes have correct permissions:

```bash
# Fix ownership
sudo chown -R $(id -u):$(id -g) ./data ./config
```
