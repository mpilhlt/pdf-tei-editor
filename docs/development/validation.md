# XML Schema Validation and Autocomplete

The PDF-TEI Editor supports comprehensive XML schema validation and intelligent autocomplete features for TEI documents, supporting both XSD and RelaxNG schemas.

## Overview

The application supports two types of XML schema validation:

1. **XSD (XML Schema Definition)** - For validation only
2. **RelaxNG (Regular Language for XML Next Generation)** - For validation and intelligent autocomplete

The validation approach is automatically detected based on how the schema is declared in your XML documents.

## XSD Validation

For XSD-based validation, use the standard `xsi:schemaLocation` attribute in your root element:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.tei-c.org/ns/1.0 https://tei-c.org/release/xml/tei/custom/schema/xsd/tei_all.xsd">
  <teiHeader>
    <!-- Your TEI content -->
  </teiHeader>
</TEI>
```

### XSD Features
- ✅ Full validation against XSD schemas
- ❌ No autocomplete support (XSD schemas are not compatible with the autocomplete generator)

## RelaxNG Validation

For RelaxNG-based validation, use the `xml-model` processing instruction:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<?xml-model href="https://tei-c.org/release/xml/tei/custom/schema/relaxng/tei_all.rng" 
            type="application/xml" 
            schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <!-- Your TEI content -->
  </teiHeader>
</TEI>
```

### RelaxNG Features
- ✅ Full validation against RelaxNG schemas
- ✅ **Intelligent autocomplete** with TEI documentation extracted directly from the schema
- ✅ Context-aware suggestions for elements, attributes, and attribute values
- ✅ Documentation popups with detailed explanations from the TEI schema

## Intelligent Autocomplete System

The autocomplete system provides an enhanced editing experience when using RelaxNG schemas:

### Features

**Context-Aware Suggestions**:
- Element suggestions based on current location in document structure
- Attribute suggestions specific to the current element
- Attribute value suggestions from schema-defined enumerations
- Only valid options are shown at each position

**TEI Documentation Integration**:
- Real-time documentation popups extracted from TEI schema comments
- Detailed explanations of elements, attributes, and their usage
- Examples and best practices embedded in the editor

**Performance Optimization**:
- Schema parsing is cached for fast subsequent access
- Suggestions are generated dynamically without pre-computation
- Minimal impact on editor performance

### How It Works

1. **Schema Detection**: The system reads the `xml-model` processing instruction
2. **Schema Download**: RelaxNG schema is downloaded and cached automatically
3. **Documentation Extraction**: TEI documentation is parsed from schema annotations
4. **Context Analysis**: Current cursor position determines valid suggestions
5. **Real-Time Suggestions**: Autocomplete shows contextually appropriate options

## Schema Caching

Both XSD and RelaxNG schemas are downloaded and cached automatically when first encountered.

### Cache Location
- **Cache Directory**: `schema/cache`
- **Automatic Download**: Schemas are fetched on first use
- **Persistence**: Cached schemas persist across application restarts

### Cache Management

```bash
# Refresh cached schemas (delete cache directory)
rm -rf schema/cache
```

The cache will be automatically rebuilt when documents are opened that reference external schemas.

## Best Practices

### Schema Selection

**For Validation Only**:
- Use XSD schemas with `xsi:schemaLocation`
- Suitable when you only need document validation
- Standard XML toolchain compatibility

**For Enhanced Editing Experience**:
- Use RelaxNG schemas with `xml-model` processing instructions
- Provides full validation plus intelligent autocomplete
- Recommended for interactive document creation and editing

### TEI Projects

For TEI document projects, **RelaxNG is strongly recommended** because:

1. **Full Editing Experience**: Intelligent autocomplete with contextual suggestions
2. **Documentation Integration**: Built-in TEI guidelines and examples
3. **Schema Flexibility**: RelaxNG provides more expressive validation rules
4. **Community Standard**: TEI Guidelines are authored in RelaxNG

### Example TEI Document Setup

```xml
<?xml version="1.0" encoding="UTF-8"?>
<?xml-model href="https://tei-c.org/release/xml/tei/custom/schema/relaxng/tei_all.rng" 
            type="application/xml" 
            schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>My TEI Document</title>
      </titleStmt>
      <publicationStmt>
        <p>Publication information</p>
      </publicationStmt>
      <sourceDesc>
        <p>Information about the source</p>
      </sourceDesc>
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <p>Document content goes here</p>
    </body>
  </text>
</TEI>
```

## Custom Schemas

The system supports both standard TEI schemas and custom schemas:

### Custom XSD Schemas
```xml
<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="http://example.com/ns https://example.com/schema/custom.xsd">
```

### Custom RelaxNG Schemas
```xml
<?xml-model href="https://example.com/schema/custom.rng" 
            type="application/xml" 
            schematypens="http://relaxng.org/ns/structure/1.0"?>
```

## Validation Performance

The validation system is optimized for performance:

- **Incremental Validation**: Only validates changed portions of large documents
- **Background Processing**: Validation runs asynchronously to avoid blocking the editor
- **Caching**: Schema compilation results are cached for repeated use
- **Timeout Protection**: Long-running validations are automatically cancelled

## Troubleshooting

### Common Issues

**Schema Not Found**:
- Verify the schema URL is accessible
- Check network connectivity for remote schemas
- Ensure local schema files are in the correct path

**No Autocomplete Suggestions**:
- Confirm you're using RelaxNG with `xml-model` processing instruction
- Verify the schema URL points to a valid RelaxNG file
- Check that the schema has been successfully downloaded and cached

**Validation Errors**:
- Review the document structure against the schema requirements
- Check for missing required elements or attributes
- Verify namespace declarations match the schema expectations

**Performance Issues**:
- Large schemas may take time to process initially
- Check the browser console for validation timeout warnings
- Consider using simpler schemas for better performance

### Cache Issues

If you encounter schema caching problems:

1. **Clear the cache**: Delete the `schema/cache` directory
2. **Restart the application**: Ensure clean schema reloading
3. **Check file permissions**: Verify the cache directory is writable
4. **Network issues**: Confirm external schema URLs are accessible

## Related Documentation

- [Development Guide](development.md) - Technical implementation details
- [Installation Guide](installation.md) - Setting up the validation system
- [Interface Overview](interface-overview.md) - Using the XML editor with validation