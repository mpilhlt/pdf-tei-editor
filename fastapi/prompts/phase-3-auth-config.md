# Phase 3: Authentication and Configuration APIs

**Goal**: Implement foundational endpoints with full testing and OpenAPI validation

**Critical**: This phase prototypes the complete development workflow:
1. Define Pydantic models
2. Implement FastAPI router
3. Write E2E tests
4. **Run and validate tests pass**
5. Generate API client prototype

## Tasks

### 3.1 Authentication API

- [ ] Create `fastapi/api/auth.py`
  - Define Pydantic models: `LoginRequest`, `LoginResponse`, `StatusResponse`
  - Implement POST `/api/v1/auth/login`
  - Implement POST `/api/v1/auth/logout`
  - Implement GET `/api/v1/auth/status`
  - Use `AuthManager` and `SessionManager` from Phase 1

- [ ] Create test data `fastapi/db/users.json`:
```json
{
    "admin": {
        "username": "admin",
        "fullname": "Administrator",
        "passwd_hash": "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918",
        "role": "admin"
    }
}
```
(Password: "admin" SHA-256 hashed)

- [ ] Create `fastapi/tests/auth.test.js`
  - Login with valid credentials
  - Login with invalid credentials
  - Session status check
  - Logout
  - Session persistence

- [ ] Update `fastapi/main.py`:
```python
from .api import auth
api_v1.include_router(auth.router)
```

- [ ] **Run tests and validate all pass**

### 3.2 Configuration API

- [ ] Create `fastapi/api/config.py`
  - Define Pydantic models: `ConfigSetRequest`, `InstructionItem`, `StateResponse`
  - Implement GET `/api/v1/config/list`
  - Implement GET `/api/v1/config/get/{key}`
  - Implement POST `/api/v1/config/set` (auth required)
  - Implement GET `/api/v1/config/instructions` (auth required)
  - Implement POST `/api/v1/config/instructions` (auth required)
  - Implement GET `/api/v1/config/state`

- [ ] Create initial `fastapi/db/config.json`:
```json
{
    "session.timeout": 3600,
    "extraction.instructions": []
}
```

- [ ] Create `fastapi/tests/config.test.js`
  - List all config
  - Get specific config value
  - Set config with auth
  - Set config without auth (should fail)
  - Get/set instructions
  - Get state

- [ ] Update `fastapi/main.py`:
```python
from .api import auth, config
api_v1.include_router(auth.router)
api_v1.include_router(config.router)
```

- [ ] **Run tests and validate all pass**

### 3.3 Client Generation Prototype

- [ ] Create `bin/generate-api-client.js`
  - Start FastAPI server temporarily on port 8001
  - Fetch OpenAPI spec from `/openapi.json`
  - Generate basic client code for auth + config endpoints
  - Write to `app/src/modules/api-client-v1.js`

- [ ] Add to `package.json`:
```json
{
    "scripts": {
        "generate-client": "node bin/generate-api-client.js"
    }
}
```

- [ ] Run `npm run generate-client`
- [ ] Validate generated code structure

## Pydantic Models

### Authentication

```python
class LoginRequest(BaseModel):
    username: str
    passwd_hash: str

class LoginResponse(BaseModel):
    username: str
    fullname: Optional[str] = None
    sessionId: str

class StatusResponse(BaseModel):
    username: str
    fullname: Optional[str] = None
```

### Configuration

```python
class ConfigSetRequest(BaseModel):
    key: str
    value: Any

class InstructionItem(BaseModel):
    label: str
    extractor: List[str]
    text: List[str]

class StateResponse(BaseModel):
    webdavEnabled: bool
```

## Authentication Dependency

Create reusable auth dependency:

```python
from fastapi import Request, HTTPException, Depends

async def require_auth(request: Request) -> dict:
    """Dependency that requires valid authentication"""
    settings = get_settings()
    auth_manager = AuthManager(settings.db_path)

    session_id = get_session_id_from_request(request)
    if not session_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    user = auth_manager.get_user_by_session_id(session_id)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid session")

    return user

# Usage in endpoints:
@router.post("/set")
async def set_config(
    request: ConfigSetRequest,
    user: dict = Depends(require_auth)
):
    # user is authenticated
    ...
```

## Testing Workflow

```bash
# Terminal 1: Start server
npm run dev:fastapi

# Terminal 2: Run tests
E2E_BASE_URL=http://localhost:8000 node tests/e2e-runner.js --backend --test-dir fastapi/tests

# Or run specific test
E2E_BASE_URL=http://localhost:8000 node fastapi/tests/auth.test.js
```

## Completion Criteria

Phase 3 is complete when:
- ✅ Auth endpoints implemented and tested
- ✅ Config endpoints implemented and tested
- ✅ All tests passing (auth + config)
- ✅ Client generation produces valid JavaScript
- ✅ Generated client can be imported without errors
- ✅ OpenAPI docs show all endpoints at `/docs`

## Generated Client Example

```javascript
export class ApiClientV1 {
    constructor(callApiFn) {
        this.callApi = callApiFn;
    }

    /**
     * User login
     * @param {Object} request
     * @param {string} request.username
     * @param {string} request.passwd_hash
     * @returns {Promise<{username: string, sessionId: string}>}
     */
    async authLogin(request) {
        if (!request.username || !request.passwd_hash) {
            throw new TypeError("Missing required fields");
        }
        return this.callApi('/api/auth/login', {
            method: 'POST',
            body: request
        });
    }

    // ... more methods
}
```

## Next Phase

After Phase 3, you have a working pattern for:
- Pydantic models → FastAPI endpoints → E2E tests → Generated client

Apply this pattern to remaining endpoints in Phase 4+.

→ Phase 4: File Management APIs (to be documented)
