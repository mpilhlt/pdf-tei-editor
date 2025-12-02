# Document Editing

(ai-generated)

The PDF-TEI Editor provides powerful editing capabilities for refining TEI documents with syntax highlighting, validation, and specialized tools for bibliographic markup.

## XML Editor Features

### CodeMirror-Based Editor

The right panel features a full-featured XML editor with:

- **Syntax Highlighting**: Color-coded XML markup for easy reading
- **Line Numbers**: Numbered lines for precise navigation and error reporting  
- **Auto-Indentation**: Automatic code formatting and indentation
- **Bracket Matching**: Highlights matching XML tags and brackets
- **Code Folding**: Collapse sections for better document overview

### Editor Status Bar

The bottom of the editor shows:

- **Cursor Position**: Current line and column (e.g., "Ln 1, Col 1")
- **Indentation Settings**: Current indentation style (e.g., "Indent: 2 spaces")
- **Document Status**: Validation status, save status, and permissions
- **Access Control**: Current permission level and owner information

## Editing Operations

### Basic Text Editing

- **Direct Editing**: Click anywhere in the editor to place cursor and type
- **Selection**: Drag to select text or double-click to select words
- **Copy/Paste**: Standard keyboard shortcuts work (Ctrl/Cmd+C, Ctrl/Cmd+V)
- **Undo/Redo**: Ctrl/Cmd+Z to undo, Ctrl/Cmd+Y to redo changes

### XML-Specific Editing

- **Tag Completion**: Auto-complete XML tags as you type
- **Attribute Assistance**: Suggestions for common TEI attributes
- **Well-Formedness Checking**: Real-time validation of XML structure
- **Tag Matching**: Automatic highlighting of opening/closing tag pairs

### Advanced Editing Features

- **Find and Replace**: Ctrl/Cmd+F for search, Ctrl/Cmd+H for replace
- **Multiple Cursors**: Hold Ctrl/Cmd and click to create multiple edit points
- **Block Selection**: Alt+drag to select rectangular blocks of text
- **Code Formatting**: Automatic indentation and formatting assistance

## Navigation and Node Management

### XPath Navigation

Use the floating panel for structured navigation:

1. **XPath Selector**: Choose from predefined XPath expressions or create custom ones
2. **Node Navigation**: Use << and >> buttons to move between matching nodes
3. **Current Node Highlighting**: Selected nodes are highlighted in the editor

### Node Status Management

For each bibliographic entry:

- **Verified**: Mark nodes as manually verified and correct
- **Unresolved**: Mark nodes that need attention or have issues
- **Clear Node**: Remove status markers to reset node state

## Validation and Quality Control

### Real-Time Schema Validation

- **TEI Schema Compliance**: Automatic validation against TEI schemas
- **Error Highlighting**: Invalid markup is highlighted with red underlines
- **Error Messages**: Detailed error descriptions appear in tooltips
- **Validation Status**: Overall document validation status in the status bar

## Specialized TEI Editing Tools

### TEI Wizard (<sl-icon name="magic"></sl-icon>)

The TEI Wizard helps with common TEI markup tasks. Currently, only one feature is implemented (TEI-specific pretty-printing), but more will be added in the future.
