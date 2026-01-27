# Securing the Server

This guide covers hardening a production deployment against automated vulnerability scanners and brute-force attacks. The application runs behind nginx on Ubuntu.

## Nginx: Blocking Scanner Traffic

Automated bots routinely probe web servers for `.env` files, PHP exploits, exposed Docker APIs, path traversal vulnerabilities, and other attack surfaces. Since this is a Python/FastAPI application, none of these apply, but the requests pollute logs and waste resources.

The solution uses nginx `map` directives to flag malicious requests, then drops the connection with `return 444` (no response body, no information leaked).

### Setup

Two files are needed:

**1. `/etc/nginx/conf.d/block-scanners.conf`**

This file lives in the `http` context and defines maps that flag requests:

```nginx
# block-scanners.conf
# Blocks automated vulnerability scanners and probes.

map $request_uri $block_scanner {
    default 0;

    # Dotfiles: .env, .git, .github, .gitlab, .travis, etc.
    ~*^/\.env                       1;
    ~*^/\.git                       1;
    ~*^/\.github                    1;
    ~*^/\.gitlab                    1;
    ~*^/\.travis                    1;
    ~*^/\.svn                       1;
    ~*^/\.hg                        1;
    ~*^/\.DS_Store                  1;
    ~*^/\.htaccess                  1;
    ~*^/\.htpasswd                  1;
    ~*^/\.well-known/security\.txt  0;  # allow security.txt (override)

    # Nested dotfiles in subdirectories
    ~*/\.env                        1;

    # PHP exploits
    ~*\.php($|\?)                   1;
    ~*\.asp($|\?)                   1;
    ~*\.aspx($|\?)                  1;
    ~*\.jsp($|\?)                   1;
    ~*\.cgi($|\?)                   1;

    # PHPUnit RCE (CVE-2017-9841)
    ~*phpunit                       1;

    # Composer vendor directory
    ~*/vendor/                      1;

    # ThinkPHP RCE
    ~*invokefunction                1;

    # Path traversal
    ~*\.\./                         1;

    # Docker API
    ~*^/containers/                 1;

    # Hikvision SDK
    ~*^/SDK/                        1;

    # Microsoft SSRS
    ~*^/ReportServer                1;

    # GeoServer
    ~*^/geoserver/                  1;

    # WordPress probes
    ~*^/wp-admin                    1;
    ~*^/wp-login                    1;
    ~*^/wp-content                  1;
    ~*^/wp-includes                 1;
    ~*^/xmlrpc\.php                 1;
}

# Block non-standard HTTP methods
map $request_method $block_method {
    default     0;
    PROPFIND    1;
    TRACE       1;
    TRACK       1;
    DELETE      1;
    CONNECT     1;
}
```

> **Note:** The `DELETE` method is blocked above. If the application uses DELETE requests from the browser, remove that line.

**2. `/etc/nginx/snippets/block-scanners-rule.conf`**

```nginx
if ($block_scanner) {
    return 444;
}

if ($block_method) {
    return 444;
}
```

**3. Activate in each server block:**

```nginx
server {
    # ...
    include /etc/nginx/snippets/block-scanners-rule.conf;
    # ...
}
```

Then reload nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### Why `return 444`

`444` is an nginx-specific code that closes the connection immediately with no response. This is preferable to returning a proper HTTP error because it wastes the scanner's time and leaks no server information.

### Limitation

nginx `map` directives must live in the `http` context (i.e., `conf.d/`), but `if` blocks must be inside `server` blocks. There is no way to inject rules globally from `conf.d/` alone — each server block needs the `include` line.

## fail2ban: Permanently Banning Repeat Offenders

fail2ban monitors log files and bans IPs that trigger too many failures. The configuration below uses permanent bans (no automatic unban).

### Install

```bash
sudo apt update && sudo apt install fail2ban -y
```

### Create the nginx scanner filter

`/etc/fail2ban/filter.d/nginx-scanner.conf`:

```ini
[Definition]
# Match 404/405 responses in nginx access log
failregex = ^<HOST> - .* "(GET|POST|PUT|PROPFIND|CONNECT|TRACE) .+" (404|405)
ignoreregex =
```

This assumes the default nginx log format (`$remote_addr - $remote_user ...`). Adjust the regex if using a custom format.

### Create the jail configuration

`/etc/fail2ban/jail.local`:

```ini
[DEFAULT]
# Permanent ban — never unban
bantime = -1

# IPs that should never be banned (space-separated)
ignoreip = 127.0.0.1/8 ::1

# Ban on all ports, not just the triggering port
banaction = iptables-allports

[sshd]
enabled = true
maxretry = 3
findtime = 600

[nginx-scanner]
enabled = true
filter = nginx-scanner
logpath = /var/log/nginx/access.log
maxretry = 3
findtime = 60
```

- **`bantime = -1`**: Permanent ban across all jails.
- **sshd**: 3 failed logins within 10 minutes triggers a permanent ban.
- **nginx-scanner**: 3 404/405 responses within 60 seconds triggers a permanent ban.

If you have per-vhost access logs, use a glob for `logpath`:

```ini
logpath = /var/log/nginx/*access*.log
```

### Enable and start

```bash
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

### Verify

```bash
# Check jail status
sudo fail2ban-client status
sudo fail2ban-client status nginx-scanner
sudo fail2ban-client status sshd

# Watch bans in real time
sudo tail -f /var/log/fail2ban.log
```

### Recovery

With permanent bans, the only way to unban an IP is manually:

```bash
sudo fail2ban-client set nginx-scanner unbanip <IP>
sudo fail2ban-client set sshd unbanip <IP>
```

Bans persist across reboots because fail2ban replays the log on startup and re-applies matching bans.

**Important:** Add any static IP you connect from to `ignoreip` to avoid locking yourself out of SSH. If you do get locked out, you need console or out-of-band access.

## Related Documentation

- [Deployment Guide](./deployment.md) — Container deployment and nginx setup
- [Nginx Cache Control](./nginx-cache-control.md) — API caching configuration
