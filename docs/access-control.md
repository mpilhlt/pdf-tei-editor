# Access Control and Permissions

The PDF-TEI Editor includes a comprehensive access control system that manages document ownership, permissions, and collaborative editing capabilities.

## Permission System

### Document Status Levels
Documents can have different visibility and editability settings:

#### Visibility Options
- **Public**: Visible to all users with system access
- **Private**: Visible only to document owner and explicitly granted users
- **Restricted**: Visible to specific user groups or roles

#### Editability Options  
- **Editable**: Users with appropriate permissions can modify the document
- **Read-only**: Document can be viewed but not modified
- **Locked**: Temporarily locked during editing by another user

### User Roles
- **Owner**: Full control over document, including permission management
- **Editor**: Can modify document content and create new versions
- **Viewer**: Read-only access to document content
- **Admin**: System-wide administrative privileges

## Document Ownership

### Ownership Assignment
- **Initial Creation**: User who uploads or creates a document becomes the owner
- **Extraction Results**: User who performs extraction owns the resulting document
- **Version Creation**: New versions inherit ownership from parent document
- **Transfer Rights**: Owners can transfer ownership to other users

### Owner Privileges
Document owners can:
- Modify document content and metadata
- Create and manage document versions
- Set access permissions for other users
- Transfer ownership
- Delete documents and versions
- Move documents between collections

## Permission Management Interface

### Status Bar Indicators
The XML editor status bar displays current permission information:
- **Owner Name**: Shows document owner (if different from current user)
- **Permission Level**: Displays current user's access level
- **Edit Status**: Indicates if document is editable or read-only
- **Lock Status**: Shows if document is locked by another user

### Status Dropdown
A status dropdown widget allows owners to modify document settings:

#### Visibility Settings
- Change between public, private, and restricted access
- Grant access to specific users or groups
- Set default permissions for new collaborators

#### Editability Controls
- Lock/unlock document for editing
- Set read-only mode for specific users
- Configure collaborative editing settings

## Collaborative Features

### Multi-User Editing
- **File Locking**: Prevents simultaneous edits that could cause conflicts
- **User Notifications**: System notifies when others are viewing/editing
- **Change Tracking**: All modifications are tracked with user attribution
- **Version Branching**: Multiple users can work on separate versions

### Permission Inheritance
- **Collection Permissions**: Documents inherit base permissions from their collection
- **Version Permissions**: New versions inherit permissions from parent version
- **Override Capability**: Owners can override inherited permissions

## Access Control Workflow

### Setting Document Permissions
1. **Access Status Controls**: Use the status dropdown in the XML editor
2. **Select Visibility**: Choose public, private, or restricted
3. **Grant User Access**: Add specific users with appropriate roles
4. **Set Edit Permissions**: Configure who can modify vs. view only
5. **Apply Changes**: Permissions take effect immediately

### Collaborative Editing Process
1. **Document Access**: Collaborator accesses shared document
2. **Permission Check**: System verifies user has appropriate access
3. **Edit Lock**: System prevents conflicts during simultaneous editing
4. **Change Documentation**: All edits are tracked with user identification
5. **Version Management**: Changes can be saved as new versions or revisions

## Integration with Other Features

### Collection Management
- **Collection-level Permissions**: Set default access for all documents in a collection
- **Bulk Permission Changes**: Modify permissions for multiple documents
- **Collection Ownership**: Collections can have their own access controls

### Version Control
- **Branch Permissions**: Different versions can have different access levels
- **Merge Rights**: Control who can merge versions back together
- **History Access**: Manage access to document revision history

### Synchronization
- **External Repository Permissions**: Coordinate with WebDAV server permissions
- **Sync Conflicts**: Handle permission mismatches during synchronization
- **Audit Trail**: Track permission changes across synchronized systems

## Security Features

### Access Logging
- **Permission Changes**: All permission modifications are logged
- **Access Attempts**: Failed access attempts are recorded
- **User Activities**: Document access and modifications are tracked
- **Audit Reports**: Generate reports on document access patterns

### Data Protection
- **Encryption**: Documents are stored with appropriate encryption
- **Access Tokens**: Secure token-based access for API operations
- **Session Management**: Proper session handling prevents unauthorized access
- **Data Integrity**: Permissions are enforced at multiple system levels

## Troubleshooting Access Issues

### Common Problems
- **Permission Denied**: User lacks required access level for requested operation
- **Document Locked**: Another user currently has edit access
- **Ownership Confusion**: Unclear who owns a document after transfers
- **Collection Access**: Permission inheritance issues from collections

### Resolution Steps
1. **Check Current Permissions**: Review your access level in the status bar
2. **Contact Document Owner**: Request appropriate access if needed
3. **Verify Collection Access**: Ensure you have collection-level permissions
4. **Admin Assistance**: Contact system administrator for complex permission issues

### Best Practices
- **Regular Permission Reviews**: Periodically audit document access
- **Clear Ownership**: Maintain clear documentation of document ownership
- **Minimal Access**: Grant only necessary permissions to users
- **Version Management**: Use version control to manage collaborative changes safely