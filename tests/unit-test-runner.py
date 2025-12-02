#!/usr/bin/env python3
"""
Python Unit Test Runner

Thin wrapper around Python's unittest that allows for additional configuration
and behavior, including suppressing known harmless warnings.

Usage:
    python tests/unit-test-runner.py [options] [test-path-or-files...]

Options:
    --tap               Output in TAP format (via pytest-tap)
    --verbose, -v       Verbose output
    --grep PATTERN      Only run tests matching pattern (in test file names)
    --inverse-grep PAT  Exclude tests matching pattern (in test file names)

Arguments:
    test-path-or-files  Directory to search for tests, or specific test files
                       (default: tests/unit)

Environment:
    PYTHONWARNINGS      Override warning filters
"""

import sys
import os
import unittest
import warnings
import re
from pathlib import Path
from glob import glob

# Add project root to Python path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))


def parse_args():
    """Parse command line arguments."""
    args = sys.argv[1:]

    options = {
        'verbose': '-v' in args or '--verbose' in args,
        'tap': '--tap' in args,
        'grep': None,
        'inverse_grep': None,
        'paths': []
    }

    # Remove flags and extract values
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ('-v', '--verbose'):
            i += 1
        elif arg == '--tap':
            i += 1
        elif arg == '--grep':
            if i + 1 < len(args):
                options['grep'] = args[i + 1]
                i += 2
            else:
                print("Error: --grep requires a pattern")
                sys.exit(1)
        elif arg == '--inverse-grep':
            if i + 1 < len(args):
                options['inverse_grep'] = args[i + 1]
                i += 2
            else:
                print("Error: --inverse-grep requires a pattern")
                sys.exit(1)
        else:
            options['paths'].append(arg)
            i += 1

    # Default to tests/unit if no paths specified
    if not options['paths']:
        options['paths'] = ['tests/unit']

    return options


def discover_tests(paths, grep_pattern=None, inverse_grep_pattern=None):
    """
    Discover test files from paths.

    Args:
        paths: List of directories or test files
        grep_pattern: Optional regex pattern to include only matching files
        inverse_grep: Optional regex pattern to exclude matching files

    Returns:
        List of test file paths
    """
    test_files = []

    for path_str in paths:
        path = project_root / path_str

        if path.is_file():
            test_files.append(str(path))
        elif path.is_dir():
            # Find all test_*.py files recursively
            pattern = str(path / '**' / 'test_*.py')
            found_files = glob(pattern, recursive=True)
            test_files.extend(found_files)
        else:
            print(f"Warning: Path not found: {path_str}", file=sys.stderr)

    # Apply grep filters
    if grep_pattern:
        regex = re.compile(grep_pattern)
        test_files = [f for f in test_files if regex.search(f)]

    if inverse_grep_pattern:
        regex = re.compile(inverse_grep_pattern)
        test_files = [f for f in test_files if not regex.search(f)]

    return sorted(set(test_files))


def main():
    options = parse_args()

    # Configure warnings - suppress ResourceWarnings from unittest.mock in Python 3.13+
    # These are false positives from mocked database connections in tests
    if not os.environ.get('PYTHONWARNINGS'):
        warnings.filterwarnings('ignore', category=ResourceWarning)

    # Discover tests
    test_files = discover_tests(
        options['paths'],
        options['grep'],
        options['inverse_grep']
    )

    if not test_files:
        print("No test files found")
        sys.exit(1)

    # Load tests
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    for test_file in test_files:
        # Convert file path to module name
        rel_path = Path(test_file).relative_to(project_root)
        module_name = str(rel_path.with_suffix('')).replace(os.sep, '.')

        try:
            tests = loader.loadTestsFromName(module_name)
            suite.addTests(tests)
        except Exception as e:
            print(f"Warning: Failed to load {module_name}: {e}", file=sys.stderr)

    # Run tests
    if options['tap']:
        try:
            from tap import TAPTestRunner
            runner = TAPTestRunner()
        except ImportError:
            print("Error: tap.py not installed. Install with: pip install tap.py")
            sys.exit(1)
    else:
        runner = unittest.TextTestRunner(verbosity=2 if options['verbose'] else 1)

    result = runner.run(suite)

    # Exit with appropriate code
    sys.exit(0 if result.wasSuccessful() else 1)


if __name__ == '__main__':
    main()
