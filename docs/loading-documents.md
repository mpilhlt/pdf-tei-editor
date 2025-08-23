# Loading Documents

This guide covers how to load and access PDF documents and their corresponding TEI files in the PDF-TEI Editor.

## Selecting a PDF Document

1. **Access the PDF Dropdown**: Click the **PDF** dropdown in the top-left of the toolbar
2. **Browse Available Documents**: The dropdown shows all available PDF documents in your collections
3. **Select Document**: Click on any document name to load it

The PDF dropdown displays documents in the format:
- Document titles or identifiers
- DOI-based filenames (e.g., `10.12946__rg01__036-055-aw`)
- Custom document names

## Document Loading Process

When you select a document:

1. **PDF Loading**: The left panel loads the PDF viewer with the selected document
2. **XML Loading**: The right panel loads the corresponding TEI/XML file (if available)
3. **Navigation Setup**: The floating panel configures navigation for the document structure
4. **Status Updates**: The interface updates to reflect the loaded document's status and permissions

## Document Types and Sources

### Available Document Collections
Documents are organized into collections that may represent:
- Research projects
- Document types (legal, humanities, etc.)
- Processing stages (inbox, processed, verified)
- User or institutional collections

### Document Formats
- **PDF Source**: Original PDF files with footnotes and bibliographic references  
- **TEI/XML**: Structured markup with extracted bibliographic data
- **Versions**: Multiple versions of the same document for comparison

## Navigation After Loading

Once a document is loaded:

### PDF Navigation
- **Page Controls**: Use standard PDF.js navigation (page up/down, zoom, search)
- **Reference Highlighting**: References may be highlighted or annotated
- **Text Selection**: Select text for cross-referencing with XML content

### XML Navigation  
- **Node Navigation**: Use the floating panel to navigate between `<biblStruct>` elements
- **XPath Selection**: Choose different XPath expressions for navigation
- **Syntax Highlighting**: XML content is color-coded for easy reading

### Synchronized Navigation
- **Cross-Panel Sync**: Selections in one panel may highlight corresponding content in the other
- **Reference Linking**: Navigate between PDF footnotes and XML bibliographic entries
- **Search Integration**: Search terms work across both panels

## Document Status and Information

### Status Indicators
The interface shows various document status indicators:
- **Validation Status**: Schema compliance and error indicators
- **Edit Status**: Whether the document is editable or read-only
- **Version Information**: Current version and available alternatives
- **Permission Level**: Your access rights for the document

### Document Metadata
Available metadata may include:
- **Title and Author**: Document identification information
- **DOI**: Digital Object Identifier (if available)
- **Collection**: Which collection the document belongs to
- **Processing Date**: When the document was last processed
- **Owner**: Document owner and permissions
