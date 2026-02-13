# XSLT Export Plugin

This plugin provides XSLT transformations for TEI documents, enabling additional export formats beyond the default TEI/XML output, and a "xslt-viewer" feature for viewing transformed TEI documents in the browser in an overlay to the xml editor.

## Overview

The plugin registers export formats (CSV, RIS, etc.) that can be selected when exporting collections. These formats are applied via XSLT transformations to produce alternative representations of the TEI document content.

## Architecture

The plugin consists of two parts:

1. **Frontend Extension** (`extensions/tei-xslt.js`) - Registers export formats with the application
2. **XSLT Stylesheets** (`html/`) - The actual XSLT transformation files

## Registering Export Formats

### Current Method: Export Formats Endpoint

Export formats are registered via the `export_formats` export in the frontend extension:

```javascript
export const export_formats = () => [
  {
    id: 'csv',
    label: 'CSV (biblstruct)',
    url: '/api/plugins/xslt_export/static/html/biblstruct-to-csv.xslt',
    output: 'html',
    stripTags: true,
    ext: 'csv'
  },
  {
    id: 'ris',
    label: 'RIS (biblstruct)',
    url: '/api/plugins/xslt_export/static/html/biblstruct-to-ris.xslt',
    output: 'html',
    stripTags: true,
    ext: 'ris'
  }
];
```

**Format Specification Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier for the format (used for folder name in export) |
| `label` | Yes | Display label shown in the export menu |
| `url` | Yes | URL to the XSLT stylesheet (must be `/api/plugins/*/static/` for security) |
| `output` | No | XSLT output type (default: 'html') - currently informational only |
| `stripTags` | No | Whether to strip HTML tags from output (default: false) |
| `ext` | No | Output file extension without leading period (default: uses `id`) |

**Security Note:** Only URLs matching `/api/plugins/*/static/` pattern are accepted. External URLs are rejected.

### Adding a New Export Format

1. Add your XSLT stylesheet to the `html/` directory
2. Register the format in `extensions/tei-xslt.js`:

```javascript
export const export_formats = () => [
  // ... existing formats ...
  {
    id: 'myformat',
    label: 'My Custom Format',
    url: '/api/plugins/xslt_export/static/html/my-transform.xslt',
    output: 'html',
    stripTags: true,
    ext: 'dat'  // Output file extension
  }
];
```

3. The format will automatically appear in the export menu when the drawer is opened

## Writing XSLT for XML Output with Viewer Formatting

When creating XSLT stylesheets that generate XML output for display in the xsl-viewer plugin, use this pattern to enable proper formatting and syntax highlighting:

### HTML Wrapper Pattern

Create an XSLT that outputs HTML with the XML content embedded for display:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:tei="http://www.tei-c.org/ns/1.0"
    exclude-result-prefixes="tei">

  <xsl:output method="html" indent="no" encoding="UTF-8"/>

  <!-- Root template - wrap in HTML -->
  <xsl:template match="/">
    <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f5f5;
          }
          .xml-output {
            background: white;
            border: 1px solid #ddd;
            border-radius: 4px;
            padding: 0;
            margin: 0;
          }
          pre {
            margin: 0;
            padding: 16px;
            overflow-x: auto;
          }
          code {
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;
            font-size: 13px;
            line-height: 1.5;
          }
          h2 {
            margin: 0 0 16px 0;
            padding: 12px 16px;
            background: #f8f9fa;
            border-bottom: 1px solid #ddd;
            font-size: 16px;
            font-weight: 600;
          }
        </style>
      </head>
      <body>
        <div class="xml-output">
          <h2>XML Output</h2>
          <pre><code class="language-xml xsl-xml-target"></code></pre>
        </div>

        <!-- Store XML in hidden div with xsl-xml-source class -->
        <div class="xsl-xml-source" style="display: none;">
          <xsl:apply-templates select="//tei:TEI" mode="generate-xml"/>
        </div>
      </body>
    </html>
  </xsl:template>

  <!-- Generate your XML structure -->
  <xsl:template match="tei:TEI" mode="generate-xml">
    <root xmlns="http://example.org/schema">
      <element>
        <xsl:value-of select=".//tei:title"/>
      </element>
    </root>
  </xsl:template>

