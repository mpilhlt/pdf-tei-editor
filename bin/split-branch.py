# This is a utilty script to split branches that contain too many different
# commits into functionally related sub-branches.
# Yoou need to edit it first before running it

import os
import subprocess
import sys

def run_command(command, cwd=None):
    """Run a shell command and return the result"""
    try:
        result = subprocess.run(
            command, 
            shell=True, 
            cwd=cwd,
            capture_output=True, 
            text=True,
            check=True
        )
        return result.stdout
    except subprocess.CalledProcessError as e:
        print(f"Command failed: {command}")
        print(f"Error: {e.stderr}")
        return None

def main():
    # Define the branches and their file mappings
    branch_files = {
        "b1-refactor-database-connection": [
            "CLAUDE.md",
            "app/src/modules/api-client-v1.js",
            "bin/import_files.py",
            "dev/todo/sqlite-wal-problem.md",
            "docs/code-assistant/README.md",
            "docs/code-assistant/database-connections.md",
            "docs/development/adding-new-databases.md",
            "docs/development/database.md",
            "fastapi_app/config.py",
            "fastapi_app/lib/access_control.py",
            "fastapi_app/lib/collection_utils.py",
            "fastapi_app/lib/data_utils.py",
            "fastapi_app/lib/database.py",
            "fastapi_app/lib/database_init.py",
            "fastapi_app/lib/db_schema.py",
            "fastapi_app/lib/db_utils.py",
            "fastapi_app/lib/dependencies.py",
            "fastapi_app/lib/doc_id_resolver.py",
            "fastapi_app/lib/event_bus.py",
            "fastapi_app/lib/file_repository.py",
            "fastapi_app/lib/file_storage.py",
            "fastapi_app/lib/locking.py",
            "fastapi_app/lib/schema_validator.py",
            "fastapi_app/lib/sqlite_utils.py",
            "fastapi_app/lib/statistics.py",
            "fastapi_app/lib/storage_gc.py",
            "fastapi_app/lib/storage_references.py",
            "fastapi_app/lib/tei_utils.py",
            "fastapi_app/main.py",
            "tests/api/v1/.env.test",
            "tests/e2e/.env.test"
        ],
        "b2-add-status-field": [
            "fastapi_app/lib/tests/test_statistics.py",
            "tests/unit/fastapi/test_statistics.py",
            "fastapi_app/lib/migrations/tests/test_migration_005.py",
            "fastapi_app/lib/migrations/versions/__init__.py",
            "fastapi_app/lib/migrations/versions/m005_add_status_column.py",
            "fastapi_app/lib/models.py",
            "fastapi_app/routers/files_save.py"
        ],
        "b3-discord-plugin": [
            "docs/development/plugin-system-backend.md",
            "dev/todo/discord-audit-trail.md",
            "fastapi_app/plugins/annotation_history/tests/test_annotation_history.py",
            "fastapi_app/plugins/annotation_progress/routes.py",
            "fastapi_app/plugins/discord_audit_trail/__init__.py",
            "fastapi_app/plugins/discord_audit_trail/plugin.py",
            "fastapi_app/plugins/discord_audit_trail/tests/test_plugin.py",
            "fastapi_app/plugins/edit_history/tests/test_edit_history_export.py",
            "fastapi_app/plugins/local_sync/__init__.py",
            "fastapi_app/plugins/local_sync/plugin.py",
            "app/src/modules/oa-utils.js"
        ]
    }

    # Step 1: Switch to devel and create branches if they don't exist
    print("Switching to devel branch...")
    run_command("git checkout devel")
    
    # Create branches if they don't exist
    for branch_name in branch_files.keys():
        print(f"Creating branch {branch_name}...")
        run_command(f"git checkout -B {branch_name}")

    # Step 2: Get the list of changed files from feat-discord-plugin
    print("Getting changed files from feat-discord-plugin...")
    changed_files_output = run_command("git diff --name-only devel")
    if changed_files_output is None:
        print("Failed to get changed files")
        return
    
    changed_files = [f.strip() for f in changed_files_output.strip().split('\n') if f.strip()]
    
    # Verify we have all the expected files
    all_expected_files = []
    for files_list in branch_files.values():
        all_expected_files.extend(files_list)
    
    missing_files = set(all_expected_files) - set(changed_files)
    if missing_files:
        print(f"Warning: Missing expected files: {missing_files}")
    
    # Step 3: For each branch, copy its files from feat-discord-plugin
    for branch_name, files_list in branch_files.items():
        print(f"\nProcessing branch: {branch_name}")
        
        # Switch to the target branch
        run_command(f"git checkout {branch_name}")
        
        # Copy each file from feat-discord-plugin to the current branch
        for file_path in files_list:
            # Check if file exists in feat-discord-plugin
            if os.path.exists(file_path):
                # Ensure directory structure exists
                dir_path = os.path.dirname(file_path)
                if dir_path and not os.path.exists(dir_path):
                    os.makedirs(dir_path)
                
                # Copy file from feat-discord-plugin to current branch
                run_command(f"cp \"{file_path}\" \"{file_path}\"")
                print(f"  Copied: {file_path}")
            else:
                print(f"  Warning: File not found in feat-discord-plugin: {file_path}")
        
        # Stage and commit the changes
        run_command("git add .")
        run_command("git commit -m \"Initial commit for branch: {branch_name}\"")
        print(f"  Committed changes for {branch_name}")

    # Step 4: Return to devel
    print("\nReturning to devel branch...")
    run_command("git checkout devel")
    
    print("\nBranch splitting completed successfully!")

if __name__ == "__main__":
    main()