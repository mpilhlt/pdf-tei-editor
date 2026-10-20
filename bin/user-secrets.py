#!/usr/bin/env python3
"""
Manage the per-user API keys stored encrypted in the application's secret store.

Secret values are never printed to a terminal. ``get`` and ``export`` write the value
only when stdout is captured, so a script or an agent can keep it in a variable
without the value appearing in its output or logs:

    KEY=$(uv run python bin/user-secrets.py get anthropic --user alice --prompt)
    eval "$(uv run python bin/user-secrets.py export anthropic --user alice --env ANTHROPIC_API_KEY)"

With ``--prompt``, a missing key is asked for on the controlling terminal (hidden
input), stored, and then returned. Without a terminal the command fails.

Usage:
    uv run python bin/user-secrets.py list --user alice
    uv run python bin/user-secrets.py set anthropic --user alice          # hidden prompt
    uv run python bin/user-secrets.py set anthropic --user alice --stdin  # value from stdin
    uv run python bin/user-secrets.py get anthropic --user alice [--prompt]
    uv run python bin/user-secrets.py export anthropic --user alice --env VAR
    uv run python bin/user-secrets.py delete anthropic --user alice

The user defaults to $PTE_SECRETS_USER. The data directory and the encryption key
(SECRETS_ENCRYPTION_KEY) come from the application settings, like in the server.
"""

import argparse
import getpass
import os
import shlex
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from fastapi_app.config import get_settings  # noqa: E402
from fastapi_app.lib.secrets import SecretServiceRegistry, SecretStore, SecretsError  # noqa: E402


def _prompt_secret(service: str, user: str) -> str:
    """Ask for a secret on the controlling terminal with hidden input (works while stdout is captured)."""
    try:
        value = getpass.getpass(f"API key for '{service}' of user '{user}': ").strip()
    except (EOFError, OSError, getpass.GetPassWarning) as e:
        raise SecretsError("No terminal available to ask for the key. Run 'set' in a terminal first.") from e
    if not value:
        raise SecretsError("No key entered")
    return value


def _require_captured_stdout(command: str) -> None:
    """Refuse to print a secret to a terminal."""
    if sys.stdout.isatty():
        raise SecretsError(
            f"'{command}' prints the secret, so its output must be captured, e.g. KEY=$(... {command} ...)"
        )


def _get_or_prompt(store: SecretStore, user: str, service: str, prompt: bool) -> str:
    """The stored secret; with ``prompt``, ask for and store a missing one."""
    value = store.get(user, service)
    if value:
        return value
    if not prompt:
        raise SecretsError(f"No key stored for '{service}' (user '{user}'). Use --prompt or the 'set' command.")
    value = _prompt_secret(service, user)
    store.set(user, service, value)
    return value


def _run(args: argparse.Namespace) -> int:
    user = args.user or os.environ.get("PTE_SECRETS_USER")
    if not user:
        raise SecretsError("Specify the user with --user or $PTE_SECRETS_USER")
    store = SecretStore(Path(args.db_dir) if args.db_dir else get_settings().db_dir)

    if args.command == "list":
        for service in store.list_services(user):
            print(f"{service}\t{SecretServiceRegistry.describe(service).label}")
    elif args.command == "set":
        value = sys.stdin.read().strip() if args.stdin else _prompt_secret(args.service, user)
        if not value:
            raise SecretsError("No key given")
        store.set(user, args.service, value)
        print(f"Stored the key for '{args.service}' (user '{user}').", file=sys.stderr)
    elif args.command == "get":
        _require_captured_stdout("get")
        sys.stdout.write(_get_or_prompt(store, user, args.service, args.prompt))
    elif args.command == "export":
        _require_captured_stdout("export")
        value = _get_or_prompt(store, user, args.service, args.prompt)
        print(f"export {args.env}={shlex.quote(value)}")
    elif args.command == "delete":
        removed = store.delete(user, args.service)
        print("Deleted." if removed else "Nothing to delete.", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--user", help="Username of the key owner (default: $PTE_SECRETS_USER)")
    parser.add_argument("--db-dir", help="Database directory (default: from the application settings)")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list", help="List the services the user has a key for (no values)")
    for name, help_text in [
        ("set", "Store a key (hidden prompt, or --stdin)"),
        ("get", "Write a key to stdout (must be captured)"),
        ("export", "Write an 'export VAR=...' line (must be captured)"),
        ("delete", "Remove a key"),
    ]:
        sub = commands.add_parser(name, help=help_text)
        sub.add_argument("service", help="Service id, e.g. 'anthropic'")
        if name == "set":
            sub.add_argument("--stdin", action="store_true", help="Read the key from stdin instead of prompting")
        if name in ("get", "export"):
            sub.add_argument("--prompt", action="store_true", help="Ask for the key on the terminal if it is missing")
        if name == "export":
            sub.add_argument("--env", required=True, help="Name of the environment variable to export")
    try:
        return _run(parser.parse_args(argv))
    except SecretsError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
