# Testdrive PDF TEI Editor with Docker

The fastest way to try PDF TEI Editor is using the pre-built Docker container.

## Quick Start

Pull and run the latest version:

```bash
docker run -p 8000:8000 cboulanger/pdf-tei-editor:latest
```

Then visit: **<http://localhost:8000>**

Default credentials:

- Admin: `admin` / `admin`
- Demo user: `demo` / `demo`

The container includes demo data and is ready to use immediately.

## Custom Passwords

For production use or public instances, set custom passwords:

```bash
docker run -p 8000:8000 \
  -e APP_ADMIN_PASSWORD=your_secure_password \
  -e APP_DEMO_PASSWORD=demo_password \
  cboulanger/pdf-tei-editor:latest
```

## What's Next?

For production deployment, persistent data, AI services configuration, and more advanced usage, see the [Docker Deployment Guide](docker-deployment.md).
