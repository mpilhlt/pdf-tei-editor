# Rename "Manage Users & Roles" menu entry

The Administration menu entry opening the RBAC manager was labelled "Manage Users & Roles", although the dialog also manages groups, collections and projects. Renamed to "Manage Access & Projects" (chosen by Christian, 2026-10-22).

Changes:

- `app/src/templates/rbac-manager-menu-item.html` - menu label
- `app/src/templates/rbac-manager-dialog.html` - dialog title (was "RBAC Management")
- `app/src/plugins.js` - comment
- `docs/user-manual/rbac-manager.md`, `docs/user-manual/user-management.md` - references to the old names

No tests referenced the label text.
