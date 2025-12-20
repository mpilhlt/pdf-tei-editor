# Config-editor

**GitHub Issue:** https://github.com/mpilhlt/pdf-tei-editor/issues/136

Depends on `dev/todo/setting-menu.md`

Implement an plugin providing an editor for configuration values similar to the Firefox one.

- It must only be accessible to the admin role
- The configuration editor is opened via an entry in the settings menu.
- It works with the config API of the backend (`fastapi_app/api/config.py`)