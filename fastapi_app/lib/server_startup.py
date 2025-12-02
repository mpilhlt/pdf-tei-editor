"""
Shared utilities for starting the FastAPI server in development and production modes.

This module provides common functionality for server startup scripts to avoid code duplication.
"""

import os
import socket
import subprocess
import sys
from pathlib import Path
from typing import Optional, Tuple


def load_environment(project_root: Path) -> None:
    """
    Load environment variables from .env file if it exists.

    Args:
        project_root: Root directory of the project
    """
    env_file = project_root / '.env'
    if env_file.exists():
        from dotenv import load_dotenv
        load_dotenv(env_file)


def check_port_in_use(port: int = 8000) -> bool:
    """
    Check if the specified port is already in use.

    Args:
        port: Port number to check

    Returns:
        True if port is in use, False otherwise
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('localhost', port)) == 0


def get_pid_on_port(port: int = 8000) -> Optional[int]:
    """
    Get the PID of the process using the specified port.

    Args:
        port: Port number to check

    Returns:
        PID if found, None otherwise
    """
    try:
        result = subprocess.run(
            ['lsof', '-ti', f':{port}'],
            capture_output=True,
            text=True,
            check=False
        )
        if result.stdout.strip():
            return int(result.stdout.strip().split('\n')[0])
    except (subprocess.SubprocessError, ValueError):
        pass
    return None


def get_host_and_port() -> Tuple[str, int]:
    """
    Determine host and port from environment variables or CLI arguments.

    Priority: env vars > CLI arguments > defaults

    Returns:
        Tuple of (host, port)
    """
    host = os.environ.get('HOST') or (sys.argv[1] if len(sys.argv) > 1 else "localhost")
    port = int(os.environ.get('PORT') or (sys.argv[2] if len(sys.argv) > 2 else 8000))
    return host, port


def setup_log_directory(project_root: Path) -> Path:
    """
    Create log directory and return path to log file.

    Args:
        project_root: Root directory of the project

    Returns:
        Path to the log file
    """
    log_dir = project_root / "log"
    log_dir.mkdir(exist_ok=True)
    return log_dir / "fastapi-server.log"


def print_server_running_message(host: str, port: int, pid: Optional[int] = None) -> None:
    """
    Print message when server is already running.

    Args:
        host: Server host
        port: Server port
        pid: Process ID if available
    """
    print()
    print("=" * 86)
    print(f"FastAPI server is already running on port {port}" + (f" (PID: {pid})" if pid else ""))
    print(f"The server automatically reloads on file changes.")
    print(f"To restart, kill the process and run this command again.")
    if pid:
        print(f"  kill {pid}")
    print(f"Open http://{host}:{port}?dev to access app in development mode.")
    print(f"API docs available at: http://{host}:{port}/docs")
    print("=" * 86)
    print()


def print_server_starting_message(host: str, port: int, log_file: Path, mode: str = "development") -> None:
    """
    Print message when starting the server.

    Args:
        host: Server host
        port: Server port
        log_file: Path to log file
        mode: Server mode ("development" or "production")
    """
    print()
    print("=" * 86)
    print(f"Starting FastAPI {mode} server.")
    print(f"Server output being logged to: {log_file}")
    if mode == "development":
        print(f"The server will automatically reload when files change.")
        print(f"Open http://{host}:{port}?dev to access app in development mode.")
    else:
        print(f"Open http://{host}:{port} to access the application.")
    print(f"API docs available at: http://{host}:{port}/docs")
    print("=" * 86)
    print()
