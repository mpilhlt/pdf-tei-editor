# Implement settings menu

**GitHub Issue:** https://github.com/mpilhlt/pdf-tei-editor/issues/134

- Siminarly to the "Plugins" menu in the application toolbar, implement a "Settings" plugin with adds a button group containing a split button with a dropdown. 
- In `app/src/plugins/rbac-manager.js`,  make the plugin depend on the settings plugin. and convert the "Manage Users.." button into a menu entry in the settings menu.
- Implement option 1 of `dev/todo/gc.md` by addings an admin-role-only menu item for garbabe collection