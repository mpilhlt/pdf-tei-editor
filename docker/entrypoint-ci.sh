#!/bin/bash

# CI Test Runner Entrypoint
# Runs tests inside container and streams output to host

set -e

echo "PDF TEI Editor - CI Test Runner"
echo "==============================="
echo

cd /app

echo "Running tests..."
echo "Arguments: $@"
echo

# Use exec to replace shell process (ensures proper signal handling and exit codes)
# The test runner will stream output in real-time due to PYTHONUNBUFFERED=1
# Tests are self-contained and use fixtures - no setup needed

# Check if any arguments are file paths (not starting with --)
has_file_args=false
for arg in "$@"; do
  # If argument doesn't start with -- and doesn't look like a flag value, it's a file path
  if [[ ! "$arg" =~ ^-- ]] && [[ -f "$arg" || "$arg" =~ / ]]; then
    has_file_args=true
    break
  fi
done

# If no arguments or only flags (no file paths), add --all flag
if [ $# -eq 0 ]; then
  echo "No arguments provided, running all tests"
  exec node tests/smart-test-runner.js --all
elif [ "$has_file_args" = false ]; then
  echo "Only flags provided (no file paths), running all tests"
  exec node tests/smart-test-runner.js --all "$@"
else
  exec node tests/smart-test-runner.js "$@"
fi
