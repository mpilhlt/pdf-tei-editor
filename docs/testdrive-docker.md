# Testdrive PDF TEI Editor with Docker

The fastest way to try PDF TEI Editor is using the pre-built Docker container. The container includes all dependencies and can be configured using environment variables.

## Quick Start

Pull and run the latest version:

```bash
# Basic usage - uses default passwords
docker run -p 8000:8000 cboulanger/pdf-tei-editor:latest

# With custom admin password
docker run -p 8000:8000 -e APP_ADMIN_PASSWORD=mysecurepassword cboulanger/pdf-tei-editor:latest

# With both admin and demo users
docker run -p 8000:8000 \
  -e APP_ADMIN_PASSWORD=admin123 \
  -e APP_DEMO_PASSWORD=demo123 \
  cboulanger/pdf-tei-editor:latest
```

The application will be available at: http://localhost:8000

## Configuration Options

### User Authentication

The container automatically configures user accounts based on environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `APP_ADMIN_PASSWORD` | Password for admin user (full access) | `admin` (if not set) |
| `APP_DEMO_PASSWORD` | Password for demo user (limited access) | Not created if not set |

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

## Persistent Data

To persist your data across container restarts, mount these directories:

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

## Production Deployment

For production use, consider:

1. **Use HTTPS**: Deploy behind a reverse proxy (nginx, Traefik) with SSL
2. **Persistent Volumes**: Mount data directories to preserve work
3. **Backup Strategy**: Regularly backup the `/app/db` and `/app/data` directories
4. **Security**: Use strong passwords and restrict network access
5. **Resource Limits**: Set appropriate CPU/memory limits

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

## Available Tags

| Tag | Description |
|-----|-------------|
| `latest` | Latest stable version from main branch |
| `v1.x.x` | Specific version releases |
| `branch-hash` | Development builds from feature branches |

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

## Docker Hub Repository

The official Docker images are available at:
**https://hub.docker.com/r/cboulanger/pdf-tei-editor**

For issues, feature requests, or contributions, visit the GitHub repository linked on Docker Hub.