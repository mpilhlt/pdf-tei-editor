# Getting Started

Welcome to the PDF-TEI Editor! This guide will help you get started with the application.

## What is the PDF-TEI Editor?

The PDF-TEI Editor is a specialized tool for creating and editing TEI (Text Encoding Initiative) XML documents from PDF sources. It provides a three-panel interface that allows you to view PDF documents alongside their TEI markup, with tools for extraction, editing, validation, and version management.

## First Login

The PDF-TEI Editor requires user authentication to access documents and manage permissions.

### Logging In

When you first access the application, you'll be automatically prompted to log in. Each browser tab maintains its own session, so you can have multiple sessions open with different users (or the same user) if needed.

## Main Interface

After logging in, you'll see the main two-panel interface:

- **Left Panel**: PDF document viewer
- **Right Panel**: XML editor with syntax highlighting and validation


See [Interface Overview](interface-overview.md) for detailed information about the interface.

## Basic Workflow

A typical workflow in the PDF-TEI Editor involves:

1. **Select or load a PDF** - Choose a document from the file selector or upload a new one
2. **Extract TEI** - Use automatic extraction to create initial TEI markup (see [Extraction Workflow](extraction-workflow.md))
3. **Save your personal version**: Depending on your project's workflow, you either work on the extracted document directly or create your own personal version. Keeping the original extraction unaltered and editing a copy is recommended particularly in scenarios with multiple annotators.
4. **Edit & Validate** - Refine the TEI markup using the XML editor (see [Editing Workflow](editing-workflow.md)). The application automatically saves the document content after each change. 
5. **Save a revision record** - Save the state of the document and what you have changed as a revision record that is included in the TEI document header. This records your contribution to the annotation and leaves and makes it easy to attribute changes to individual annotators.  
6. **Review** - The reviewers then check your annotations and mark gold standard files when ready for production

## Key Concepts

The application uses a number of concepts in its user interface that need to be clarified. 

### Document Management

- **Collections**: Documents are organized into "collections" which are shown in the "Collections & Files" Drawer and the Collection dropdown in the toolbar. Access to collections is granted by administrators via the groups users belong to. A typical use case for collections is for batches of documents which need to be edited in one round of annotations. 
- **Variants**: The model "variant" denotes a particular XML schema or specialized use case that acts a filter for all the TEI documents that belong to a particular PDF. This can mean different things for specific extraction backends. For example, [Grobid](https://grobid.readthedocs.io) works with a number of different models which all need a particular XML annotation schema, each constituting a "variant" in the context of this application. 
- **Versions**: For each PDF and variant, a number of "versions" can exist. Typically, the first version is the extraction as returned by the extraction backend used. This version should not be edited but be kept to be able to compare annotations against it. It can be deleted safely later. In a mulit-annotator setup, each annotator should create their own version (this is enforced in owner-based mode)

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
