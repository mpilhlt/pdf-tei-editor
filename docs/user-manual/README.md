# PDF-TEI Editor User Manual

Welcome to the PDF-TEI Editor user manual. This documentation will help you use the application effectively.

## Quick Start

New to the PDF-TEI Editor? Start here:

1. **[Getting Started](getting-started.md)** - First login and basic workflow
2. **[Interface Overview](interface-overview.md)** - Understanding the interface
3. **[Extraction Workflow](extraction-workflow.md)** - Creating TEI from PDF documents

## Documentation by Task

### Basic Operations

| Guide | What You'll Learn |
|-------|-------------------|
| [Getting Started](getting-started.md) | How to log in and basic workflow |
| [Interface Overview](interface-overview.md) | Understanding the three-panel interface |
| [Extraction Workflow](extraction-workflow.md) | How to extract TEI from PDF documents |
| [Editing Workflow](editing-workflow.md) | How to edit and validate TEI markup |

### Document Management

| Guide | What You'll Learn |
|-------|-------------------|
| [Collection Management](collection-management.md) | How to organize documents into collections |
| [Access Control](access-control.md) | How to manage document permissions |
| [Merging Workflow](merging-workflow.md) | How to compare and merge document versions |
| [Import & Export](import-export.md) | How to import PDF/TEI files and export data |

### Advanced Features

| Guide | What You'll Learn |
|-------|-------------------|
| [Sync Workflow](sync-workflow.md) | How to synchronize with WebDAV servers |
| [User Management](user-management.md) | How to manage users and roles (administrators) |
| [CLI Reference](cli.md) | Command-line interface for user and collection management |
| [Import & Export](import-export.md) | Bulk import/export and backup strategies |

### Quick Setup

| Guide | What You'll Learn |
|-------|-------------------|
| [Docker Quick Start](testdrive-docker.md) | How to quickly test the application using Docker |

## Common Tasks

### Working with Documents

**Creating a new TEI document:**
1. Select a PDF from the document list
2. Use the extraction workflow to generate initial TEI
3. Edit and refine the markup
4. Save as a new version

**Editing existing TEI:**
1. Select the PDF and version from dropdowns
2. Edit in the XML editor (right panel)
3. Use schema validation to check your work
4. Save your changes

**Comparing versions:**
1. Select the base PDF document
2. Select "Compare with version" from dropdown
3. Use navigation controls to review differences
4. Merge changes if needed

### Managing Collections

**Organizing documents:**
1. Create collections for different projects or topics
2. Assign documents to collections
3. Use collection filter to view specific sets

**Sharing access:**
1. Create user groups
2. Assign collections to groups
3. Add users to appropriate groups

### Collaboration

**Working with others:**
1. Use file locks to prevent conflicts
2. Create versions for different stages of work
3. Use access control to manage permissions
4. Sync with WebDAV for remote collaboration

## User Roles

The application supports different user roles with varying permissions:

- **User** - Basic read access to assigned collections
- **Annotator** - Can create and edit version files
- **Reviewer** - Can create and edit gold standard files
- **Admin** - Full system access and user management

See [User Management](user-management.md) for details on roles and permissions.

## Interface Components

### Main Panels

**Left Panel (PDF Viewer)**:
- View source PDF documents
- Navigate pages and zoom
- Search within PDF

**Right Panel (XML Editor)**:
- Edit TEI/XML markup
- Real-time validation
- Syntax highlighting and auto-completion

**Floating Panel (Navigation)**:
- XPath-based navigation
- Node verification controls
- Diff and merge tools

See [Interface Overview](interface-overview.md) for complete details.

## Workflows

### Extraction Workflow

Convert PDF documents to TEI markup using automated extraction engines.

**Steps:**
1. Select PDF document
2. Choose extraction engine
3. Review extracted TEI
4. Save as version or gold standard

See [Extraction Workflow](extraction-workflow.md) for detailed instructions.

### Editing Workflow

Edit and refine TEI markup with validation and auto-completion.

**Features:**
- Schema validation
- Auto-completion
- XPath navigation
- Node verification

See [Editing Workflow](editing-workflow.md) for detailed instructions.

### Sync Workflow

Synchronize documents with remote WebDAV servers.

**Capabilities:**
- Upload local changes
- Download remote changes
- Conflict resolution
- Automatic synchronization

See [Sync Workflow](sync-workflow.md) for detailed instructions.

## Tips and Best Practices

### Document Organization

- Use meaningful collection names
- Organize by project, topic, or workflow stage
- Assign appropriate access permissions

### Version Management

- Create versions for major changes
- Document changes when saving
- Mark gold standards only when finalized
- Use variants for different extraction engines

### Collaboration

- Acquire file locks before editing
- Release locks when done
- Use WebDAV sync for team workflows
- Communicate with team about document status

### Validation

- Enable real-time validation while editing
- Address validation errors before saving
- Use schema-compliant markup
- Verify nodes after editing

## Troubleshooting

### Cannot Access Documents

**Possible causes:**
- Not logged in
- No collection access
- Document permissions restrict access

**Solutions:**
- Verify login status
- Check group memberships
- Contact administrator for access

### Cannot Edit Document

**Possible causes:**
- Insufficient role permissions
- File locked by another user
- Document marked as read-only

**Solutions:**
- Verify you have annotator or reviewer role
- Check file lock status
- Contact document owner

### Validation Errors

**Common issues:**
- Invalid TEI structure
- Missing required elements
- Schema violations

**Solutions:**
- Review error messages in editor
- Consult TEI guidelines
- Use auto-completion for valid elements

## Getting Help

1. **Check the relevant guide** - Find the task in the table above
2. **Review interface tooltips** - Hover over buttons for descriptions
3. **Contact your administrator** - For access or configuration issues
4. **Consult TEI guidelines** - For TEI markup questions: [TEI Guidelines](https://tei-c.org/guidelines/)

## Additional Resources

- **[TEI Guidelines](https://tei-c.org/guidelines/)** - Official TEI documentation
- **[XML Basics](https://www.w3schools.com/xml/)** - XML fundamentals
- **[XPath Tutorial](https://www.w3schools.com/xml/xpath_intro.asp)** - XPath navigation

## For Administrators

- **[User Management](user-management.md)** - Managing users, roles, and groups
- **[Developer Documentation](../development/README.md)** - Technical documentation for developers
- **[Installation Guide](../development/installation.md)** - Setting up the application

## About This Documentation

This manual is organized by user tasks and workflows. For technical documentation, see the [Developer Documentation](../development/README.md).

For information about the project, see [About](../about.md).
