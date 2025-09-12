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

## Related Documentation

- [Docker Testdrive Guide](testdrive-docker.md) - Detailed Docker configuration options
- [Installation Guide](installation.md) - Local development setup
- [User Management](user-management.md) - Managing users and authentication
