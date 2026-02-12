# Collection export

Now we want to support to include additional export formats when exporting collections in @/app/src/plugins/file-selection-drawer.js . We do this by using the extension endpoint system described in @/docs/development/plugin-system-frontend.md using the "no-call flag" to gather information from loosely coupled plugins. 

- The export menu uses a new extension endpoint "export-formats" (add to @/app/src/endpoints.js ) returning an array of `{'id':str, 'label':str}` objects.
- The values gathered from the extension point gets flattened into an array and used to add checkboxes to the menu with the label. The `handleExport` function then passes the list of ids to the backend export route in @/fastapi_app/routers/files_export.py 
- the export then