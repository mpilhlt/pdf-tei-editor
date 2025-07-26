This document outlines the conventions and architecture of the PDF-TEI Editor project for the Gemini CLI.

## Project Architecture

The PDF-TEI Editor is a web application with a Python/Flask backend and a JavaScript frontend.

### Backend

The backend is a Flask application (`server/flask_app.py`) that serves the frontend and provides a REST API.

- **API:** The API is organized into blueprints located in the `server/api/` directory. Each file in this directory defines a blueprint for a specific set of routes (e.g., `files.py` for file-related operations). The main application file (`flask_app.py`) dynamically imports and registers these blueprints.
- **Data:** The application serves files from the `data/` directory, which contains PDF and TEI/XML files. It also handles file uploads and versioning.
- **Configuration:** The application uses a `.env` file for configuration, and a `config/config.json` for application-specific settings.

### Frontend

The frontend is a single-page application that uses a plugin-based architecture.

- **Plugin Architecture:** The application's functionality is built from a collection of plugins located in `app/src/plugins/`. Each plugin is a JavaScript module that can implement one or more "endpoints" defined in `app/src/endpoints.js`. The main application file (`app/src/app.js`) registers all plugins and invokes their endpoints at different stages of the application lifecycle (e.g., `install`, `start`, `state.update`). This creates a loosely coupled architecture where plugins can be added or removed without affecting the rest of the application.
- **UI:** The UI is built with WebComponents, primarily from the Shoelace library. The UI elements are organized into a nested object structure, defined in `app/src/ui.js`, which mirrors the DOM structure. This allows for easy access to UI elements from anywhere in the application. UI components are generated from HTML templates located in the `app/src/templates` directory. The `createHtmlElements` function in `app/src/ui.js` is used to load these templates and create the corresponding UI elements.
- **State Management:** The application state is managed in `app/src/app.js` and passed to the plugins. When the state changes, the `state.update` endpoint is invoked, allowing each plugin to update the part of the UI it is responsible for.
- **Client-Server Communication:** The frontend communicates with the backend via the `client.js` plugin, which provides a simple API for making requests to the Flask backend.

# General rules for code changes

- Make sure to follow the existing code style and conventions.
- When adding new features, ensure that you are on a feature branch and ask the user if you should create one if the current branch is not a feature branch.
- Always re-read the relevant files since the user may have made changes that you are not aware of.
- Always outline your plan and ask the user for confirmation before beginning to implement changes.
- When tasked with writing a new plugin, always review the plugin files in app/src/plugins first to remind yourself how the different kind of plugins of this application are architected.
- Always re-read files first that you are attempting to edit, since they might have changed since the last task.

