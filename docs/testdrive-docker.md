# Testdrive PDF TEI Editor with Docker

The fastest way to try PDF TEI Editor is using the pre-built Docker container. The container includes all dependencies and can be configured using environment variables.

## Quick Start

Pull and run the latest version:

```bash
# Basic usage - uses default demo accounts (admin/admin, demo/demo)
docker run -p 8000:8000 cboulanger/pdf-tei-editor:latest

# With custom admin password
docker run -p 8000:8000 -e APP_ADMIN_PASSWORD=mysecurepassword cboulanger/pdf-tei-editor:latest

# With both admin and demo users
docker run -p 8000:8000 \
  -e APP_ADMIN_PASSWORD=admin123 \
  -e APP_DEMO_PASSWORD=demo123 \
  cboulanger/pdf-tei-editor:latest

# With custom login message
docker run -p 8000:8000 \
  -e APP_LOGIN_MESSAGE="<strong>Welcome to Company PDF Editor</strong><br>Contact IT for credentials" \
  -e APP_ADMIN_PASSWORD=secure_password \
  cboulanger/pdf-tei-editor:latest
```

The application will be available at: <http://localhost:8000>, but no ai-powered extractors are enabled, for this, see below. 

## Configuration Options

### User Authentication

The container automatically configures user accounts based on environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `APP_ADMIN_PASSWORD` | Password for admin user (full access) | `admin` (if not set) |
| `APP_DEMO_PASSWORD` | Password for demo user (limited access) | `demo` (if not set) |
| `APP_LOGIN_MESSAGE` | Custom HTML message shown on login dialog | Demo warning (if defaults used) |

**Note**: When no custom passwords are provided, the container creates default demo accounts (`admin/admin` and `demo/demo`) with a security warning displayed on the login screen.

### AI Services (Optional)

Configure AI-powered features for reference extraction:

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Google Gemini API key for LLamore extraction | Disabled |
| `GROBID_SERVER_URL` | Grobid server URL for bibliographic parsing | `http://localhost:8070` |

### Server Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Internal server port | `8000` |

## Full Example with Docker Compose

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
      - APP_LOGIN_MESSAGE="<h3>PDF TEI Editor</h3><p>Contact administrator to create an account.</p>"
      - GEMINI_API_KEY=your_gemini_api_key_here
      - GROBID_SERVER_URL=https://example.com/grobid
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

## User Accounts

After starting the container:

### Admin User

- **Username**: `admin`
- **Password**: Value of `APP_ADMIN_PASSWORD` or `admin` if not set
- **Permissions**: Full access to all features

### Demo User

- **Username**: `demo`
- **Password**: Value of `APP_DEMO_PASSWORD` or `demo` if not set
- **Permissions**: Standard user access

## Persistent Data

To persist your data across container restarts, mount these directories:

```bash
docker run -p 8000:8000 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/db:/app/db \
  -e APP_ADMIN_PASSWORD=mysecurepassword \
  -e APP_DEMO_PASSWORD=mydemopassword \
  cboulanger/pdf-tei-editor:latest
```

### Data Directories

- **`/app/data`**: Uploaded PDFs, extracted TEI files, processed documents
- **`/app/db`**: Application database files

## Production Deployment

Example with nginx reverse proxy:

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

## Docker Hub Repository

The official Docker images are available at:
**https://hub.docker.com/r/cboulanger/pdf-tei-editor**

