# Migration from Flask to FastAPI

The application is being migrated from the Flask backend to a FastAPI backend.

## Goals

- **API Equivalence**: Achieve a 1:1 functional equivalent of the Flask API.
- **Robust Contracts**: Generate an OpenAPI specification from the server routes to enforce strong contracts between server and client.
- **API Discoverability**: Provide clear, auto-generated API documentation.
- **Simplified Testing**: Enable comprehensive, automated testing of the backend API.

## Migration Strategy

The migration will be performed in a self-contained `backend/` directory, ensuring complete isolation from the existing Flask application during development.

1.  **Isolated Development**: The FastAPI application will be built from scratch in the `backend/` directory. It will not be used by the client until the migration is complete and API equivalence is confirmed. This removes the need for session sharing or a reverse proxy during development.
2.  **Self-Contained Logic, Unified Environment**: All FastAPI-related logic and data directories will reside within `backend/`. However, Python dependencies for both Flask and FastAPI will be managed in the single root `pyproject.toml` to maintain a unified environment using `uv`. Configuration will be managed via a `.env.fastapi` file to ensure no conflicts with the main application.
3.  **Local Testing**: To accelerate development cycles, the FastAPI server will be run and tested directly on the host machine, bypassing Docker for the development phase. E2E tests will be configured to run against this local server instance.
4.  **Core Library First**: Before migrating API endpoints, a framework-agnostic core library will be built in `backend/lib/` by porting and refactoring shared business logic from `server/lib/`. This avoids code duplication and separates logic from the web framework.
5.  **Final Switchover**: Once the FastAPI backend is complete and has passed all tests, the frontend will be switched to use a new, generated API client. The old Flask server will then be decommissioned.

## Detailed Implementation Steps

### Phase 1: Setup and Core Services

- [x] **1. Initial Local Setup**
  - [x] Add FastAPI dependencies (e.g., `fastapi`, `uvicorn`) to the root `pyproject.toml` using `uv add`.
  - [x] Create the directory structure: `backend/api/`, `backend/lib/`, `backend/data/`, `backend/db/`.
  - [x] Create `backend/main.py` with a basic FastAPI app instance and a `/health` endpoint.
  - [x] Create a `.env.fastapi` file and a corresponding config module (`backend/config.py`) to load settings for database paths, etc.
  - [x] Add a run script or update `package.json` to easily start the local FastAPI server.
  - [x] Adapt the e2e test runner scripts to target the local FastAPI server:
    - [x] Support using an environment variable to override the Flask server endpoint and the ability to run tests that are in a specific directory, such as `tests/e2e/fastapi/`
  - [x] Create `tests/e2e/fastapi/health.test.js` and ensure the test passes

- [ ] **2. Build Core Library**
  - [ ] Analyze `server/lib/` to identify essential, framework-agnostic logic (e.g., for file operations, XML processing, etc.).
  - [ ] Port this logic to the `backend/lib/` directory.
  - [ ] **Crucially**, refactor any code that depends on Flask's application context (`request`, `g`, `current_app`) to use dependency injection (i.e., pass context as function arguments).

- [ ] **3. Foundational Endpoints**
  - [ ] **Authentication (`auth.py`)**:
    - [ ] Define Pydantic models for auth requests/responses.
    - [ ] Create `backend/api/auth.py` and migrate login, logout, and session status endpoints.
    - [ ] Create `tests/e2e/fastapi/auth.test.js`
  - [ ] **Configuration (`config.py`)**:
    - [ ] Define Pydantic models for configuration data.
    - [ ] Create `backend/api/config.py` and migrate endpoints for managing application config.
    - [ ] Create `tests/e2e/fastapi/config.test.js`.

### Phase 2: Parallel Migration of API Modules

The following modules can be migrated in parallel. For each, the process is:
1.  Define Pydantic models for all request and response bodies.
2.  Create the FastAPI router in the `backend/api/` directory.
3.  Implement the endpoint logic, consuming the shared `backend/lib/`.
4.  Write comprehensive E2E tests against the local FastAPI server.

- [ ] **File Management (`files/`)**
  - [ ] `list.py`
  - [ ] `upload.py`
  - [ ] `save.py`
  - [ ] `serve_file_by_id.py`
  - [ ] `delete.py`
  - [ ] `move.py`
  - [ ] `locks.py`
  - [ ] `heartbeat.py`
  - [ ] `cache.py`

- [ ] **XML Validation (`validate.py`)**
- [ ] **Extraction (`extract.py`)**
- [ ] **Sync (`sync.py`)**
- [ ] **Server-Sent Events (`sse.py`)**

### Phase 3: Finalization and Switchover

- [ ] **1. Full API Equivalence Testing**
  - [ ] Run the *entire existing* E2E test suite against the completed FastAPI backend to ensure 1:1 API equivalence.
  - [ ] Perform manual QA to catch any subtle behavioral differences.

- [ ] **2. Client Generation and Integration**
  - [ ] Generate the final JavaScript/TypeScript API client from the FastAPI OpenAPI specification.
  - [ ] In a separate branch, replace all frontend API calls with the new client.

- [ ] **3. Deployment and Decommission**
  - [ ] Update the production `Dockerfile` and any deployment scripts to build and run the FastAPI application.
  - [ ] Deploy the new backend and the updated frontend.
  - [ ] After successful deployment, remove the old `server/` directory and related configurations.
  - [ ] Remove Flask-specific dependencies (e.g., `flask`, `waitress`) from `pyproject.toml` using `uv remove`.
  - [ ] Update all project documentation (`README.md`, `docs/`, etc.) to reflect the new architecture.

## Development Workflow

### Running the Dev Server

The FastAPI development server supports hot-reloading. To run it, use:

```bash
npm run dev:fastapi
```

The server will be available at `http://localhost:8000`.

### Running Tests

To run tests for the FastAPI backend, you must have the server running. The test runner connects to the running server instance to perform the tests.

**1. Run all FastAPI tests:**

```bash
# Start the server in one terminal
npm run dev:fastapi

# In another terminal, run the tests
E2E_BASE_URL=http://localhost:8000 node tests/e2e-runner.js --backend --test-dir tests/e2e/fastapi
```

**2. Run tests for changed files:**

A convenience script is provided to automatically test changed files in the `backend/` directory. It starts the server, finds changed files using `git`, runs the relevant tests, and stops the server.

```bash
npm run test:fastapi:changed
```
