#!/usr/bin/env python3
"""
Commit-msg hook to validate conventional commit format on the devel branch.
"""
import re
import subprocess
import sys
from pathlib import Path

# Conventional commit types
VALID_TYPES = [
    "feat",
    "fix",
    "docs",
    "style",
    "refactor",
    "perf",
    "test",
    "build",
    "ci",
    "chore",
    "revert",
]

# Pattern: type(optional-scope): description
# Or: type: description
CONVENTIONAL_COMMIT_PATTERN = re.compile(
    r"^(" + "|".join(VALID_TYPES) + r")(\([a-zA-Z0-9_-]+\))?!?: .+",
    re.IGNORECASE,
)


def get_current_branch() -> str:
    """Get the current git branch name."""
    result = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def validate_commit_message(message: str) -> bool:
    """Check if commit message follows conventional commit format."""
    # Get first line (subject)
    first_line = message.split("\n")[0].strip()

    # Allow merge commits
    if first_line.startswith("Merge "):
        return True

    # Check against pattern
    return bool(CONVENTIONAL_COMMIT_PATTERN.match(first_line))


def main():
    """Validate commit message on devel branch."""
    if len(sys.argv) < 2:
        print("Usage: commit-msg.py <commit-message-file>", file=sys.stderr)
        sys.exit(1)

    commit_msg_file = Path(sys.argv[1])

    try:
        branch = get_current_branch()
    except subprocess.CalledProcessError:
        # Not in a git repo or other error, skip validation
        sys.exit(0)

    # Only validate on devel branch
    if branch != "devel":
        sys.exit(0)

    # Read commit message
    try:
        message = commit_msg_file.read_text().strip()
    except FileNotFoundError:
        print(f"Commit message file not found: {commit_msg_file}", file=sys.stderr)
        sys.exit(1)

    # Skip empty messages (git will reject them anyway)
    if not message:
        sys.exit(0)

    if not validate_commit_message(message):
        print("Commit message does not follow conventional commit format.")
        print("")
        print("Expected format: <type>[(scope)]: <description>")
        print("")
        print(f"Valid types: {', '.join(VALID_TYPES)}")
        print("")
        print("Examples:")
        print("  feat: Add user authentication")
        print("  fix(api): Handle null response correctly")
        print("  docs: Update README with installation steps")
        print("  refactor!: Rename user endpoint (breaking change)")
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
