#!/usr/bin/env python3
"""
Pre-commit hook to check if FastAPI router changes require API client regeneration.
Cross-platform implementation using Python.
"""
import os
import subprocess
import sys
from pathlib import Path


def check_client_outdated():
    """Check if the generated API client is outdated compared to router files."""
    client_file = Path("app/src/modules/api-client-v1.js")
    routers_dir = Path("fastapi_app/routers")

    # Check if client file exists
    if not client_file.exists():
        print("❌ Generated API client not found:", client_file)
        print("   Run: npm run generate-client")
        return False

    # Get client modification time
    client_mtime = client_file.stat().st_mtime

    # Get all router files
    router_files = [
        f for f in routers_dir.glob("*.py") if f.name != "__init__.py"
    ]

    if not router_files:
        print("❌ No router files found in:", routers_dir)
        return False

    # Check if any router is newer than client
    outdated_routers = [
        f for f in router_files if f.stat().st_mtime > client_mtime
    ]

    if outdated_routers:
        print("❌ Generated API client is outdated!")
        print(f"   Client: {client_file}")
        print("")
        print("   Outdated due to changes in:")
        for router in outdated_routers:
            print(f"   - {router}")
        print("")
        print("   Run: npm run generate-client")
        return False

    print("✅ Generated API client is up-to-date")
    return True


def main():
    """Check if staged FastAPI router files require API client regeneration."""
    try:
        # Check if FastAPI router files are being committed
        result = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            capture_output=True,
            text=True,
            check=True
        )

        staged_files = result.stdout.splitlines()
        has_router_changes = any(
            "fastapi_app/routers/" in file for file in staged_files
        )

        if not has_router_changes:
            # No router changes, allow commit
            sys.exit(0)

        print("🔍 FastAPI router changes detected, checking if API client needs regeneration...")

        # Check if client is up-to-date
        if check_client_outdated():
            sys.exit(0)
        else:
            sys.exit(1)

    except subprocess.CalledProcessError as e:
        print(f"Error running git command: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
