# README links in the "Available" tab of the plugin manager

The "Installed" tab of the plugin manager linked each plugin's README, the "Available" tab did not, so an administrator could not read a plugin's documentation before installing it.

## Change

- `PluginCatalog` sets `CatalogEntry.readme_url` for every index entry: the entry's optional `readme` (http(s) URL) if present, otherwise `https://github.com/<repo>/tree/<default branch>/<path>#readme`, or `https://github.com/<repo>#readme` for a single-plugin repository (`"path": "."`). This matches the link the pte-plugins overview page uses. No extra GitHub request is made.
- `GET /api/v1/plugins/admin/available` returns `readme_url` per plugin (`AvailablePlugin` model, `api-client-v1.js` typedef).
- The "Available" tab shows a README button below the install/upgrade button.
- Tests: `TestCatalog.test_readme_url` (derived link, single-plugin repository, `readme` override, non-http value ignored); the plugin manager E2E test checks the button.
