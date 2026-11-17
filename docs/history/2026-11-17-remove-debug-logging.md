# Remove debug logging (#366)

The save route (`fastapi_app/routers/files_save.py`) logged two `DEBUG:`-prefixed messages at INFO level around the `document.save` event:

```text
fastapi_app.routers.files_save - DEBUG: Emitting document.save event for mqe95c
fastapi_app.routers.files_save - DEBUG: Event emitted
```

- "Emitting document.save event for ..." now logs at DEBUG level, without the prefix.
- "Event emitted" is removed; it added nothing to the preceding message.

A search of `fastapi_app/`, `bin/`, the frontend sources and mpilhlt/pte-plugins found no other INFO or WARNING messages marked as debug output.
