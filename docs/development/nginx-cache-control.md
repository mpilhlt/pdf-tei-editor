# Nginx Cache Control Configuration

## Issue

When the application is deployed behind an nginx reverse proxy, file content changes may not be reflected after saving due to nginx caching responses (issue #114).

**Symptoms:**

- Works correctly with direct uvicorn server (localhost)
- Fails when accessed through nginx reverse proxy
- Old file content is served even after saving changes
- Processing instructions (xml-model) added via TEI Wizard disappear after navigation

**Root Cause:**

- Backend sets proper Cache-Control headers (`no-cache, no-store, must-revalidate`)
- Nginx reverse proxy may ignore or override these headers
- Nginx caches responses by default unless explicitly configured not to

## Solution

Add a specific location block for `/api/` that disables nginx caching for all API endpoints and ensures Cache-Control headers are passed through.

### Configuration

Add this location block **before** the general `location /` block in your nginx configuration:

```nginx
# API endpoints - must not be cached by nginx (fixes #114)
location /api/ {
    proxy_pass http://127.0.0.1:8010;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;

    # Disable nginx caching - respect backend Cache-Control headers
    proxy_cache off;
    proxy_buffering off;
    proxy_no_cache 1;
    proxy_cache_bypass 1;

    # Ensure Cache-Control headers from backend are passed through
    proxy_pass_header Cache-Control;
    proxy_pass_header Pragma;
    proxy_pass_header Expires;

    # Reinforce cache headers at proxy level
    add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    add_header Pragma "no-cache" always;
    add_header Expires "0" always;
}
```

### Key Directives Explained

- `proxy_cache off` - Disables nginx's proxy caching
- `proxy_buffering off` - Disables response buffering (helps with streaming responses)
- `proxy_no_cache 1` - Prevents caching even if cache is enabled globally
- `proxy_cache_bypass 1` - Bypasses cache for this location
- `proxy_pass_header` - Ensures backend headers are passed through
- `add_header ... always` - Adds headers to all responses (including errors)

### Deployment Steps

1. **Backup current configuration:**

   ```bash
   sudo cp /etc/nginx/sites-available/pdf-tei-editor-dev /etc/nginx/sites-available/pdf-tei-editor-dev.backup
   ```

2. **Update nginx configuration:**

   ```bash
   sudo nano /etc/nginx/sites-available/pdf-tei-editor-dev
   ```

   Add the location block from above **before** the `location /` block.

3. **Test configuration:**

   ```bash
   sudo nginx -t
   ```

4. **Reload nginx:**

   ```bash
   sudo systemctl reload nginx
   ```

5. **Verify the fix:**
   - Open a file in the editor
   - Make a change (e.g., add xml-model PI via TEI Wizard)
   - Save the file
   - Navigate to another file
   - Navigate back
   - Verify the changes are still present

### Reference Configuration

See [nginx-dev.conf](../../nginx-dev.conf) for a complete example configuration.

## Testing

To verify cache headers are working correctly:

```bash
# Check headers from your server
curl -I https://pdf-tei-editor-dev.panya.de/api/files/{stable_id}
```

Expected headers:

```
Cache-Control: no-cache, no-store, must-revalidate
Pragma: no-cache
Expires: 0
```

## Alternative: Disable Caching Globally

If you want to disable caching for all API endpoints:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8010;
    # ... (same proxy settings as above)
    proxy_cache off;
    proxy_buffering off;
    # ... (same cache headers as above)
}
```

This is simpler but may impact performance for endpoints that could benefit from caching.

## See Also

- [Issue #114](https://github.com/user/repo/issues/114) - File content not persisting after save
- [fastapi_app/routers/files_serve.py](../../fastapi_app/routers/files_serve.py) - Backend cache headers
- [tests/api/v1/files_serve_caching.test.js](../../tests/api/v1/files_serve_caching.test.js) - Caching behavior test
