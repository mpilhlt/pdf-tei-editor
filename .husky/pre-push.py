#!/usr/bin/env python3
"""
Pre-push hook to run smart tests before pushing.
Cross-platform implementation using Python.
"""
import subprocess
import sys


def main():
    """Run smart tests before allowing push."""
    try:
        # Check if the latest commit message contains [skip-ci] or [skip ci]
        result = subprocess.run(
            ["git", "log", "-1", "--pretty=%B"],
            capture_output=True,
            text=True,
            check=True
        )

        latest_commit_message = result.stdout.strip()

        if "[skip-ci]" in latest_commit_message.lower() or "[skip ci]" in latest_commit_message.lower():
            print("⏭️  Skipping tests due to [skip-ci] in commit message.")
            sys.exit(0)

        # Run smart tests first - fail fast if tests don't pass
        print("Running smart tests...")
        subprocess.run(
            ["node", "tests/smart-test-runner.js"],
            check=True
        )
        print("Tests passed.")
        sys.exit(0)

    except subprocess.CalledProcessError as e:
        print(f"Pre-push hook failed: Tests did not pass.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
