# Dashboard not shown when opened with a document link

Issue #820: if the application is loaded with `pdf` or `xml` in the URL hash, the intention is to show that document directly, so the dashboard must not open after login.

## Implementation

- `DashboardExtension` reads the URL hash on construction, as it already did for `#plugin=...` links. Extensions are constructed in `app.js` before the application state is initialized, so the hash still holds what the link contained and not the restored last document that `url-hash-state` writes later.
- If `pdf` or `xml` is present, `#showAfterLogin()` marks the login session as shown without opening the dialog, so a reload within the session does not open it either.
- A later login while the app runs (`onSessionIdChange`) still shows the dashboard: the flag only reflects how the page was loaded, and a re-login is not following a link.

## Tests

`fastapi_app/plugins/dashboard/tests/show-after-login.test.js` covers `#pdf=…&xml=…`, `#xml=…` and `#pdf=…`.
