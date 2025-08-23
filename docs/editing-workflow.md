# Document Editing

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

## TEI Document Structure

### Standard TEI Elements
Common elements you'll work with:
- **`<teiHeader>`**: Document metadata and bibliographic information
- **`<biblStruct>`**: Individual bibliographic entries
- **`<author>`**: Author information with names and identifiers
- **`<title>`**: Publication titles at various levels
- **`<imprint>`**: Publication details (publisher, date, location)
- **`<idno>`**: Identifiers like DOI, ISBN, URLs

### Bibliographic Entry Structure
Typical `<biblStruct>` contains:
```xml
<biblStruct>
  <author>
    <persName>
      <forename>First</forename>
      <surname>Last</surname>
    </persName>
  </author>
  <title level="a">Article Title</title>
  <title level="j">Journal Title</title>
  <imprint>
    <date>2023</date>
    <biblScope unit="volume">5</biblScope>
    <biblScope unit="page">123-456</biblScope>
  </imprint>
  <idno type="DOI">10.1234/example</idno>
</biblStruct>
```

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

### Manual Validation Workflow
1. **Review Validation Errors**: Check for red underlines indicating errors
2. **Fix Schema Issues**: Correct malformed XML or invalid TEI structures
3. **Verify Content**: Compare extracted content against PDF source
4. **Mark as Verified**: Use node status controls to mark verified entries

## Collaborative Editing

### Edit Permissions
- **Read-Only Mode**: Document may be locked if you lack edit permissions
- **Owner Privileges**: Document owners have full editing access
- **Collaborative Locks**: Prevents simultaneous editing conflicts

### Change Tracking
- **Automatic Tracking**: All changes are automatically tracked
- **User Attribution**: Changes are attributed to the editing user
- **Version History**: Changes are preserved in version history
- **Conflict Resolution**: System prevents conflicting simultaneous edits

## Specialized TEI Editing Tools

### TEI Wizard (<!-- <sl-icon name="magic"></sl-icon> -->)
Access advanced TEI editing features:
- **Structure Enhancement**: Improve document structure automatically
- **Content Validation**: Advanced content checking beyond schema validation
- **Format Standardization**: Standardize formatting across the document
- **Enhancement Suggestions**: AI-powered suggestions for improvement

### Validation Tools (<!-- <sl-icon name="check-circle"></sl-icon> -->)
- **Schema Validation**: Check compliance with TEI schemas
- **Content Validation**: Verify bibliographic data completeness
- **Cross-Reference Validation**: Check internal references and links
- **Format Consistency**: Ensure consistent formatting throughout document

## Common Editing Scenarios

### Correcting Extraction Errors
1. **Compare with PDF**: Check extracted content against source
2. **Fix Author Names**: Correct name parsing and formatting issues
3. **Complete Missing Information**: Add missing publication details
4. **Standardize Identifiers**: Ensure DOIs and other identifiers are properly formatted

### Enhancing Bibliographic Entries
1. **Add Missing Elements**: Include additional TEI elements for completeness
2. **Improve Markup**: Use more specific TEI elements where appropriate
3. **Cross-Reference Links**: Add links between related entries
4. **Authority Control**: Standardize names and terms using authority files

### Resolving Validation Issues
1. **Fix Syntax Errors**: Correct malformed XML tags and attributes
2. **Address Schema Violations**: Ensure all elements follow TEI guidelines
3. **Complete Required Elements**: Add mandatory TEI elements
4. **Resolve Character Encoding**: Fix special character issues

## Performance and Efficiency Tips

### Editing Efficiency
- **Keyboard Shortcuts**: Learn common shortcuts for faster editing
- **Template Usage**: Use common patterns and templates for repetitive structures
- **Batch Operations**: Make similar changes across multiple entries efficiently
- **Search and Replace**: Use pattern matching for systematic corrections

### Document Organization
- **Logical Structure**: Maintain clear document structure with proper nesting
- **Consistent Formatting**: Use consistent indentation and spacing
- **Comment Usage**: Add XML comments for complex or temporary changes
- **Section Markers**: Use landmarks for navigating large documents

## Troubleshooting Editing Issues

### Common Problems
- **Permission Denied**: Cannot edit due to access restrictions
- **Validation Errors**: Red underlines indicating XML or schema problems
- **Performance Issues**: Slow response with very large documents
- **Character Encoding**: Special characters not displaying correctly

### Resolution Strategies
- **Check Permissions**: Verify you have edit access to the document
- **Fix Validation Issues**: Address XML syntax and schema compliance problems
- **Browser Refresh**: Reload page if editor becomes unresponsive  
- **Contact Support**: Report persistent technical issues to administrators