# User menu & form

GitHub Issue: <https://github.com/mpilhlt/pdf-tei-editor/issues/143>

Goal: Instead of the current "logout" button, implement a "user" button similar to `app/src/templates/backend-plugins-button.html` with a dropdown menu that contains the "Logout" option always as the last entry.

Implement this as a separate plugin `user-account.js` using the object-style plugin. Move the logout button from `app/src/plugins/authentication.js` to this plugin, using its API.

Then, implement a "User Profile" menu entry which opens a form to edit user data. The form replicates parts of the form in the `app/src/templates/rbac-manager-dialog.html` which is populated by `app/src/plugins/rbac-manager.js`. The user should be able to configure:

- full name
- email
- password (with a "repeat password" field to catch typos)

## Implementation Summary

Implemented a generic toolbar menu containing infrequently-used commands: "User Manual", "Manage Users & Roles", "User Profile", and "Logout".

### Architecture Change

Created generic toolbar menu managed by toolbar plugin:

- Toolbar plugin creates the menu button with list icon in its `install()` lifecycle (moved to end in `start()`)
- Multiple plugins add their menu items during install phase:
  - Info plugin adds "User Manual"
  - RBAC manager plugin adds "Manage Users & Roles"
  - User-account plugin adds "User Profile" and "Logout"
- This design consolidates infrequently-used commands into one menu

### Backend Changes

- Added `/api/v1/users/me/profile` endpoint in [fastapi_app/routers/users.py:277](fastapi_app/routers/users.py#L277) for self-service profile updates
- Added `UpdateProfileRequest` model to allow users to update fullname, email, and password
- Regenerated API client to include the new endpoint

### Frontend Changes

**Toolbar Plugin:**

- Modified [app/src/plugins/toolbar.js](app/src/plugins/toolbar.js):
  - Creates `toolbarMenu` in `install()` at beginning of toolbar
  - Moves menu to end in `start()` after all plugins have added items
- Created [app/src/templates/toolbar-menu-button.html](app/src/templates/toolbar-menu-button.html) - dropdown with list icon
- Added `toolbarMenuPart` typedef documenting menu items added by various plugins

**User Account Plugin:**

- Created [app/src/plugins/user-account.js](app/src/plugins/user-account.js) as class-based plugin
- Created [app/src/templates/user-menu-items.html](app/src/templates/user-menu-items.html) - "User Profile" and "Logout" menu items
- Created [app/src/templates/user-profile-dialog.html](app/src/templates/user-profile-dialog.html) - dialog for editing user profile
- Uses `createFromTemplate()` to add menu items to toolbar menu during install
- Registered `UserAccountPlugin` in [app/src/plugins.js:49](app/src/plugins.js#L49)

**RBAC Manager Plugin:**

- Modified [app/src/plugins/rbac-manager.js](app/src/plugins/rbac-manager.js):
  - Moved from standalone button to menu item
  - Added `toolbar` dependency
  - Uses `createFromTemplate()` to add menu item during install
- Created [app/src/templates/rbac-manager-menu-item.html](app/src/templates/rbac-manager-menu-item.html)
- Removed [app/src/templates/rbac-manager-button.html](app/src/templates/rbac-manager-button.html)

**Info Plugin:**

- Modified [app/src/plugins/info.js](app/src/plugins/info.js):
  - Moved from standalone button to menu item
  - Added `toolbar` dependency
  - Uses `createFromTemplate()` to add menu item during install
- Created [app/src/templates/info-menu-item.html](app/src/templates/info-menu-item.html)
- Removed [app/src/templates/info-toolbar-button.html](app/src/templates/info-toolbar-button.html)

**Authentication Plugin:**

- Removed logout button code from [app/src/plugins/authentication.js](app/src/plugins/authentication.js)
- Removed [app/src/templates/logout-button.html](app/src/templates/logout-button.html)

### Test Updates

- Updated [tests/e2e/tests/helpers/login-helper.js:58](tests/e2e/tests/helpers/login-helper.js#L58) to use toolbar menu for logout
- Updated [tests/e2e/tests/auth-workflow.spec.js](tests/e2e/tests/auth-workflow.spec.js) to test toolbar menu button

### Menu Structure

The toolbar menu contains (in order):

1. User Manual (info plugin)
2. Garbage Collection (filedata plugin, admin only)
3. Manage Users & Roles (rbac-manager plugin, admin only)
4. User Profile (user-account plugin)
5. Logout (user-account plugin)

### Status

**Completed** - All buttons successfully moved to toolbar menu. The menu uses proper template registration and `createFromTemplate()` pattern for adding items.
