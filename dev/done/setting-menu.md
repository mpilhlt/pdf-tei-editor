# Implement settings menu

**GitHub Issue:** https://github.com/mpilhlt/pdf-tei-editor/issues/134

## Status: Completed

The toolbar menu (created in [dev/todo/user-menu.md](dev/todo/user-menu.md)) now serves as the settings/utilities menu. It consolidates infrequently-used commands in a dropdown menu with a list icon.

## Implementation

Instead of creating a separate settings plugin, the existing toolbar menu was expanded to include:
- User Manual (info plugin)
- Manage Users & Roles (rbac-manager plugin, admin only)
- Garbage Collection (filedata plugin, admin only)
- User Profile (user-account plugin)
- Logout (user-account plugin)

This approach:
- Reduces UI clutter by consolidating related functions
- Uses a single, discoverable menu location
- Follows the same plugin pattern for all menu items
- Each plugin adds its menu items during the install phase

## Files Modified

- [app/src/plugins/toolbar.js](app/src/plugins/toolbar.js) - Creates toolbar menu
- [app/src/plugins/rbac-manager.js](app/src/plugins/rbac-manager.js) - Adds RBAC menu item
- [app/src/plugins/info.js](app/src/plugins/info.js) - Adds user manual menu item
- [app/src/plugins/filedata.js](app/src/plugins/filedata.js) - Adds garbage collection menu item
- [app/src/plugins/user-account.js](app/src/plugins/user-account.js) - Adds profile/logout menu items
- [app/src/plugins.js](app/src/plugins.js) - Controls menu item order via plugin registration order