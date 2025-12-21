# User menu & form

GitHub Issue: https://github.com/mpilhlt/pdf-tei-editor/issues/143

Goal: Instead of the current "logout" button, implement a "user" button similar to `app/src/templates/backend-plugins-button.html` with a dropdown menu that contains the "Logout" option always as the last entry.

Implement this as a separate plugin `user-account.js` using the object-style plugin. Move the logout button from `app/src/plugins/authentication.js` to this plugin, using its API.

Then, implement a "User Profile" menu entry which opens a form to edit user data. The form replicates parts of the form in the `app/src/templates/rbac-manager-dialog.html` which is populated by `app/src/plugins/rbac-manager.js`. The user should be able to configure:

- full name
- email
- password (with a "repeat password" field to catch typos)

## Implementation Summary

Implemented user menu with dropdown containing "User Profile" and "Logout" options, replacing the previous standalone logout button.

### Backend Changes

- Added `/api/v1/users/me/profile` endpoint in [fastapi_app/routers/users.py:277](fastapi_app/routers/users.py#L277) for self-service profile updates
- Added `UpdateProfileRequest` model to allow users to update fullname, email, and password
- Regenerated API client to include the new endpoint

### Frontend Changes

- Created [app/src/plugins/user-account.js](app/src/plugins/user-account.js) - new class-based plugin for user account management
- Created [app/src/templates/user-menu-button.html](app/src/templates/user-menu-button.html) - dropdown menu with user icon
- Created [app/src/templates/user-profile-dialog.html](app/src/templates/user-profile-dialog.html) - dialog for editing user profile
- Removed logout button code from [app/src/plugins/authentication.js](app/src/plugins/authentication.js)
- Removed [app/src/templates/logout-button.html](app/src/templates/logout-button.html)
- Registered `UserAccountPlugin` in [app/src/plugins.js:50](app/src/plugins.js#L50)
- Added UI typedefs for `userMenuGroup` and `userProfileDialog` in [app/src/ui.js](app/src/ui.js)
- Updated [app/src/plugins/toolbar.js:37](app/src/plugins/toolbar.js#L37) to include user menu in toolbar typedef

### Test Updates

- Updated [tests/e2e/tests/helpers/login-helper.js:58](tests/e2e/tests/helpers/login-helper.js#L58) to use new user menu for logout
- Updated [tests/e2e/tests/auth-workflow.spec.js](tests/e2e/tests/auth-workflow.spec.js) to test user menu button instead of logout button

The user menu button is disabled when not logged in and enabled when authenticated. The profile dialog allows users to update their fullname, email, and password with client-side validation for password matching and minimum length.