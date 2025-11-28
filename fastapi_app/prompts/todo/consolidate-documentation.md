# Consolidate documentation

Currently, the documentation for the FastAPI application is scattered across multiple files and formats. This task involves consolidating all relevant documentation into a single, well-organized format to improve accessibility and maintainability.

Current documentation sources include:

- Markdown files in the `docs/` directory
- Prompts in the `prompts/` directory (document the Flask-based implementation)
- Prompts in the fastapi_app/prompts/ directory (document the FastAPI-based implementation)

Goal:

- consolidate all documentation facing end-users, developers, and code assistants in separate directories below the "docs/" directory
  - `docs/manual/` for end-user documentation. This should concentrate on concrete usage instructions, feature descriptions. Avoid including implementation details or developer-focused content. Do not discuss the advantages of particular features unless it is necessary for user understanding. Omit any content that is not directly relevant to end-users. Do not describe usage in general terms; focus on specific, actionable instructions as far as you know about the UI. You can use the the `@typedef` which specify the UI structure (starting in `app/src/ui.js`), the templates in `app/src/templates` and the E2E tests in `tests/e2e/tests` to infer end-user workflows. However, if you don't know the specifics, don't include anything speculative, don't attempt to fill in gaps with assumptions, rather add "to be completed" notes where necessary.
  - `docs/development/` for developer documentation: this should be helpful information on architecture, design decisions, API references, and setup instructions - it should avoid redundancy with the code assistant documentation by focusing on higher-level concepts and implementation details. Do not include basic usage instructions that are already covered in the end-user documentation. Do not talk about the advantages of a particular feature unless it is necessary for understanding the implementation. Omit any content that is not directly relevant to developers working on the codebase.
  - `docs/code-assistant/` for code assistant prompts and related documentation: this section should only have concise technical details necessary for understanding and utilizing the prompts effectively and should link to the dveloper documentation for more in-depth information wherever applicable to avoid redundancy - it should focus on implementation rules, practical usage, and examples for patterns and anti-patterns.
  - `docs/images/` for any images used in the documentation
- the landing page `docs/index.md` should provide an overview of the documentation structure and guide users to the appropriate sections based on their needs
- README.md in the project root should be updated to reflect the new documentation structure and provide links to the consolidated documentation, providing only miminal information that does not change frequently plus a "quickstart" section

- ensure that all links within the documentation are updated to reflect the new structure
- review and update the content to ensure consistency in style, formatting, and terminology across all documentation sections
