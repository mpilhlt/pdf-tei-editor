# Collection export

We want to support to include additional export formats when exporting collections. We do this by using the extension endpoint system described in @/docs/development/plugin-system-frontend.md using the "no-call flag" to gather information from loosely coupled plugins. 

- Update @/app/src/plugins/file-selection-drawer.js to use a new extension endpoint "export-formats" (add to @/app/src/endpoints.js ), which returns an array of `{'id':str, 'label':str, 'url':str}` objects.
- The array of array of objects gathered from the extension point gets flattened into an array and used to populate a new section of the export menu with a title "Additional Formats" and  checkboxes for each item with the id as the value and the  label, which is shown only if the endpoint returns values. 
- The `handleExport` function then passes the list of ids that are checked to the backend export route in @/fastapi_app/routers/files_export.py 
- the exporter adds additional folders to the export ZIP with the name of the id, containing the xsl tranformation of every file that is included in the export (regardless of whether it is "gold" or "version"), using the XSLT from the URL provided in the extension endpoint. For the moment, only allow URL from a plugin route (`api/plugin/{plugin-in}/static/{path-to-xsl}`), not external URLs, which also allows to directly use a filesystem path rather than fetching the XSLT from the URL.
- Add a new extension endpoint "export-formats" to @/fastapi_app/plugins/grobid/extensions/tei-xslt.js with the list for `fastapi_app/plugins/xslt_export/html/biblstruct-to-csv.xslt` and `fastapi_app/plugins/xslt_export/html/biblstruct-to-ris.xslt`.

## Implementation Plan: Collection Export with Additional Formats

Here's the implementation plan for adding support for additional export formats via the extension endpoint system:

### Changes Required

#### 1. `app/src/endpoints.js`
Add the new "export-formats" endpoint:
```javascript
export: {
  formats: "export.formats"
}
```

#### 2. `app/src/plugins/file-selection-drawer.js`
- Add a new UI typedef for export format checkboxes
- Modify `handleExport()` to:
  - Call the `!export.formats` endpoint (no-call flag) to get format definitions
  - Flatten results into a single array of `{id, label, url}` objects
  - Dynamically add a "Additional Formats" section with checkboxes (only if formats exist)
  - Pass checked format IDs to the backend export route
- Update the export menu handler to include the `additional_formats` parameter

#### 3. `app/src/templates/file-selection-drawer.html`
Add a container for the dynamic export format checkboxes:
```html
<div name="exportFormatCheckboxes" style="display: none; margin-top: 0.5rem;">
  <div style="font-weight: bold; margin-bottom: 0.25rem;">Additional Formats</div>
  <!-- Checkboxes will be injected here -->
</div>
```

#### 4. `fastapi_app/routers/files_export.py`
- Add `additional_formats: Optional[List[str]] = Query(None)` parameter
- Pass formats to `FileZipExporter.export_to_zip()` or create a new export method
- After creating the ZIP, for each requested format:
  - Fetch XSLT from the plugin URL
  - Apply transformation to each TEI file
  - Add output files to a subfolder named after the format ID

#### 5. `fastapi_app/lib/file_zip_exporter.py`
Add a new method `export_with_formats()` that:
- Exports TEI files as usual
- For each format, applies XSLT transformation
- Adds transformed files to format-named subfolders in the export

#### 6. `fastapi_app/plugins/grobid/extensions/tei-xslt.js`
Add an `export.formats` endpoint that returns the available export formats:
```javascript
export function export_formats() {
  return [
    { id: 'csv', label: 'CSV (biblstruct)', url: '/api/plugins/xslt_export/static/html/biblstruct-to-csv.xslt' },
    { id: 'ris', label: 'RIS (biblstruct)', url: '/api/plugins/xslt_export/static/html/biblstruct-to-ris.xslt' }
  ];
}
```

#### 7. `fastapi_app/plugins/xslt_export/__init__.py`
Register the `export.formats` endpoint.

### Key Implementation Details

1. **XSLT Transformation**: Use Python's `lxml` library for XSLT transformation (consistent with `tei_utils.py`)
2. **URL Validation**: Only allow URLs starting with `/api/plugins/` for security
3. **Format IDs as Folder Names**: Each format gets its own folder in the ZIP (e.g., `csv/biblio.csv`, `ris/biblio.ris`)
4. **All TEI Files**: Transform both gold and versioned TEI files