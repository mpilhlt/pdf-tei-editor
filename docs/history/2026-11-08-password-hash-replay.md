# Password login without a replayable hash (#246)

Issue [#246](https://github.com/mpilhlt/pdf-tei-editor/issues/246) item 2: the login dialog and the scripts sent the SHA-256 hash of the password to `/api/v1/auth/login`, and the server compared it with the SHA-256 hash stored in `users.json`. The hash was therefore the credential: anyone who obtained it (from a log, a backup, a copy of `users.json`, or by intercepting a request) could log in without knowing the password. CodeQL flagged the client-side hashing as "password hash with insufficient computational effort" (`bin/lib/api-auth.js`, PR #710).

## Change

- Clients send the plain text password (`{"username": ..., "password": ...}`), as the user management dialogs already did when setting a password. HTTPS protects it in transit.
- The server stores `scrypt$<n>$<r>$<p>$<salt>$<hash>` in `passwd_hash`: scrypt (n=2^14, r=8, p=1, 16-byte random salt) over the SHA-256 hex digest of the password (`fastapi_app/lib/utils/password_hash.py`). Verification runs in a thread pool, since scrypt takes tens of milliseconds of CPU time.
- `passwd_hash` in a login request is refused with HTTP 400 and a message that names `password` and the token login. Accepting it would keep the hash usable as a credential.
- Scripts should still prefer personal access tokens (#709).

## Migration

The SHA-256 pre-hash makes the migration possible without the passwords: at startup, after the database is initialized, `upgrade_stored_hashes()` replaces each bare SHA-256 digest in `users.json` with scrypt over that digest, and the same password verifies against it. Users keep their passwords. The file is written atomically.

The verifier still accepts a bare SHA-256 digest as the stored value (comparing it with the SHA-256 of the sent password), for `users.json` files edited by hand or restored from an old backup before the next restart. The digest itself is not accepted as a password.

Clients outside this repository that send `passwd_hash` must be updated. The auto-annotation client in `mpilhlt/pte-plugins` sends the password and falls back to the hash on HTTP 422, which older servers return for a request without `passwd_hash`.

## Not covered

Items 1 and 3 of #246 (session IDs in URL query parameters, session binding) are unchanged. A challenge-response login (issue option A) was not used: it would require the server to keep a password-equivalent secret, which is the weakness this change removes from `users.json`.
