# User Management

This guide covers authentication, user account management, and access control for the PDF-TEI Editor.

## Authentication System

The PDF-TEI Editor uses a simple, file-based authentication system. User data is stored in `db/users.json`.

## User Management Commands

You can manage users using the command-line interface:

### Basic User Operations

```bash
# List all users
npm run manage user list

# Add a new user
npm run manage user add <username> --password <password> --fullname "<Full Name>" --email "<email>"

# Remove a user
npm run manage user remove <username>

# Update a user's password
npm run manage user update-password <username> --password <new_password>

# Set a user property (fullname, username, email)
npm run manage user set <username> <property> <value>
```

### Role Management

```bash
# Add a role to a user
npm run manage user add-role <username> <rolename>

# Remove a role from a user
npm run manage user remove-role <username> <rolename>
```

### Group Management

The system supports group-based access control for organizing users and managing access to collections:

```bash
# Add a group to a user
npm run manage user add-group <username> <groupid>

# Remove a group from a user
npm run manage user remove-group <username> <groupid>

# List all groups
npm run manage group list

# List all collections
npm run manage collection list
```

For comprehensive CLI documentation including group and collection management, see the [Development Commands](../code-assistant/development-commands.md).

### Example: Setting Up a New Admin User

```bash
# Remove the default admin user (recommended for security)
npm run manage user remove admin

# Add your own admin user
npm run manage user add myusername --password myuserpass --fullname "Full Name" --email "user@example.com"

# Grant admin privileges
npm run manage user add-role myusername admin
```

### Help and Documentation

```bash
# General help
npm run manage help

# User management specific help
npm run manage help user
```

## Default User Account

The application comes with a default user account:

- **Username**: `admin`
- **Password**: `admin`

**⚠️ Security Warning**: Remove the default admin user immediately in production environments and create your own admin account with a strong password.

## User Roles

The application currently supports two user roles:

### User Role
- Standard user access
- Can view and edit documents
- Cannot manage other users
- Cannot access administrative functions

### Admin Role  
- Full administrative access
- Can manage all users and roles
- Can access system configuration
- Can perform all user operations

**Note**: A more fine-grained permission system will be added if necessary in future versions.

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

### User Account Details

**Admin User (Always Created)**:
- Username: `admin`
- Password: Value of `APP_ADMIN_PASSWORD` environment variable, or `admin` if not set
- Role: `admin`
- Full Name: `Administrator`
- Email: `admin@localhost`

**Demo User (Optional)**:
- Username: `demo`
- Password: Value of `APP_DEMO_PASSWORD` environment variable
- Role: `user`
- Full Name: `Demo User`
- Email: `demo@localhost`
- **Only created if**: `APP_DEMO_PASSWORD` environment variable is set

## User Data Storage

User information is stored in the `db/users.json` file with the following structure:

```json
{
  "username": {
    "username": "username",
    "fullname": "Full Name",
    "email": "user@example.com",
    "password_hash": "hashed_password",
    "roles": ["user", "admin"],
    "created": "2024-01-01T00:00:00Z",
    "last_login": "2024-01-01T00:00:00Z"
  }
}
```

### Security Features

- **Password Hashing**: All passwords are stored as secure hashes, never in plain text
- **Session Management**: User sessions are managed securely with appropriate timeouts
- **Role-Based Access**: Features are restricted based on user roles
- **Audit Trail**: User creation and login times are tracked

## Interactive Demo Setup

When using the interactive demo setup script:

```bash
sudo ./docker/setup-demo.sh
```

The script will prompt you to:
1. Set a secure admin password
2. Optionally create a demo user with limited permissions
3. Configure the system with your specified credentials

## Best Practices

### Security Recommendations

1. **Change Default Credentials**: Always change the default admin password
2. **Use Strong Passwords**: Enforce strong password policies for all users
3. **Regular Audits**: Periodically review user accounts and remove unused accounts
4. **Role-Based Access**: Assign appropriate roles based on user responsibilities
5. **Backup User Data**: Include `db/users.json` in your backup strategy

### User Account Hygiene

1. **Remove Unused Accounts**: Regularly clean up accounts that are no longer needed
2. **Monitor Last Login**: Track when users last accessed the system
3. **Update Contact Information**: Keep user email addresses current for notifications
4. **Document Admin Changes**: Keep records of administrative user changes

## Troubleshooting

### Common Issues

**Cannot Login**:
- Verify username and password are correct
- Check if the user account exists: `npm run manage user list`
- Ensure the user has appropriate roles assigned

**Permission Denied**:
- Check if the user has the required role for the attempted action
- Verify admin users have the `admin` role assigned
- Confirm the user account is active and not disabled

**User Management Commands Fail**:
- Ensure you're running commands from the application root directory
- Check that the virtual environment is activated
- Verify `db/users.json` file permissions and existence

**Docker User Creation Issues**:
- Verify environment variables are set correctly when starting the container
- Check container logs for user creation messages
- Ensure passwords meet minimum complexity requirements

### Password Reset

If you lose admin access:

```bash
# Create a new admin user
npm run manage user add newadmin --password newpassword --fullname "New Admin" --email "newadmin@localhost"
npm run manage user add-role newadmin admin

# Remove the old admin if needed
npm run manage user remove oldadmin
```

## Related Documentation

- [Installation Guide](installation.md) - Setting up the application
- [Deployment Guide](deployment.md) - Container-based user configuration and deployment
- [Development Guide](development.md) - Technical architecture details