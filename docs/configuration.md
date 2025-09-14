# Configuration Management

The PDF-TEI-Editor uses JSON configuration files to manage application settings. Configuration can be managed via the command-line interface.

## Configuration Files

- **`db/config.json`** - Runtime configuration (user-specific, gitignored)
- **`config/config.json`** - Default configuration (version-controlled)

## CLI Commands

### Get Configuration Values

```bash
# Get value from db/config.json
./bin/manage.py config get <key>

# Get value from config/config.json
./bin/manage.py config get <key> --default
```

### Set Configuration Values

```bash
# Set in db/config.json only
./bin/manage.py config set <key> <json_value>

# Set in both db/config.json and config/config.json
./bin/manage.py config set <key> <json_value> --default

# Set value constraints
./bin/manage.py config set <key> --values '["option1", "option2"]'

# Set type constraints
./bin/manage.py config set <key> --type "string"
```

### Delete Configuration Keys

```bash
# Delete from db/config.json only
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