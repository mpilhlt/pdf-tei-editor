#!/usr/bin/env python3
"""
Pre-generates the backend plugin sandbox client script at build time.

`generate_sandbox_client_script()` normally extracts the sandbox API by parsing
`app/src/modules/backend-plugin-sandbox.js` at runtime. In production, `app/src`
is removed after the frontend build (see Dockerfile), so that source file is no
longer available when a backend plugin page is requested. This script writes the
generated output to `app/web/sandbox-client.js`, which `generate_sandbox_client_script()`
falls back to when `app/src` is missing.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from fastapi_app.config import get_settings
from fastapi_app.lib.plugins.plugin_tools import generate_sandbox_client_script


def main() -> None:
    settings = get_settings()
    output_path = settings.project_root_dir / "app" / "web" / "sandbox-client.js"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(generate_sandbox_client_script(), encoding="utf-8")
    print(f"Wrote sandbox client script to {output_path}")


if __name__ == "__main__":
    main()
