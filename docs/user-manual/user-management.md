# User Management

This guide covers authentication, user account management, and access control for the PDF-TEI Editor.

## Authentication System

User, group, and collection data is managed via the ["Manage Access & Projects" tool](./rbac-manager.md), or via [`npm run manage-remote`](./cli-manage-remote.md) (using the http API).

The login dialog sends the password to the server, so serve the editor over HTTPS. The server stores only a salted scrypt hash of each password in `data/db/users.json`. Scripts should log in with a [personal access token](./access-tokens.md) instead of a password.

Earlier versions stored a bare SHA-256 hash, which worked as a password in its own right. The server converts these hashes to scrypt at startup, so users keep their passwords. Clients that send `passwd_hash` to `/api/v1/auth/login` instead of `password` are refused with HTTP 400 and have to be updated.

## User Roles

The application currently supports four user roles:

### User Role

- Standard user access
- Can view documents

### Annotator Role

- Can edit documents
- Can create their own version of a document
- Can delete their own documents
- Can save document revisions and set annotator-level document statusa

### Reviewer Role

- Can edit and delete documents
- Can set reviewr-level document status
- Can make a document the Gold Standard

### Admin Role  

- Full administrative access
- Can manage all users and roles
- Can access system configuration
- Can perform all user operations

## Docker Environment Variables

When using Docker deployment, you can configure user accounts via environment variables:

### Admin User Configuration

```bash
# Set admin password via environment variable
docker run -p 8000:8000 -e APP_ADMIN_PASSWORD=mysecurepassword cboulanger/pdf-tei-editor:latest
```

### Demo User Configuration

```bash
# Create both admin and demo users
docker run -p 8000:8000 \
  -e APP_ADMIN_PASSWORD=admin123 \
  -e APP_DEMO_PASSWORD=demo123 \
  cboulanger/pdf-tei-editor:latest
```