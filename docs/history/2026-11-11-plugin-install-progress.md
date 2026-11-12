# Plugin install progress on the install button

## Problem

In the plugin manager's "Available" tab, the "Installed <plugin> v<version>" toast appeared while the list was still being refreshed, and the Install/Upgrade button stayed enabled until the refreshed list hid it. Installs of plugins with large dependencies take 30 seconds or more, so the button could be clicked again and the toast announced a state the list did not show yet.

## Change

`app/src/plugins/plugin-admin.js`:

- `#installing` holds the keys (`repository#id`) of running installs. `#availableRowHtml()` renders their buttons with `loading disabled`, so the spinner survives re-renders (e.g. typing in the search field). The click handler ignores disabled buttons and `#install()` ignores a plugin that is already being installed.
- `#install()` keeps the outcome message, waits for `#refreshAll()`, clears the spinner and only then shows the success or error toast.

`tests/e2e/tests/plugin-admin.spec.js`: the install test holds the mocked install response and checks that the button is loading and disabled and that no toast is shown until the response is released.
