#!/usr/bin/env python3
"""
Robust integration test runner for FastAPI backend.

This script provides a clean, isolated test environment by:
1. Killing any running FastAPI servers
2. Wiping the database for a clean slate
3. Starting the FastAPI server
4. Waiting for server startup with log verification
5. Running integration tests
6. Stopping the server
7. Outputting results and log path

Usage:
    python bin/test-fastapi.py                    # Run all tests
    python bin/test-fastapi.py validation         # Run validation tests only
    python bin/test-fastapi.py extraction locks   # Run multiple test files
    python bin/test-fastapi.py --help             # Show help
"""

import sys
import os
import time
import signal
import subprocess
import shutil
import argparse
import platform
from pathlib import Path
from typing import List, Optional

# Colors for output (works on Windows 10+ and Unix)
class Colors:
    RED = '\033[0;31m'
    GREEN = '\033[0;32m'
    YELLOW = '\033[1;33m'
    BLUE = '\033[0;34m'
    NC = '\033[0m'  # No Color

    @classmethod
    def init(cls):
        """Enable ANSI colors on Windows"""
        if platform.system() == 'Windows':
            try:
                import ctypes
                kernel32 = ctypes.windll.kernel32 # type:ignore
                kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
            except:
                # If color initialization fails, disable colors
                cls.RED = cls.GREEN = cls.YELLOW = cls.BLUE = cls.NC = ''

Colors.init()

# Configuration
PROJECT_ROOT = Path(__file__).parent.parent.resolve()
FASTAPI_APP = PROJECT_ROOT / "fastapi_app"
DB_DIR = FASTAPI_APP / "db"
DATA_DIR = FASTAPI_APP / "data"
LOG_DIR = PROJECT_ROOT / "log"
LOG_FILE = LOG_DIR / "fastapi-server.log"
PID_FILE = Path(os.path.expanduser("~")) / ".fastapi-test-server.pid"
SERVER_URL = "http://localhost:8000"
STARTUP_TIMEOUT = 15
HEALTH_CHECK_RETRIES = 10

# Global variable to track server process
server_process: Optional[subprocess.Popen] = None


def log_info(msg: str):
    print(f"{Colors.BLUE}[INFO]{Colors.NC} {msg}")


def log_success(msg: str):
    print(f"{Colors.GREEN}[SUCCESS]{Colors.NC} {msg}")


def log_warning(msg: str):
    print(f"{Colors.YELLOW}[WARNING]{Colors.NC} {msg}")


def log_error(msg: str):
    print(f"{Colors.RED}[ERROR]{Colors.NC} {msg}", file=sys.stderr)


def log_step(msg: str):
    print(f"\n{Colors.BLUE}==>{Colors.NC} {msg}")


