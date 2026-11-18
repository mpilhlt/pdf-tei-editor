# Plugin update alert and "Upgrade installed" (issue #825)

## Behaviour

- After an admin logs in (or a page opens with an admin session), `plugin-admin` checks for updates once per page and user: it reads the plugin list and, if runtime install is enabled (`install_enabled`), the available plugins (`GET /plugins/admin/available`, cached on the server for an hour). Installed plugins with `update_available` and `installable` are listed in a toast (`plugin-admin-update-alert.html`) with an "Open plugin manager" button that opens the dialog on the "Available" tab. Failures are logged, not shown.
- The "Available" tab has an "Upgrade installed" button, shown while such plugins exist. It asks for confirmation (with the versions; typing `upgrade` if one comes from an untrusted owner), then upgrades the plugins one after the other through the existing install endpoint and reports the result in one message.

## Decisions

- No new backend endpoint: the bulk upgrade loops over `POST /plugins/admin/install` in the client, which keeps per-plugin spinners and errors and reuses the install checks.
- The check runs in the browser on login, not at server start, since only a logged-in admin can be informed. It is not repeated within a page; it runs again on the next page load.
- Plugins of untrusted owners are included in the bulk upgrade (the admin confirmed the source when installing them) but require typing `upgrade`.
