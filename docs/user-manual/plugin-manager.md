# Plugin Manager

The plugin manager lets administrators see which plugins are installed and switch them on or off without restarting the server. Which plugins are installed is decided when the editor is installed or its Docker image is built (see [Plugins in the image](docker-deployment.md#plugins-in-the-image)); if the operator allows it, administrators can also install plugins from GitHub releases in the plugin manager (see [Installing plugins](#installing-plugins)). It is only available to users with the admin role and is opened via the left "Tools" dropdown menu, under "Administration" > "Manage Plugins".

## The plugin list

Each row shows:

- a switch to enable or disable the plugin,
- the name, version and status of the plugin,
- a short description and, if the plugin is not active, the reason,
- the plugins it **requires** and the plugins that **require it** (click a name to jump to that plugin),
- the category, whether the plugin is built in, external or installed in the plugin manager (with the repository and release), the number of menu items it adds, and whether it ships a frontend extension,
- a **README** button linking to the plugin's documentation on GitHub (if available),
- a **Remove** button for plugins installed in the plugin manager.

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

Changes take effect on the server immediately. When the server runs several processes (as in production), the other processes follow within a few seconds; until then the dialog shows "Applying the change to all server processes". Other open pages reload automatically once all server processes have the change, and then show a message that the plugins were changed. Your own page reloads when you close the plugin manager, so you can make several changes in a row; the dialog also offers a **Reload now** button after each change. Requests to a disabled plugin fail with "not found".

The state is stored in `data/db/plugins-state.json`. Older versions stored it in the configuration key `plugins.disabled`; it is moved to the new file on the first start.

## Installing plugins

Installing a plugin installs code that runs on the server with access to all documents, users and stored credentials. The feature is therefore off by default and enabled by the operator of the server, not by an administrator account: it requires the environment variable `PTE_PLUGIN_INSTALL=1` (see [Runtime plugin install](docker-deployment.md#runtime-plugin-install)). When it is enabled, the plugin manager has an **Available** tab.

The **Available** tab lists the plugins of the plugin repositories: [mpilhlt/pte-plugins](https://github.com/mpilhlt/pte-plugins) by default, and the GitHub repositories with the topic `pte-plugin`. The list is read from GitHub and cached for an hour; **Refresh** reads it again. Each entry shows the latest release, whether the plugin is installed and an update is available, and why it cannot be installed (for example, it needs a newer editor or Python packages that are not installed on the server).

- **Trusted** plugins come from the owners listed in `PTE_PLUGIN_TRUSTED_OWNERS` (default: `mpilhlt`). Plugins of other owners are marked **Unverified**: anyone can give a GitHub repository the `pte-plugin` topic. Installing an unverified plugin requires typing the repository name to confirm.
- Only GitHub **releases** are installed: the release's wheel is downloaded and its checksum verified against the release's `SHA256SUMS` file. Nothing of the plugin runs during installation.
- A plugin can be installed only if the Python packages it needs are already installed on the server. Other plugins must be installed when the editor is installed or the Docker image is built.
- A newly installed plugin is **disabled**. Its code is loaded when you enable it in the **Installed** tab; it is available immediately, without a restart.

### Upgrading and removing

**Upgrade to v…** in the **Available** tab installs a newer release, also of plugins that were installed with the editor. **Remove** in the **Installed** tab disables a plugin installed in the plugin manager and deletes its files at the next restart.

Python code that is already loaded cannot be replaced in a running server. After an upgrade or removal of a plugin that is in use, the plugin shows **Restart pending** and the dialog shows **Apply plugin changes**, which restarts the server processes one after the other. Requests are still answered during the restart, but jobs running in a restarting process (for example a batch extraction) are interrupted, and open pages reload once all processes run the new code. The button is offered when the server was started with `bin/start-prod` (as in the Docker image); otherwise restart the server.

Installed plugins are stored in `data/plugins/site/`, and all plugin changes are recorded in the audit log `data/db/plugin-audit.jsonl`. The same operations are available on the command line: `npm run manage-remote -- plugin list|available|install|enable|disable|remove|apply` (see [manage-remote](cli-manage-remote.md#plugin-commands)).
