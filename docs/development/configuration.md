# Configuration Management

The PDF-TEI-Editor uses JSON configuration files to manage application settings. Configuration can be managed via the command-line interface.

## Configuration Files

- **`data/db/config.json`** - Runtime configuration (user-specific, gitignored)
- **`config/config.json`** - Default configuration (version-controlled)

## CLI Commands

### Get Configuration Values

```bash
# Get value from data/db/config.json
./bin/manage.py config get <key>

# Get value from config/config.json
./bin/manage.py config get <key> --default
```

### Set Configuration Values

```bash
# Set in data/db/config.json only
./bin/manage.py config set <key> <json_value>

# Set in both data/db/config.json and config/config.json
./bin/manage.py config set <key> <json_value> --default

# Set value constraints
./bin/manage.py config set <key> --values '["option1", "option2"]'

# Set type constraints
./bin/manage.py config set <key> --type "string"
```

### Delete Configuration Keys

```bash
# Delete from data/db/config.json only
./bin/manage.py config delete <key>

# Delete from both files
./bin/manage.py config delete <key> --default
```

## Value Validation

- **Values must be valid JSON literals** (strings in quotes, arrays as `[1,2,3]`)
- **Constraint validation**: If `<key>.values` exists, value must be one of the allowed values
- **Type validation**: If `<key>.type` exists, value must match the specified JSON type
- **Auto-typing**: New keys automatically get a `.type` constraint based on the value

## Examples

```bash
# Set application mode with validation
./bin/manage.py config set application.mode '"production"'

# Set heartbeat interval
./bin/manage.py config set heartbeat.interval 30

# Set array value
./bin/manage.py config set state.showInUrl '["pdf", "xml"]'
```

## Configuration Processing Architecture

### Backend Processing

Configuration values are processed through a high-level API that abstracts storage details.

#### `fastapi_app/lib/config_utils.py`

Provides a `Config` class and module-level configuration instance:

**High-Level API (recommended)**:

```python
from fastapi_app.lib.config_utils import get_config

# Get config instance (lazy initialization)
config = get_config()

# Get configuration values
value = config.get('session.timeout', default=3600)

# Set configuration values (with validation)
success, message = config.set('session.timeout', 7200)

# Delete configuration keys
success, message = config.delete('old.key')

# Load complete configuration
config_data = config.load()
```

The `get_config()` function returns a module-level config instance preconfigured with settings.db_dir, so you don't need to pass directory paths.

**Alternative - Custom Config Instance**:

For testing or custom db_dir:

```python
from fastapi_app.lib.config_utils import Config
from pathlib import Path

custom_config = Config(Path('/custom/db/dir'))
value = custom_config.get('key')
```

**Configuration Features**:

- **Type validation**: If `<key>.type` exists, validates value matches required JSON type
- **Values constraints**: If `<key>.values` exists, validates value is in allowed values
- **Auto-typing**: New keys automatically get a `.type` constraint based on value's JSON type
- **Thread-safe**: Uses cross-platform file locking (fcntl on Unix, msvcrt on Windows)
- **Dot notation**: Supports keys like `session.timeout` and `session.cookie.name`

#### Using Configuration in Backend Routes

Configuration is accessed via `get_config()`:

```python
from fastapi import APIRouter
from fastapi_app.lib.config_utils import get_config

router = APIRouter()

@router.get("/my-endpoint")
async def my_endpoint():
    # Get config instance
    config = get_config()

    # Get configuration values
    timeout = config.get('session.timeout', default=3600)
    mode = config.get('application.mode', default='production')

    return {
        "timeout": timeout,
        "mode": mode
    }
```

**For Settings Properties**:

Access environment variables and static settings via the Settings object:

```python
from fastapi_app.config import get_settings

settings = get_settings()
host = settings.HOST
port = settings.PORT
data_root = settings.data_root  # Path property
db_dir = settings.db_dir        # Path property
```

**Settings Properties**:

- Environment variables: `HOST`, `PORT`, `DATA_ROOT`, `WEBDAV_ENABLED`, `LOG_LEVEL`, etc.
- Path properties: `data_root`, `db_dir`, `upload_dir`, `config_dir`
- Dynamic properties: `session_timeout` (checks environment, then config.json, then default)
- The Settings class is cached via `@lru_cache`, so `get_settings()` returns the same instance

**Setting Config Values**:

```python
from fastapi_app.lib.config_utils import get_config
from fastapi import HTTPException

@router.post("/custom-config")
async def set_custom(key: str, value: str):
    # Get config instance
    config = get_config()

    # Write custom config value (validates constraints)
    success, message = config.set(key, value)

    if not success:
        raise HTTPException(status_code=400, detail=message)

    return {"result": message}
```

#### `fastapi_app/api/config.py`

REST API endpoints for configuration access:

- **`GET /api/v1/config/list`**: Returns complete configuration object
- **`GET /api/v1/config/get/{key}`**: Returns specific configuration value by key
- **`POST /api/v1/config/set`**: Sets a configuration value (requires authentication)
  - Request body: `{"key": "config.key", "value": <json_value>}`
  - Validates user authentication via session
  - Calls `set_config_value()` which performs validation
  - Logs the configuration change with username

### Frontend Integration

#### `app/src/plugins/config.js`

The config plugin provides client-side access to configuration:

- **API Methods**:
  - `get(key, defaultValue, updateFirst=false)`: Retrieves a configuration value. If `updateFirst` is true, fetches fresh data from server before returning.
  - `set(key, value)`: Sets a configuration value on the server. Validates the key exists before attempting to set.
  - `load()`: Fetches configuration data from server and updates local cache.
  - `toMap()`: Returns configuration as a Map object.

- **Usage Pattern**:

  ```javascript
  import { api as config } from './plugins/config.js';

  // Get a value (uses cached data)
  const mode = await config.get('application.mode');

  // Get with fresh data from server
  const interval = await config.get('heartbeat.interval', 30, true);

  // Set a value (updates server)
  await config.set('application.mode', 'production');

  // Reload configuration cache
  await config.load();
  ```

- **Internal State**:
  - Maintains a local `configMap` object cached from server
  - Automatically loads config on first `get()` call if not already loaded
  - Uses `client.getConfigData()` to fetch from `/api/v1/config/list`
  - Uses `client.setConfigValue(key, value)` to update via `/api/v1/config/set`

### Configuration Flow

1. **Initial Load**:
   - Frontend calls `config.get()` for the first time
   - Plugin fetches complete config via `GET /api/v1/config/list`
   - Backend calls `config.load()` to read `data/db/config.json`
   - Data is cached in `configMap` object

2. **Reading Values**:
   - Frontend calls `config.get(key)` using cached data
   - Or `config.get(key, default, true)` to force server refresh
   - Backend uses `config.get(key, default)` for server-side reads

3. **Writing Values**:
   - Frontend calls `config.set(key, value)`
   - Validates key exists in cached config (throws error if not)
   - Sends `POST /api/v1/config/set` with JSON body
   - Backend validates authentication and session
   - Backend calls `config.set(key, value)` which:
     - Acquires file lock on `config.json`
     - Loads current config
     - Validates value constraints and type
     - Writes updated config
     - Releases file lock

4. **CLI Usage**:
   - CLI calls Python functions from `bin/manage.py`
   - Uses low-level `config_utils.py` functions directly
   - No authentication required for CLI access
