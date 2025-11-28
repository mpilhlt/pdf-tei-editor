# Document-level Access Control and Permissions

> Note: the permission system is not fully working yet and has therefore been disabled for the moment. The following (ai-generated) document outlines its capabilities. 

The PDF-TEI Editor includes an access control system that manages document ownership, permissions, and collaborative editing capabilities.

## Permission System

### Document Status Levels

Documents can have different visibility and editability settings:

#### Visibility Options

- **Public**: Visible to all users with system access
- **Private**: Visible only to document owner and explicitly granted users

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

Ownership only matters if the document is protected (private or restricted). Public documents can be edited by any logged-in user with edit permissions.

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

- Change between public and private access
- Lock/unlock document for editing