</xsl:stylesheet>
```

### Key Components

1. **Display Target** - Code block where formatted XML will appear:

   ```html
   <code class="language-xml xsl-xml-target"></code>
   ```

   - `language-xml` class enables highlight.js syntax highlighting
   - `xsl-xml-target` class marks this as the display target

2. **XML Source** - Hidden div containing the actual XML elements:

   ```html
   <div class="xsl-xml-source" style="display: none;">
     <xsl:apply-templates select="//tei:TEI" mode="generate-xml"/>
   </div>
   ```

   - `xsl-xml-source` class marks this as the source container
   - Generate XML elements here using XSLT templates

3. **Automatic Processing** - The xsl-viewer plugin JavaScript automatically:
   - Finds matching pairs of `.xsl-xml-source` and `.xsl-xml-target`
   - Clones the XML elements from the source
   - Applies pretty-printing with proper indentation
   - Serializes to string
   - Removes XHTML namespace artifacts (see below)
   - Displays in the target with syntax highlighting

### Multiple XML Outputs

You can have multiple XML outputs in the same document by using multiple source/target pairs:

```html
<div class="xml-output">
  <h2>Metadata XML</h2>
  <pre><code class="language-xml xsl-xml-target"></code></pre>
</div>
<div class="xsl-xml-source" style="display: none;">
  <!-- First XML content -->
</div>

<div class="xml-output">
  <h2>Citation XML</h2>
  <pre><code class="language-xml xsl-xml-target"></code></pre>
</div>
<div class="xsl-xml-source" style="display: none;">
  <!-- Second XML content -->
</div>
```

The JavaScript matches sources to targets by index order.

### Namespace Handling

When generating XML elements in HTML output mode, XSLT assigns them the XHTML namespace by default. This causes namespace prefix pollution (e.g., `<a0:element>`) when serialized. The xsl-viewer JavaScript automatically strips these artifacts:

- Removes `xmlns:a0="http://www.w3.org/1999/xhtml"` declarations
- Removes `a0:` prefixes from element tags

This means you can write clean XSLT without worrying about namespace issues:

```xml
<doi_batch version="5.4.0" xmlns="http://www.crossref.org/schema/5.4.0">
  <head>
    <doi_batch_id>12345</doi_batch_id>
  </head>
</doi_batch>
```

The output will be clean XML with your intended namespace, properly formatted and syntax highlighted.

### Example: CrossRef XML Viewer

See `html/tei-to-crossref-html.xslt` for a complete working example that generates CrossRef XML from TEI documents using this pattern.

## XSLT Viewer Registration (Legacy)

The extension also registers XSLT stylesheets with the `xsl-viewer` plugin for in-app preview:

```javascript
export async function start(sandbox) {
  const transformations = [
    {
      label: 'Reference list',
      url: '/api/plugins/xslt-export/static/biblstruct-to-html.xslt'
    },
    // ... more formats ...
  ];

  for (const t of transformations) {
    const xsltString = await sandbox.fetchText(t.url);
    const xslDoc = parseXslt(xsltString);
    sandbox.registerXslStylesheet({
      label: t.label,
      xmlns: TEI_NAMESPACE,
      xslDoc: xslDoc
    });
  }
}
```

### ⚠️ Migration Note: XSLT Viewer Registration

**The sandbox-based registration above is NOT the final solution.** This approach:

- Requires the `xsl-viewer` plugin as a dependency
- Couples the XSLT registration to the frontend extension system
- Makes it difficult to discover and manage XSLT transformations

**Future Improvement:** The XSLT viewer registration should be migrated to use a dedicated plugin extension endpoint (similar to `export_formats`), allowing:

1. Plugin-based discovery of XSLT stylesheets
2. Centralized management through the plugin system
3. Better separation of concerns

Example of the target architecture:

```javascript
// Future: Register both export and viewer formats via endpoints
export const export_formats = () => [...];
export const viewer_formats = () => [...];  // Future endpoint
```

## File Structure

```
xslt_export/
├── README.md                    # This file
├── __init__.py                  # Plugin initialization
├── plugin.py                    # Plugin class
├── extensions/
│   └── tei-xslt.js             # Frontend extension (registers formats)
└── html/
    ├── biblstruct-to-csv.xslt  # CSV transformation
    ├── biblstruct-to-ris.xslt  # RIS transformation
    └── biblstruct-to-html.xslt # HTML table transformation
```

## Export Output Structure

When exporting collections with additional formats selected:

```
export.zip
└── collection/
    ├── csv/
    │   └── doc.csv             # Transformed from doc.tei.xml
    ├── ris/
    │   └── doc.ris             # Transformed from doc.tei.xml
    ├── tei/
    │   └── doc.tei.xml
    └── pdf/
        └── doc.pdf
```
