# Backup & Restore Plugin

The plugin downloads a backup of the application data as a ZIP file and restores the application from such a backup. Backups can be made by hand in the web interface or automatically with the script `bin/backup-download.js`.

- [Part 1: Manual backup and restore (web interface)](#part-1-manual-backup-and-restore-web-interface)
- [Part 2: Automated backups (API and cron script)](#part-2-automated-backups-api-and-cron-script)

## What a backup contains

A backup contains the two directories that hold all persistent data:

- `db/`: users, groups, roles, collections, configuration and the file metadata database
- `files/`: all uploaded and generated documents (PDF and XML)

It does not contain caches, temporary files or plugin working data. These are rebuilt by the application.

A backup contains password hashes and configuration values such as API keys. Store backups as carefully as the live data.

## Roles

Access is controlled by two roles that are independent of each other:

| Role | Allows |
| --- | --- |
| `backup` | Downloading backups |
| `restore` | Restoring from a backup |

Users with the `admin` role (or the wildcard role `*`) have both. Assign `backup` or `restore` to other users in the user management to delegate these tasks without giving them admin rights. The roles are created automatically when the plugin starts.

Be aware of what each role means:

- `backup` gives read access to all data, including password hashes.
- `restore` is equivalent to `admin`: a restored backup can contain any user account, including administrators. Give it only to people you would trust with admin rights.

---

## Part 1: Manual backup and restore (web interface)

### Open the plugin

Open **Backup & Restore** from the plugins menu (category "Administration"). The dialog shows only the sections your roles permit: *Download Backup* needs `backup`, *Restore from Backup* needs `restore`.

### Make a backup

1. Click **Download Backup**.
2. Wait while the server prepares the file. For large collections this can take a while; the browser starts the download when it is ready.
3. Your browser saves a file named `backup_YYYYMMDD_HHMMSS.zip` to its download folder.

The application stays usable while the backup is created, and the backup is consistent even if users are working at that moment. Only one backup is created at a time: if someone else (or the scheduled script) is currently making one, you get an error message. Wait a minute and try again.

Keep the file somewhere other than the server itself, for example on a different machine or in your institution's storage.

### Restore a backup

Restoring replaces **all** current data with the contents of the backup. Changes made after the backup was taken are lost to the running application (see "What happens to the old data" below).

1. Make a fresh backup of the current state first, unless you are sure you do not need it.
2. Tell users to save their work. They will be interrupted.
3. Open the plugin and click **Upload & Restore**.
4. Select the backup ZIP file. The file must contain at least `db/users.json` and `db/config.json`. A missing `db/metadata.db` only produces a warning.
5. The server checks and unpacks the file, then:
   - On a server that runs under a supervisor (Docker, systemd and similar), it switches all open sessions to a maintenance screen and restarts itself after about 10 seconds. The restored data is active when it comes back.
   - On a server without a supervisor, the message "Please restart the server manually to apply the restore" appears. The restore is applied at the next start.

After the restart, log in and check that your documents and users are as expected. Note that user accounts and passwords are also restored, so use the login of the backup, not the one from before.

#### What happens to the old data

The previous data directory is not deleted. At startup it is renamed to `data_YYYYMMDD_HHMMSS` next to `data/` in the application directory. This allows you to undo a wrong restore by an administrator with server access (stop the server, rename the directories back). Delete these directories manually when you no longer need them: they use as much disk space as the data itself.

#### Troubleshooting

| Message | Cause |
| --- | --- |
| "The 'backup' role is required" / "The 'restore' role is required" | Your user lacks the role. Ask an administrator. |
| "Another backup is already in progress" | Another download is running. Try again shortly. |
| "Invalid ZIP file" | The file is damaged or not a backup. Download or copy it again. |
| "ZIP is missing required files" | The ZIP was not created by this plugin, or is incomplete. |
| "Invalid or expired session" | Log in again and reopen the plugin. |

---

## Part 2: Automated backups (API and cron script)

This part is for technical administrators with shell access to a machine that can reach the server. It assumes basic knowledge of cron or systemd timers.

### Overview

`bin/backup-download.js` is a Node.js script that, on every run:

1. logs in as a dedicated user,
2. downloads a backup through the API,
3. verifies the download (size, SHA-256 checksum, valid ZIP with the required files),
4. stores it under a timestamped name and
5. deletes old backups according to a retention policy.

It runs from the application directory (`node bin/backup-download.js`) and needs no additional packages. It can run on the server itself or on any other machine that has a copy of the repository or the Docker image and network access to the server. For Docker deployments, run it on the host against the published port and write to a bind-mounted or host directory.

### Set up the backup bot user

Use a dedicated user for the job, with the `backup` role and nothing else. Do not use a personal or an admin account: a bot account with the minimum role limits the damage if its password leaks, and can be disabled without affecting people.

#### With the command line

Run this as an administrator (the credentials in your `.env`, see `bin/manage-remote.js --help`):

```bash
# Generate a long random password and store it in a file only the cron user can read
sudo install -d -m 0750 -o backup /etc/pdf-tei-editor
openssl rand -base64 32 | sudo -u backup tee /etc/pdf-tei-editor/backup.pw > /dev/null
sudo chmod 0400 /etc/pdf-tei-editor/backup.pw

# Create the user with only the backup role
node bin/manage-remote.js user add backup-bot \
  --fullname "Backup bot" \
  --password "$(sudo cat /etc/pdf-tei-editor/backup.pw)" \
  --roles backup
```

The password is briefly visible in the process list during the second command; run it on a machine you trust, or create the user in the web interface instead.

#### With the web interface

Open the user management as an administrator, create a user `backup-bot`, set a long random password and give it the role `backup` only (not `user`, `admin` or any other role). Save the password into the password file as above.

#### Check the setup

```bash
node bin/backup-download.js --dest-dir /var/backups/pdf-tei-editor \
  --base-url https://editor.example.org --user backup-bot \
  --password-file /etc/pdf-tei-editor/backup.pw --dry-run
```

`--dry-run` prints what would happen without contacting the server. Run it without `--dry-run` once by hand to check the login and the download. A wrong password or missing role gives exit code 2.

### Schedule it

Example `/etc/cron.d/pdf-tei-editor-backup` (daily at 02:17, run as the user `backup`):

```bash
MAILTO=admin@example.org
17 2 * * * backup cd /opt/pdf-tei-editor && node bin/backup-download.js --dest-dir /var/backups/pdf-tei-editor --base-url https://editor.example.org --user backup-bot --password-file /etc/pdf-tei-editor/backup.pw --quiet --ping-url https://hc-ping.com/YOUR-UUID
```

With `--quiet` the script prints only errors, so cron sends mail only when something went wrong.

Alternatively, put the settings into a `.env` file and pass `--env /path/to/backup.env`:

```text
API_BASE_URL=https://editor.example.org
API_USER=backup-bot
```

The password should still come from `--password-file`; `API_PASSWORD` in an `.env` file also works but is easier to leak.

### Options

| Option | Default | Purpose |
| --- | --- | --- |
| `--dest-dir <dir>` | required | Target directory, created with mode 0700 if missing |
| `--env <path>` | `./.env` | `.env` file with `API_BASE_URL`, `API_USER`, `API_PASSWORD` |
| `--base-url <url>` | `API_BASE_URL` or `http://localhost:8000` | Server URL |
| `--user <name>` | `API_USER` | Username |
| `--password-file <path>` | `API_PASSWORD` | File containing the password |
| `--prefix <str>` | `pdf-tei-editor` | File name prefix. Use different prefixes for several instances in one directory. |
| `--keep-last <n>` | 7 | Always keep the newest n backups |
| `--keep-days <n>` | 30 | Delete backups older than n days, but never below `--keep-last` |
| `--keep-weekly <n>` | 0 | Additionally keep the newest backup of each of the n most recent ISO weeks that have backups |
| `--keep-monthly <n>` | 0 | Additionally keep the newest backup of each of the n most recent months that have backups |
| `--min-size <bytes>` | 1024 | Reject (and delete) smaller downloads |
| `--retries <n>` | 3 | Retries on network errors, 5xx and 409, with waits of 5 s, 15 s and 45 s |
| `--timeout <sec>` | 3600 | Timeout per attempt |
| `--ping-url <url>` | none | Monitoring URL: GET on success, `<url>/fail` on failure |
| `--dry-run` | off | Show what would be downloaded and deleted, change nothing |
| `--quiet` | off | Print only errors |

#### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Download or verification failed |
| 2 | Authentication or authorization failed (wrong password, user lacks the `backup` role) |
| 3 | Another run is still active (lock file) |
| 4 | Invalid arguments, or the destination is not usable |

### File names and retention

Files are named `<prefix>_<YYYYMMDDTHHMMSSZ>.zip` with the time in UTC, for example `pdf-tei-editor_20261003T021700Z.zip`. The names sort chronologically, and the age used for retention comes from the name, not from the file's modification time, so copying the directory does not reset the age.

What is kept is the union of:

- the newest `--keep-last` backups,
- all backups younger than `--keep-days`,
- the weekly and monthly backups if configured.

Everything else that matches the file name pattern is deleted. A reasonable policy for a daily job is `--keep-last 7 --keep-days 14 --keep-weekly 8 --keep-monthly 12`.

Safety properties:

- A download is first written to a hidden `.<name>.part` file and renamed only after it passed verification. A partial or failed download never has a final name.
- Old backups are deleted only after a successful, verified download. A server outage cannot delete your last good backups.
- The newest backup is never deleted.
- Files that do not match `<prefix>_<timestamp>.zip` are never touched.
- A lock file `.backup-download.lock` in the destination prevents overlapping runs.
- Backup files are created with mode 0600.

### Use the API directly

The script is a thin client for these endpoints. You can call them from other tools.

| Method and path | Role | Purpose |
| --- | --- | --- |
| `POST /api/v1/auth/login` | none | Log in; body `{"username": "...", "passwd_hash": "<SHA-256 hex of the password>"}`; returns `sessionId` |
| `GET /api/plugins/backup-restore/download` | `backup` | Download the backup ZIP |
| `POST /api/plugins/backup-restore/restore` | `restore` | Upload a ZIP (multipart field `file`) and schedule the restore |
| `POST /api/v1/auth/logout` | session | End the session |

Send the session id in the `X-Session-ID` header. The download response contains these headers for verification: `Content-Length` and `X-Content-SHA256` (hex SHA-256 of the ZIP). The download returns 403 if the user lacks the `backup` role and 409 if another backup is running.

Example with `curl`:

```bash
BASE=https://editor.example.org
HASH=$(tr -d '\n' < /etc/pdf-tei-editor/backup.pw | sha256sum | cut -d' ' -f1)
SID=$(curl -fsS -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"backup-bot\",\"passwd_hash\":\"$HASH\"}" | python3 -c 'import sys,json; print(json.load(sys.stdin)["sessionId"])')
curl -fsS -D headers.txt -o backup.zip -H "X-Session-ID: $SID" "$BASE/api/plugins/backup-restore/download"
grep -i '^x-content-sha256' headers.txt
sha256sum backup.zip
curl -fsS -X POST -H "X-Session-ID: $SID" "$BASE/api/v1/auth/logout"
```

If you write your own client, do the verification and the atomic rename that the script does, and prune only after success.

### Restoring from an automated backup

Restoring is deliberately not automated. Use the web interface as described in Part 1 with a user that has the `restore` role, or call the restore endpoint as an administrator. After a restore, the bot user exists only if it existed when the backup was made.

### Good practice

- **Keep a copy off the server.** A backup on the same disk does not protect against disk failure, deletion or ransomware. Copy the destination directory to another system with `rclone`, `restic` or `rsync` (3 copies, 2 media, 1 off-site). Encrypt the off-site copy; `restic` and `rclone crypt` do this.
- **Test restores.** An untested backup is not a backup. Restore one to a scratch instance regularly, for example every quarter.
- **Monitor.** A failure mail is easy to overlook. Use `--ping-url` with a dead-man's-switch service (for example healthchecks.io), or alert when the newest file is older than 36 hours.
- **Use HTTPS.** The password hash sent at login is equivalent to the password.
- **Schedule off-peak.** The backup reads all files on disk; run it at night.
- **Protect the credentials.** Keep the password file readable only by the cron user (mode 0400) and rotate it when staff changes.
- **Size the retention to detection time.** Keep backups at least as long as it could take you to notice a problem with the data.
