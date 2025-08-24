# Collection Management

Collections in the PDF-TEI Editor help organize documents into logical groups for better project management, access control, and workflow organization.

## Understanding Collections

### What Are Collections?
Collections are organizational containers that group related documents together:
- **Project-Based**: Documents for specific research projects
- **Thematic Groups**: Documents by subject, period, or type
- **Processing Stages**: Documents at different stages of processing
- **Institutional**: Documents by source institution or department
- **User Collections**: Personal document collections

### Collection Hierarchy
- **Root Collections**: Top-level organizational units
- **Nested Organization**: Collections can contain sub-collections
- **Cross-Collection Access**: Documents can be referenced across collections
- **Default Collection**: New documents go to `__inbox` by default

## Viewing Collections

### Collection Display
Collections are visible in several places:
- **PDF Dropdown**: Shows collection structure in document selection
- **Document Information**: Current document's collection is displayed
- **Extraction Dialog**: Collection selection during extraction process
- **Move Files Dialog**: Available destination collections

### Collection Information
Each collection displays:
- **Collection Name**: Human-readable collection identifier
- **Document Count**: Number of documents in the collection
- **Access Level**: Your permission level for the collection
- **Description**: Purpose and scope of the collection (if available)

## Moving Documents Between Collections

### Move Files Tool (<sl-icon name="folder-symlink"></sl-icon>)
1. **Access Move Dialog**: Click the <sl-icon name="folder-symlink"></sl-icon> button in the Document toolbar section
2. **Select Target Collection**: Choose destination collection from dropdown
3. **Create New Collection**: Option to create a new collection if needed
4. **Confirm Move**: Documents and related files are moved to the new collection

### Move Dialog Features
- **Collection Selection**: Dropdown showing all accessible collections
- **New Collection Creation**: Create collections on-the-fly during move operations
- **Permission Validation**: Only shows collections you have write access to
- **Batch Operations**: Move multiple related files together
