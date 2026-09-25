#!/usr/bin/env python3
"""
Reset the application by moving the data directory to trash.
This will delete all application data including users, files, and configuration.
"""
import sys
import subprocess
import shutil
from pathlib import Path
from send2trash import send2trash


def confirm_reset():
    """
    Prompt user for confirmation before proceeding with reset.

    Returns:
        bool: True if user confirms, False otherwise
    """
    print("WARNING: This will move the 'data' directory and 'log' directory contents to trash.")
    print("This action will delete:")
    print("  - All user accounts and sessions")
    print("  - All uploaded files and their metadata")
    print("  - All application configuration")
    print("  - All log files")
    print("")
    response = input("Are you sure you want to continue? (yes/no): ").strip().lower()
    return response in ['yes', 'y']


def reset_application():
    """
    Reset the application by moving the data directory and log files to trash.
    """
    # Get the project root directory (parent of bin/)
    project_root = Path(__file__).resolve().parent.parent
    data_dir = project_root / 'data'
    log_dir = project_root / 'log'

    # Check if either directory exists
    data_exists = data_dir.exists()
    log_exists = log_dir.exists()

    if not data_exists and not log_exists:
        print("Neither data nor log directory exists.")
        print("Nothing to reset.")
        return 0

    # Get confirmation
    if not confirm_reset():
        print("Reset cancelled.")
        return 0

    errors = []

    # Save .gitignore files before deletion
    data_gitignore = data_dir / '.gitignore'
    data_gitignore_content = None
    if data_exists and data_gitignore.exists():
        try:
            data_gitignore_content = data_gitignore.read_text()
        except Exception as e:
            print(f"Warning: Could not read {data_gitignore}: {e}")

    # Move data directory to trash
    if data_exists:
        try:
            print(f"Moving {data_dir} to trash...")
            send2trash(str(data_dir))
            print("Data directory successfully moved to trash.")
        except Exception as e:
            errors.append(f"Error moving data directory: {e}")

    # Recreate data directory with .gitignore
    if data_exists and not errors:
        try:
            data_dir.mkdir(exist_ok=True)
            if data_gitignore_content:
                (data_dir / '.gitignore').write_text(data_gitignore_content)
                print("Recreated data directory with .gitignore")
        except Exception as e:
            errors.append(f"Error recreating data directory: {e}")

    # Move log files to trash (but keep .gitignore)
    if log_exists:
        try:
            log_files = [f for f in log_dir.glob('*') if f.name != '.gitignore']
            if log_files:
                print(f"Moving {len(log_files)} log file(s) to trash...")
                for log_file in log_files:
                    if log_file.is_file():
                        send2trash(str(log_file))
                print("Log files successfully moved to trash.")
            else:
                print("Log directory is empty (excluding .gitignore).")
        except Exception as e:
            errors.append(f"Error moving log files: {e}")

    # Report results
    if errors:
        print("\nErrors occurred:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    # Check for --restart flag
    restart = '--restart' in sys.argv

    # Restart the development server if requested
    if restart:
        print("")
        print("Restarting development server...")
        try:
            # Get the project root directory
            project_root = Path(__file__).resolve().parent.parent
            start_dev_script = project_root / 'bin' / 'start-dev'

            subprocess.run(
                [str(start_dev_script), '--restart'],
                check=False
            )
        except Exception as e:
            print(f"Note: Could not restart server: {e}", file=sys.stderr)
            print("You can manually start the server with: npm run start:dev")
    else:
        print("")
        print("Reset complete. Use 'npm run start:dev' to start the server with fresh configuration.")

    return 0


if __name__ == '__main__':
    sys.exit(reset_application())
