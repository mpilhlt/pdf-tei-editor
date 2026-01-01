#!/usr/bin/env python3
"""
Generate machine-readable JSON documentation for Python modules.

This extracts class and function signatures from docstrings for AI code assistants.
"""

import json
import inspect
import importlib
import pkgutil
import sys
from pathlib import Path
from typing import Any
from datetime import datetime

# Add project root to path so fastapi_app can be imported
sys.path.insert(0, str(Path(__file__).parent.parent))


def extract_module_api(module_name: str) -> dict[str, Any]:
    """Extract API information from a module."""
    module = importlib.import_module(module_name)

    api = {
        "module": module_name,
        "doc": inspect.getdoc(module),
        "classes": {},
        "functions": {}
    }

    for name, obj in inspect.getmembers(module):
        if name.startswith("_"):
            continue

        if inspect.isclass(obj) and obj.__module__ == module_name:
            api["classes"][name] = {
                "doc": inspect.getdoc(obj),
                "methods": {}
            }

            for method_name, method in inspect.getmembers(obj, inspect.isfunction):
                if method_name.startswith("_") and method_name not in ["__init__"]:
                    continue

                sig = inspect.signature(method)
                api["classes"][name]["methods"][method_name] = {
                    "signature": str(sig),
                    "doc": inspect.getdoc(method),
                    "params": {
                        param: {
                            "type": str(param_obj.annotation) if param_obj.annotation != inspect.Parameter.empty else None,
                            "default": str(param_obj.default) if param_obj.default != inspect.Parameter.empty else None
                        }
                        for param, param_obj in sig.parameters.items()
                    }
                }

        elif inspect.isfunction(obj) and obj.__module__ == module_name:
            sig = inspect.signature(obj)
            api["functions"][name] = {
                "signature": str(sig),
                "doc": inspect.getdoc(obj)
            }

    return api


def main():
    """Generate API JSON for all fastapi_app modules."""
    output = {
        "generated_at": datetime.now().isoformat(),
        "modules": {}
    }

    # Extract from fastapi_app.lib
    for module_info in pkgutil.iter_modules(["fastapi_app/lib"]):
        if module_info.name.startswith("_"):
            continue
        module_name = f"fastapi_app.lib.{module_info.name}"
        try:
            output["modules"][module_name] = extract_module_api(module_name)
        except Exception as e:
            print(f"Error extracting {module_name}: {e}")

    # Extract from plugins
    plugin_dirs = Path("fastapi_app/plugins").iterdir()
    for plugin_dir in plugin_dirs:
        if not plugin_dir.is_dir() or plugin_dir.name.startswith("_"):
            continue
        plugin_module = f"fastapi_app.plugins.{plugin_dir.name}.plugin"
        try:
            output["modules"][plugin_module] = extract_module_api(plugin_module)
        except Exception as e:
            print(f"Error extracting {plugin_module}: {e}")

    # Write JSON
    output_path = Path("docs/api/backend-api.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Generated {output_path}")


if __name__ == "__main__":
    main()
