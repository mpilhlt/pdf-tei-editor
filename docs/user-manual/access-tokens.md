# Personal Access Tokens

Scripts and other non-interactive clients (`bin/batch-extract.js`, `bin/manage-remote.js`, `scripts/dev/debug-api.js`, the auto-annotation plugin's client) can authenticate with a personal access token instead of a username and password. A token can be revoked at any time without changing a password, expires after a set time, and does not put a person's password into configuration files or CI secrets.

## Creating a token

Reviewers and administrators open **user menu > Access Tokens**. The dialog lists the tokens you can see and has a "New token" form:

- **Label**: what the token is for, e.g. "batch extraction on the lab server".
- **User**: the user the token authenticates as. It is only shown if you may create tokens for more than one user.
- **Expires**: 7, 30, 90 (default) days or 1 year. Administrators can also choose "No expiry" if `auth.access-tokens.allow-no-expiry` is enabled.

After **Create token**, the token (`pte_...`) is shown once, together with a line for a `.env` file. Copy it right away: it is stored only as a hash and cannot be shown again.

A token has no roles of its own. It acts with the current roles and groups of its user, so removing a role from the user also takes it away from the token.

### Who may create tokens for whom

| User | May create tokens for | Sees and may revoke |
| --- | --- | --- |
| Administrator | any user | all tokens |
| Reviewer | themselves, and users whose roles are a subset of their own (never a user with `admin`, `backup` or `restore` unless the reviewer has that role too) | tokens they created, and tokens for themselves |
| Other users | nobody (the menu entry is hidden) | tokens for themselves |

Changes made with a token are recorded as changes by the token's user, for example in the revision history of a document. If a script should not appear as a real person, create a dedicated user for it (e.g. `auto-annotation` with the `reviewer` role) and create the token for that user.

## Using a token

Put the token in the `.env` file from which you run the scripts:

```env
API_TOKEN=pte_abcdefgh_...
API_BASE_URL=https://pdf-tei-editor.example.org
```

The bundled scripts use `API_TOKEN` (or the `--token` option) if it is set, and fall back to `API_USER`/`API_PASSWORD` otherwise.

Other clients exchange the token for a session and then send the session ID as usual:

```bash
curl -X POST -H "Authorization: Bearer $API_TOKEN" https://pdf-tei-editor.example.org/api/v1/auth/token-login
# => {"username": "...", "roles": [...], "sessionId": "..."}
curl -H "X-Session-ID: <sessionId>" https://pdf-tei-editor.example.org/api/v1/auth/status
```

A session created from a token ends when the token is revoked or expires, or after the usual inactivity timeout.

## Revoking a token

Click **Revoke** next to the token in the dialog. Scripts using it can no longer log in, and their current sessions end. Deleting a user revokes all of the user's tokens. Revoked tokens, and tokens that expired more than 30 days ago, are removed by garbage collection.

On the server, administrators can also manage tokens without the web interface, e.g. to create the first token of a container setup (see [CLI](cli.md#personal-access-tokens)).

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `auth.access-tokens.max-days` | `365` | Maximum validity of tokens created by non-administrators |
| `auth.access-tokens.allow-no-expiry` | `false` | Whether administrators may create tokens that do not expire |
| `auth.login.max-failures` | `10` | Failed logins allowed within the window before further attempts are refused (HTTP 429); counted per client address and user for password logins and per client address for token logins; `0` disables the limit |
| `auth.login.failure-window` | `300` | Window in seconds for `auth.login.max-failures` |
