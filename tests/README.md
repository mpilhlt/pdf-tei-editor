# Testing

This directory contains the test suites for the PDF-TEI Editor application.

## Testing Architecture

The project employs a multi-layered testing strategy, including:

*   **Unit Tests:** For isolated JavaScript and Python code.
*   **Integration Tests:** For backend functionalities.
*   **End-to-End (E2E) Tests:** Using Playwright to test the full application in a containerized environment.
*   **Smart Test Runner:** A script that selectively runs tests based on code changes to improve efficiency.

## Detailed Documentation

For comprehensive information on the testing architecture, how to run tests, and best practices for writing new tests, please refer to the main testing guide:

**[-> Full Testing Documentation in `docs/testing.md`](../docs/testing.md)**
