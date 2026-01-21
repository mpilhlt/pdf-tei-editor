---
globs: "**/*.py"
description: This rule ensures that all file modifications are properly executed
  through the designated tools rather than displaying full file contents in
  chat, maintaining proper workflow with the Continue.dev IDE integration.
alwaysApply: true
---

When making changes to files in this repository, always use the edit_existing_file tool or create_new_file tool instead of showing full file contents in chat. Only use read_file tool to examine existing files before making changes.