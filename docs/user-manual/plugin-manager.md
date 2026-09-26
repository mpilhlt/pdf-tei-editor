# Plugin Manager

The plugin manager lets administrators see which plugins are installed and switch them on or off without restarting the server. It is only available to users with the admin role and is opened via the left "Tools" dropdown menu, under "Administration" > "Manage Plugins".

## The plugin list

Each row shows:

- a switch to enable or disable the plugin,
- the name, version and status of the plugin,
- a short description and, if the plugin is not active, the reason,
- the plugins it **requires** and the plugins that **require it** (click a name to jump to that plugin),
- the category, whether the plugin is built in or external, the number of menu items it adds, and whether it ships a frontend extension,
- a **README** button linking to the plugin's documentation on GitHub (if available).

Use the search field and the status chips at the top to filter the list.

## Status

| Status | Meaning |
| --- | --- |
| Active | The plugin is running. |
| Disabled | An administrator switched the plugin off. |
| Inactive | The plugin is not disabled, but a plugin it requires is not active. It returns automatically when the required plugin is enabled. |
| Unavailable | The plugin cannot run in this installation, e.g. because an API key or configuration is missing. The reason is shown in the row. |
| Failed | The plugin could not be loaded or started. The error is shown in the row and logged. |

## Disabling and enabling

- Disabling a plugin that other plugins depend on opens a confirmation listing the plugins that will be deactivated as well.
- Enabling a plugin whose required plugins are disabled asks whether to enable those, too.
- Plugins marked **Protected** (for example the log viewer and backup tools) cannot be disabled.
- Data created by a plugin is never deleted when it is disabled.

Changes take effect on the server immediately. Pages that are already open keep their old menus until they are reloaded; the dialog offers a **Reload now** button after each change. Requests to a disabled plugin fail with "not found".

The state is stored in the configuration key `plugins.disabled`, which is managed by the plugin manager and therefore not shown in the configuration editor.
