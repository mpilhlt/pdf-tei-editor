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
