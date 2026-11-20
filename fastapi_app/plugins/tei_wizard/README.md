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
 * @param {Object} env - The execution environment (see below)
 * @returns {Document} - The modified XML DOM Document object
 */
export function execute(xmlDoc, currentState, configMap, env) {
  // Your enhancement logic here
  // MUST be a pure function - only modify xmlDoc based on inputs
  return xmlDoc;
}
```

### Optional Exports

`variants` and `appliesTo` restrict the documents the enhancement is offered for; without them, it is offered for every TEI document. `confirmation` makes the wizard ask before running the enhancement.

```javascript
/**
 * Variant ids the enhancement is offered for; an id ending in `*` matches every variant that
 * starts with the rest of the id. A document without a variant only gets the enhancements
 * without this export.
 */
export const variants = ["grobid.training.references", "grobid.training.references.referenceSegmenter"];

/**
 * Further test, as `appliesTo` of the XSL viewer's stylesheets: an XPath expression (prefixes
 * `tei` and `xml` bound, result converted to a boolean) or a function that receives the document
 */
export const appliesTo = "//tei:listBibl";

/**
 * Question the user has to confirm before the enhancement runs (title: the enhancement's name)
 */
export const confirmation = "Convert XML comments into document comments?";
```

### Execution Environment

`execute()` receives an `EnhancementEnv` object as fourth argument:

| Property | Type | Content |
| --- | --- | --- |
| `variant` | `string \| null` | Variant id of the document (`variant-id` label of its extractor) |
| `unitPath` | `string \| null` | Review unit path configured for the variant by its extractor (`reviewUnits`), `null` if none or `auto` |
| `findUnits` | `(doc: Document) => Element[]` | The review unit elements of a document by `unitPath`; `[]` without a path, for `pages` and if nothing matches |

## Enhancement File Requirements

- **Named exports only**: Use `export const name`, `export const description`, and `export function execute`, optionally `export const variants`, `export const appliesTo` and `export const confirmation`
- **No imports**: Import statements are stripped during transformation
- **Pure function**: The `execute` function must only modify `xmlDoc` based on its inputs - no side effects, network calls, or DOM manipulation outside the document
- **Return the document**: Always return the modified `xmlDoc`

## How It Works

1. During server startup, the `tei-wizard` plugin registers its default enhancements
2. Dependent plugins register their enhancements via `register_enhancement()`
3. The frontend fetches `/api/plugins/tei-wizard/enhancements.js`
4. The backend transforms each ES module to a self-registering IIFE and concatenates them
5. The frontend executes the bundle, which registers each enhancement via `window.registerTeiEnhancement()`
6. The TEI Wizard dropdown in the XML editor toolbar lists the enhancements that apply to the current document; choosing one runs it and shows the result in the merge view

## API Reference

### `TeiWizardPlugin.register_enhancement(file_path, plugin_id)`

Register an enhancement JavaScript file.

- `file_path` (Path): Absolute path to the `.js` file
- `plugin_id` (str): Your plugin's ID (used for logging and debugging)

### `TeiWizardPlugin.get_enhancement_files()`

Returns a list of `(Path, plugin_id)` tuples for all registered enhancements.

## Built-in Enhancements

The `tei-wizard` plugin registers these enhancements from its own `enhancements/` directory:

### Pretty Print XML (`pretty-print-xml.js`)

Indents the XML DOM by inserting whitespace text nodes. The algorithm is content-aware:

- A node's children are indented only when the node has block-level element children (elements not in the inline list).
- Nodes that contain only text and inline elements (e.g. a `<listBibl>` holding unsegmented raw text, a `<note>` with only `<lb/>`-separated lines) are left untouched so text flow is preserved.
- Stray text nodes that appear between block children (messy extraction output) are preserved in place.

Some elements are kept: their content is left exactly as it is, including the whitespace between inline elements.

- **Review units**: if the document's variant has a review unit path (`reviewUnits` of its extractor, see `env.findUnits`), every unit is kept and starts on its own line, and the ancestors of the units are indented as block elements. Variants without a unit path (or with `auto` or `pages`) get the generic behavior.
- **teiHeader**: the elements of `tei.pretty-print.header-keep` and every element with mixed content (child elements and text that is not whitespace only) are kept.

Three lists are configurable in `config.json`:

| Config key | Default | Purpose |
| --- | --- | --- |
| `tei.pretty-print.no-indent-inside` | `["bibl", "p", "ab"]` | Explicit override: children of these elements are never indented even though the dynamic check would indent them (e.g. `bibl` contains `author`/`title` which are not inline but should not be indented). |
| `tei.pretty-print.inline-elements` | `["lb", "pb", "hi", "ref", ...]` | Elements treated as always-inline: no leading indent is inserted before them, and their own children are not indented. |
| `tei.pretty-print.header-keep` | `["desc"]` | Elements of the `teiHeader` whose content is never reformatted. |

### Convert XML comments (`convert-xml-comments.js`)

Turns the XML comments inside `<text>` into unit comments (`TEI/standOff/listAnnotation[@type="unit-comment"]`) by the current user and removes them from the text. Asks for confirmation before it runs.

## Example Plugin Structure

```text
fastapi_app/plugins/my_plugin/
├── __init__.py
├── plugin.py
└── enhancements/
    ├── fix-encoding.js
    └── add-metadata.js
```