def kill_existing_servers():
    """Kill any existing FastAPI/uvicorn servers."""
    log_step("Step 1: Killing any running FastAPI servers")

    if platform.system() == "Windows":
        # Windows: use taskkill
        try:
            subprocess.run(
                ["taskkill", "/F", "/IM", "python.exe", "/FI", "WINDOWTITLE eq *uvicorn*"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
        except:
            pass
    else:
        # Unix: kill by pattern first
        try:
            subprocess.run(
                ["pkill", "-9", "-f", "uvicorn.*fastapi_app"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
        except:
            pass

        # Also kill by checking what's on port 8000
        try:
            result = subprocess.run(
                ["lsof", "-ti:8000"],
                capture_output=True,
                text=True
            )
            if result.stdout.strip():
                pids = result.stdout.strip().split('\n')
                for pid in pids:
                    try:
                        subprocess.run(["kill", "-9", pid], stderr=subprocess.DEVNULL)
                    except:
                        pass
        except:
            pass

    time.sleep(2)
    log_success("Servers stopped")


def wipe_database():
    """Wipe database for clean slate."""
    log_step("Step 2: Wiping database for clean slate")

    # Remove database directory (contains metadata.db, sessions.db, locks.db)
    if DB_DIR.exists():
        shutil.rmtree(DB_DIR)
        log_info(f"Removed {DB_DIR}")

    # Also remove any stale metadata.db in data directory (old location)
    old_metadata_db = DATA_DIR / "metadata.db"
    if old_metadata_db.exists():
        old_metadata_db.unlink()
        log_info(f"Removed old {old_metadata_db}")

    log_success("Database wiped - starting with clean slate")


def start_server(verbose: bool = False) -> subprocess.Popen:
    """Start FastAPI development server."""
    global server_process

    log_step("Step 3: Starting FastAPI development server")

    # Ensure log directory exists
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    # Clear previous log
    LOG_FILE.write_text("")

    # Start server in background
    log_file_handle = open(LOG_FILE, "w")

    if verbose:
        log_info("Starting server with verbose output...")
        server_process = subprocess.Popen(
            ["npm", "run", "dev:fastapi"],
            cwd=PROJECT_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        # Tee output to both log file and console
        # This will be handled by reading output in wait_for_startup
    else:
        log_info(f"Starting server (output in {LOG_FILE})...")
        server_process = subprocess.Popen(
            ["npm", "run", "dev:fastapi"],
            cwd=PROJECT_ROOT,
            stdout=log_file_handle,
            stderr=subprocess.STDOUT
        )

    # Save PID
    PID_FILE.write_text(str(server_process.pid))
    log_info(f"Server PID: {server_process.pid}")

    return server_process


def check_server_log_for_errors() -> Optional[str]:
    """Check server log for errors. Returns error message if found."""
    try:
        log_content = LOG_FILE.read_text()
        error_lines = []
        for line in log_content.split('\n'):
            if 'error' in line.lower() or 'exception' in line.lower() or 'failed' in line.lower():
                # Skip INFO level messages
                if 'INFO' not in line:
                    error_lines.append(line)

        if error_lines:
            return '\n'.join(error_lines[-10:])  # Return last 10 errors
    except:
        pass
    return None


def wait_for_startup() -> bool:
    """Wait for server to start up and verify health."""
    log_step(f"Step 4: Waiting for server startup (timeout: {STARTUP_TIMEOUT}s)")

    for i in range(STARTUP_TIMEOUT):
        time.sleep(1)

        # Check if process is still running
        if server_process.poll() is not None:
            log_error("Server process died during startup!")
            log_error(f"Check log file: {LOG_FILE}")
            print()
            log_error("Last 20 lines of log:")
            try:
                lines = LOG_FILE.read_text().split('\n')
                for line in lines[-20:]:
                    print(line, file=sys.stderr)
            except:
                pass
            return False

        # Check for startup errors in log
        errors = check_server_log_for_errors()
        if errors:
            log_error("Errors detected in server log during startup!")
            log_error(f"Check log file: {LOG_FILE}")
            print()
            log_error("Errors found:")
            print(errors, file=sys.stderr)
            return False

        # Check if server is responding
        try:
            import urllib.request
            response = urllib.request.urlopen(f"{SERVER_URL}/health", timeout=1)
            if response.status == 200:
                log_success(f"Server started successfully and responding at {SERVER_URL}")
                return True
        except:
            pass

        if (i + 1) % 3 == 0:
            log_info(f"Still waiting... ({i + 1}s)")

    log_error(f"Server failed to start within {STARTUP_TIMEOUT}s")
    log_error(f"Check log file: {LOG_FILE}")
    print()
    log_error("Last 30 lines of log:")
    try:
        lines = LOG_FILE.read_text().split('\n')
        for line in lines[-30:]:
            print(line, file=sys.stderr)
    except:
        pass
    return False


def verify_health() -> bool:
    """Verify server health endpoint."""
    try:
        import urllib.request
        import json
        response = urllib.request.urlopen(f"{SERVER_URL}/health", timeout=5)
        data = json.loads(response.read())
        if data.get('status') == 'ok':
            log_success(f"Health check passed: {data}")
            return True
        else:
            log_error(f"Health check failed: {data}")
            return False
    except Exception as e:
        log_error(f"Health check failed: {e}")
        return False


def run_tests(test_files: List[str]) -> int:
    """Run integration tests. Returns exit code."""
    log_step("Step 5: Running integration tests")

    # Build test file pattern
    if not test_files:
        test_pattern = str(FASTAPI_APP / "tests" / "backend" / "*.test.js")
        log_info("Running ALL integration tests")
    else:
        test_patterns = []
        for test_name in test_files:
            # Add .test.js if not present
            if not test_name.endswith('.test.js'):
                test_name = f"{test_name}.test.js"
            test_patterns.append(str(FASTAPI_APP / "tests" / "backend" / test_name))
        test_pattern = " ".join(test_patterns)
        log_info(f"Running tests: {', '.join(test_files)}")

    print()
    log_info(f"Test command: E2E_BASE_URL={SERVER_URL} node --test {test_pattern}")
    print()

    # Run tests
    env = os.environ.copy()
    env["E2E_BASE_URL"] = SERVER_URL

    try:
        # Split test_pattern back into list for subprocess
        test_files_list = test_pattern.split()
        result = subprocess.run(
            ["node", "--test"] + test_files_list,
            cwd=PROJECT_ROOT,
            env=env
        )
        return result.returncode
    except Exception as e:
        log_error(f"Failed to run tests: {e}")
        return 1


def stop_server():
    """Stop the FastAPI server."""
    global server_process

    if server_process:
        log_info(f"Stopping FastAPI server (PID: {server_process.pid})")
        try:
            if platform.system() == "Windows":
                # Windows: terminate the process tree
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(server_process.pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
            else:
                # Unix: send SIGTERM
                server_process.terminate()
                try:
                    server_process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server_process.kill()
        except:
            pass
        server_process = None

    # Clean up PID file
    if PID_FILE.exists():
        PID_FILE.unlink()


def cleanup(do_cleanup: bool):
    """Cleanup function called on exit."""
    if do_cleanup:
        log_step("Cleaning up...")
        stop_server()
        log_success("Cleanup complete")
    else:
        log_warning("Skipping cleanup (--no-cleanup flag set)")
        log_info(f"Server still running at {SERVER_URL}")
        log_info(f"View logs: tail -f {LOG_FILE}")
        if platform.system() == "Windows":
            log_info(f"View logs: Get-Content {LOG_FILE} -Wait")


def main():
    parser = argparse.ArgumentParser(
        description="Robust integration test runner for FastAPI backend",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python bin/test-fastapi.py                          # Run all tests with clean slate
  python bin/test-fastapi.py validation               # Run only validation tests
  python bin/test-fastapi.py extraction validation    # Run extraction and validation tests
  python bin/test-fastapi.py --keep-db files_save     # Run files_save without DB wipe
  python bin/test-fastapi.py --verbose --no-cleanup   # Debug mode with server logs

What this script does:
  1. Kills any running FastAPI servers
  2. Wipes fastapi_app/db/* and fastapi_app/data/metadata.db for clean slate
  3. Starts FastAPI development server
  4. Waits for successful startup (checks log for errors)
  5. Runs specified integration tests
  6. Stops the server (unless --no-cleanup)
  7. Shows test results and log file path
        """
    )

    parser.add_argument(
        'test_files',
        nargs='*',
        help='One or more test file names (without .test.js extension)'
    )
    parser.add_argument(
        '--keep-db',
        action='store_true',
        help="Don't wipe database before tests (faster, but not clean)"
    )
    parser.add_argument(
        '--no-cleanup',
        action='store_true',
        help="Don't kill server after tests (for debugging)"
    )
    parser.add_argument(
        '--verbose', '-v',
        action='store_true',
        help='Show server output during tests'
    )

    args = parser.parse_args()

    # Change to project root
    os.chdir(PROJECT_ROOT)

    exit_code = 0

    try:
        # Step 1: Kill existing servers
        kill_existing_servers()

        # Step 2: Wipe database (unless --keep-db)
        if args.keep_db:
            log_step("Step 2: Keeping existing database (--keep-db flag set)")
            log_warning("Tests may fail if database schema is outdated")
        else:
            wipe_database()

        # Step 3: Start server
        start_server(args.verbose)

        # Step 4: Wait for startup
        if not wait_for_startup():
            exit_code = 1
            return

        # Verify health
        if not verify_health():
            exit_code = 1
            return

        # Step 5: Run tests
        test_exit_code = run_tests(args.test_files)

        # Step 6: Output results
        log_step("Step 6: Test Results")
        print()

        if test_exit_code != 0:
            log_error(f"Tests FAILED with exit code {test_exit_code}")
            print()
            log_info("For detailed debugging:")
            log_info(f"  - Server log: {LOG_FILE}")
            print()
            log_info("To debug interactively:")
            test_files_str = " ".join(args.test_files) if args.test_files else ""
            log_info(f"  python bin/test-fastapi.py --no-cleanup {test_files_str}")
            log_info("  # Server will keep running for manual testing")
            print()
            exit_code = 1
        else:
            log_success("All tests PASSED!")
            print()
            log_info(f"Server log: {LOG_FILE}")
            print()
            exit_code = 0

    finally:
        cleanup(not args.no_cleanup)

    sys.exit(exit_code)


if __name__ == "__main__":
    # Handle Ctrl+C gracefully
    def signal_handler(sig, frame):
        print()
        log_warning("Interrupted by user")
        cleanup(True)
        sys.exit(130)

    signal.signal(signal.SIGINT, signal_handler)

    main()
