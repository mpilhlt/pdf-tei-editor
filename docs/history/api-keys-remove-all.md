# Remove all API keys at once

Goal: let a user remove all API keys they have stored with one button in the "API Keys" dialog, after a confirmation.

## Implementation

### Backend

- `SecretStore.delete_all(username)` (`fastapi_app/lib/secrets/store.py`) deletes all rows of `user_secrets` with the given username and returns the number of removed keys. It also removes keys of services that are no longer registered (e.g. of an uninstalled plugin), which the dialog does not list.
- `DELETE /api/v1/secrets` (`fastapi_app/routers/secrets.py`) calls it with the username of the authenticated caller and returns `{"removed": <int>}`. The username comes only from the session, so other users' keys cannot be affected. The store holds only per-user keys; there are no shared keys in it.
- `apiClient.secretsDeleteAll()` in `app/src/modules/api-client-v1.js` with the `SecretsDeleteAllResponse` typedef.

### Frontend

- `removeAllBtn` ("Remove all keys", danger outline) in the footer of `app/src/templates/api-keys-dialog.html`.
- `ApiKeysPlugin#removeAll()` (`app/src/plugins/api-keys.js`) asks for confirmation through the `dialog` plugin (new dependency), calls the endpoint, reloads the service list and notifies with the number of removed keys.
- The button is hidden when the dialog prompts for a single missing key. It is enabled even if no listed key is set, because keys of uninstalled services are not listed.

### Tests

- `tests/unit/fastapi/test_user_secrets.py`: store and router tests, including that another user's keys (also of unregistered services) are untouched.
- `tests/api/v1/secrets.test.js`: live API test with two users; the test plugin (`tests/fixtures/plugins/test_plugin/plugin.py`) now registers the secret service `test-secret-service` for it.
- `tests/e2e/tests/api-keys-dialog.spec.js`: stores a key, cancels and then confirms "Remove all keys" in the dialog.
