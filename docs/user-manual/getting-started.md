# Getting Started

Welcome to the PDF-TEI Editor! This guide will help you get started with the application.

## What is the PDF-TEI Editor?

The PDF-TEI Editor is a specialized tool for creating and editing TEI (Text Encoding Initiative) XML documents from PDF sources. It provides a three-panel interface that allows you to view PDF documents alongside their TEI markup, with tools for extraction, editing, validation, and version management.

## First Login

The PDF-TEI Editor requires user authentication to access documents and manage permissions.

### Logging In

When you first access the application, you'll be automatically prompted to log in:

1. Enter your **username**
2. Enter your **password**
3. Click **Login**

Each browser tab maintains its own session, so you can have multiple sessions open with different users if needed.

### Default Accounts

For initial setup or testing, default accounts may be available (check with your administrator):

- **admin** - Full administrative access
- **reviewer** - Can create and edit gold standard files
- **annotator** - Can create and edit version files

**Note**: Change default passwords immediately in production environments.

## Main Interface

After logging in, you'll see the main three-panel interface:

- **Left Panel**: PDF document viewer
- **Right Panel**: XML editor with syntax highlighting and validation
- **Floating Panel**: Navigation and verification tools

See [Interface Overview](interface-overview.md) for detailed information about the interface.

## Basic Workflow

A typical workflow in the PDF-TEI Editor involves:

1. **Select a PDF** - Choose a document from the file selector
2. **Extract TEI** - Use automatic extraction to create initial TEI markup (see [Extraction Workflow](extraction-workflow.md))
3. **Edit & Validate** - Refine the TEI markup using the XML editor (see [Editing Workflow](editing-workflow.md))
4. **Save** - Save your work as a new version
5. **Review** - Mark gold standard files when ready for production

## Key Features

### Document Management

- **Collections**: Organize documents into collections
- **Versions**: Create and manage multiple versions of documents
- **Variants**: Support for different extraction engines and document variants

### Editing Tools

- **Syntax Highlighting**: Color-coded TEI/XML markup
- **Schema Validation**: Real-time validation against TEI schemas
- **Auto-completion**: Context-aware suggestions while editing
- **XPath Navigation**: Navigate documents by XPath expressions

### Collaboration

- **Access Control**: Role-based permissions for users
- **File Locks**: Prevent concurrent editing conflicts
- **WebDAV Sync**: Synchronize with remote servers (see [Sync Workflow](sync-workflow.md))

## Next Steps

- **[Interface Overview](interface-overview.md)** - Learn about the interface components
- **[Extraction Workflow](extraction-workflow.md)** - Extract TEI from PDF documents
- **[Editing Workflow](editing-workflow.md)** - Edit and validate TEI markup
- **[Collection Management](collection-management.md)** - Organize your documents
- **[User Management](user-management.md)** - Manage users and permissions (administrators)

## Getting Help

If you encounter issues:

1. Check the relevant workflow guide for your task
2. Verify you have the required permissions for the operation
3. Contact your system administrator for access or configuration issues

## User Management

For information about managing users and roles, see [User Management](user-management.md).
