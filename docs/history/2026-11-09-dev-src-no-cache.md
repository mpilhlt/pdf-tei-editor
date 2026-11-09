# Dev mode: revalidate source files on every load

After the "Delete current version with its history" entry was added, a browser loaded the new `document-actions.js` but an old cached `document-action-buttons.html`, so `da.deleteVersionHistory` was undefined during `install()`.

Cause: in development mode, `/src` was served by `StaticFiles` without a `Cache-Control` header. Browsers then cache responses heuristically (a fraction of the time since `Last-Modified`), so a template that had not changed for months could be reused for days, while recently changed modules were refetched.

Fix: `fastapi_app/main.py` mounts `/src` with a `StaticFiles` subclass that adds `Cache-Control: no-cache`. The browser revalidates each file with its ETag and gets a `304` when it is unchanged.
