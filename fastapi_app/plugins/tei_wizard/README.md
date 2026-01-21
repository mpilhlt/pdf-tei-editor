# TEI Wizard Enhancement Registry

The TEI Wizard plugin provides a central registry for TEI document enhancement scripts. Other backend plugins can register their own enhancements by declaring `tei-wizard` as a dependency.

## Registering Enhancements

### 1. Declare the Dependency

In your plugin's `metadata`, add `tei-wizard` to the `dependencies` list:

```python
@property
def metadata(self) -> dict[str, Any]:
    return {
        "id": "my-plugin",
        "name": "My Plugin",
        "description": "...",
        "category": "analysis",
        "version": "1.0.0",
        "required_roles": ["*"],
        "dependencies": ["tei-wizard"]  # Required
    }
```

### 2. Register Enhancements in `initialize()`

Access the `tei-wizard` plugin via the context and register your enhancement files:

```python
async def initialize(self, context: PluginContext) -> None:
    tei_wizard = context.get_dependency("tei-wizard")
    if tei_wizard:
        enhancements_dir = Path(__file__).parent / "enhancements"
        tei_wizard.register_enhancement(
            enhancements_dir / "my-enhancement.js",
            self.metadata["id"]
        )
```

### 3. Create the Enhancement File

Enhancement files must use a strict ES module format with named exports:

```javascript
/**
 * @file Enhancement: Description of what this enhancement does
 */

/**
 * Human-readable name shown in the UI
 */
export const name = "My Enhancement Name";

/**
 * Description shown as tooltip in the UI
 */
export const description = "What this enhancement does to the document.";

/**
 * The enhancement function.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {Object} currentState - The current application state
 * @param {Map<string, any>} configMap - The application configuration map
 * @returns {Document} - The modified XML DOM Document object
 */
export function execute(xmlDoc, currentState, configMap) {
  // Your enhancement logic here
  // MUST be a pure function - only modify xmlDoc based on inputs
  return xmlDoc;
}
```

## Enhancement File Requirements

- **Named exports only**: Use `export const name`, `export const description`, and `export function execute`
- **No imports**: Import statements are stripped during transformation
- **Pure function**: The `execute` function must only modify `xmlDoc` based on its inputs - no side effects, network calls, or DOM manipulation outside the document
- **Return the document**: Always return the modified `xmlDoc`

## How It Works

1. During server startup, the `tei-wizard` plugin registers its default enhancements
2. Dependent plugins register their enhancements via `register_enhancement()`
3. The frontend fetches `/api/plugins/tei-wizard/enhancements.js`
4. The backend transforms each ES module to a self-registering IIFE and concatenates them
5. The frontend executes the bundle, which registers each enhancement via `window.registerTeiEnhancement()`
6. The TEI Wizard UI displays all registered enhancements as checkboxes

## API Reference

### `TeiWizardPlugin.register_enhancement(file_path, plugin_id)`

Register an enhancement JavaScript file.

- `file_path` (Path): Absolute path to the `.js` file
- `plugin_id` (str): Your plugin's ID (used for logging and debugging)

### `TeiWizardPlugin.get_enhancement_files()`

Returns a list of `(Path, plugin_id)` tuples for all registered enhancements.

## Example Plugin Structure

```
fastapi_app/plugins/my_plugin/
├── __init__.py
├── plugin.py
└── enhancements/
    ├── fix-encoding.js
    └── add-metadata.js
```
