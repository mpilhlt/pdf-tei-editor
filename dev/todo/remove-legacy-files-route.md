# Remove Legacy /api/files Route

## Background

The backwards compatibility router at `/api/files/{document_id}` was added to support legacy frontend code that hasn't been updated to use the versioned `/api/v1/files/{document_id}` endpoint.

## Current Implementation

In [fastapi_app/main.py:222-227](../../fastapi_app/main.py#L222-L227), the legacy route is mounted:

```python
# Backwards compatibility: Mount files_serve at /api/files for legacy frontend code
# This is mounted AFTER plugin routes to ensure /api/plugins/* routes take precedence
# over the catch-all /{document_id} route
api_compat = APIRouter(prefix="/api")
api_compat.include_router(files_serve.router)
app.include_router(api_compat)
```

## Issue

The `/api/files/{document_id}` catch-all route can potentially interfere with other `/api/*` routes. It's currently mounted AFTER plugin routes to ensure plugin routes at `/api/plugins/*` take precedence, but this is fragile.

## Task

1. Search frontend code for uses of `/api/files/` endpoint
2. Update all references to use `/api/v1/files/` instead
3. Remove the api_compat router from main.py (lines 222-227)
4. Test that file serving still works through the versioned endpoint

## Files to Check

- `app/src/**/*.js` - Search for API calls to `/api/files/`
- Any fetch/axios calls that construct URLs with `/api/files/`
- The API client in `app/src/plugins/client.js`

## Testing

After making changes:
- Verify PDF files load correctly in the viewer
- Verify XML files load in the editor
- Verify file downloads work
- Run E2E tests to catch any remaining references
