# Frontend Architecture

Quick reference for understanding the frontend application structure.

For backend architecture, see [architecture-backend.md](./architecture-backend.md).
For comprehensive architecture details, see [development/architecture.md](../development/architecture.md).

## Frontend (JavaScript/ES Modules)

- **Plugin architecture**: All functionality implemented as plugins in `app/src/plugins/`
- **Core files**:
  - `app/src/app.js` - Main application bootstrap and plugin registration
  - `app/src/endpoints.js` - Defines plugin extension points
  - `app/src/ui.js` - UI element management and DOM structure
  - `app/src/state.js` - Application state object definition
- **Templates**: `app/src/templates/` - HTML templates for UI components
- **Build output**: `app/web/` - Compiled/bundled frontend assets

## LLM Findings Display

`app/src/modules/llm-findings.js` is the editor-side display of LLM findings `{id, old, new, rationale}`, shared by the `annotation-review` plugin extension and `app/src/plugins/ocr-review.js`. `FindingsDisplay` shows the findings as CodeMirror diagnostics via `lint-utils` (with "Propose fix"/Apply actions), caches them per document in the session (`FindingsCache`) and restores them when a document is reopened. `locateFinding()` finds the exact, unique place of `old` in the document text; `buildModifiedText()` applies a finding. Pass the source name, `getXmleditor`, `getLintUtils`, a `proposeFix` callback and `getDocId` to the constructor.

## Plugin System

The application uses two independent plugin systems - one for frontend (JavaScript) and one for backend (Python). See [../development/plugin-system.md](../development/plugin-system.md) for overview.

### Frontend Plugins

Frontend plugins extend the browser UI using a class or object-based architecture with dependency resolution, state management, and lifecycle hooks.

For detailed information:
- [Frontend Plugin System Architecture](../development/plugin-system-frontend.md)
- [Frontend Plugin Development Guide](./plugin-development.md)

### Backend Plugins

Backend plugins provide server-side functionality and API endpoints with role-based access control.

For detailed information:
- [Backend Plugin System Architecture](../development/plugin-system-backend.md)
- [Backend Plugin Development Guide](./backend-plugins.md)

## UI Component System

The application uses a typed UI hierarchy system:

### UI Part Naming Convention

- Each UI part typedef is called a "part" and follows camelCase naming
- Part names always end with "Part" (e.g., `toolbarPart`, `dialogPart`)
- Since UI parts represent singletons in the UI, they use lowercase naming

### UI Part Location and Documentation

- UI parts are defined in the plugin that uses/creates them
- Each part documents the named element hierarchy from its HTML templates
- UI parts use the `UIPart<T, N>` generic type that combines DOM element type `T` with navigation properties type `N`

### Type Usage Rules

- When a UI part property is a pure HTMLElement with no navigation properties, use the DOM element type directly
- When a UI part has child navigation properties, use `UIPart<DOMElementType, NavigationPropertiesType>`
- Elements serve as both DOM elements and navigation objects - no `self` property needed
- Access DOM methods directly: `ui.dialog.show()` instead of `ui.dialog.self.show()`

### Example

```javascript
// UI part definition
/**
 * @typedef {object} dialogPart
 * @property {HTMLSpanElement} message - Direct DOM element (no navigation)
 * @property {SlButton} closeBtn - Direct DOM element (no navigation)
 */

// Usage in parent part
/**
 * @typedef {object} namedElementsTree
 * @property {UIPart<SlDialog, dialogPart>} dialog - Dialog with navigation properties
 */

// Usage in code
ui.dialog.show()                    // Call DOM method directly
ui.dialog.message.innerHTML = text  // Access child element
```

## Template Registration System

The application uses a modern template registration system supporting both development and production modes:

### Overview

- **Development Mode** (`?dev` parameter): Templates loaded dynamically from files for fast iteration
- **Production Mode**: Templates bundled into `templates.json` for optimal performance
- **Synchronous Creation**: Templates pre-loaded during registration, creation is fast and synchronous
- **Parameter Substitution**: Support for `${param}` syntax in templates

### Basic Usage

```javascript
// In plugin files - register templates at module level
import { registerTemplate, createFromTemplate, createSingleFromTemplate } from '../ui.js';

// Register templates (async, happens at module load)
await registerTemplate('dialog-template', 'dialog.html');
await registerTemplate('button-template', 'button.html');

// Create elements in install() function (synchronous)
async function install(state) {
  // Create multiple elements
  const elements = createFromTemplate('dialog-template', document.body);

  // Create single element (no [0] suffix needed)
  const button = createSingleFromTemplate('button-template');

  // Parameter substitution
  const customButton = createSingleFromTemplate('button-template', null, {
    text: 'Save Document',
    variant: 'primary'
  });
}
```

### Template Registration Rules

1. **Import from ui.js**: Always import template functions from `../ui.js` (not ui-system.js directly)
2. **Register at module level**: Use `await registerTemplate()` at the top level of plugin files
3. **Synchronous creation**: Use `createFromTemplate()` or `createSingleFromTemplate()` in install functions
4. **Call updateUi() when needed**: If elements aren't automatically added to DOM with parent node

### Build System Integration

- **Development**: Templates loaded via fetch from `app/src/templates/`
- **Production**: `scripts/build/bundle-templates.js` analyzes code and generates `templates.json`
- **Build process**: Template bundling runs automatically during `npm run build`

## Links to the User Manual

To link to a section of the user manual from a description, dialog or rendered Markdown, use the GitHub blob URL of the docs file with the heading anchor, e.g. `https://github.com/mpilhlt/pdf-tei-editor/blob/main/docs/development/api-reference.md#programmatic-api-access`. Outside the app, the link opens the page on GitHub. Inside the app, the `info` plugin intercepts clicks on such links anywhere in the DOM (including shadow roots) and opens the section in the user manual drawer; the ref in the URL is ignored, since the drawer always shows the docs of the running version. A link inside an open `sl-dialog` hides the dialog until the drawer is closed. Clicks with a modifier key keep the browser's default behaviour.

- Only Markdown files under `docs/` are intercepted (`parseManualUrl()` in `app/src/modules/manual-links.js`); other files of the repository, such as `README.md`, open on GitHub. Same-origin manual window URLs (`/manual/...`) are intercepted as well.
- In code, open a section with `InfoPlugin.open('<path>#<anchor>')` or `InfoPlugin.openUrl(url)`, and build a link with `manualUrl(path, anchor, ref)`. Links written into code and docs stay GitHub blob URLs, since they must not depend on an installation.
- Users get the link of a section from the "Copy link" button shown when hovering a heading in the manual; it copies the manual window URL of the section (`manualWindowUrl()`), which only works on the installation it was copied from.

Manual pages can contain slots (`<!-- plugin-docs: <slot> -->`) that the drawer fills with links to pages contributed by plugins; see [Backend Plugins - Manual Pages](backend-plugins.md#manual-pages).

## User Manual Window and Search

The manual is rendered by `ManualViewer` (`app/src/modules/manual-viewer.js`, a subclass of `MarkdownPageViewer` in `app/src/modules/markdown-page-viewer.js`), which the drawer (`app/src/plugins/info.js`) and the standalone manual window share. The viewer fetches core pages from `docs/` (the drawer also from GitHub with `docs.from-github`) and plugin pages from `/api/v1/manual/plugins/...`, renders them, fills the slots and turns links to other manual pages into `onNavigate` calls.

- **Window**: the backend serves `app/web/manual.html` for every path below `/manual/` (`fastapi_app/main.py`), without authentication. `app/web/bootstrap.js` loads the entry point named by `data-entry="manual"`: `app/src/manual.js` (`?dev`) or the bundle `app/web/manual.js` (second input in `rollup.config.js`; `manual.js` is also an entry point of the importmap generator). The window does not start the application. URLs: `/manual/<path below docs/ without .md>#<anchor>`, `/manual/plugins/<plugin id>/<file without .md>`, `?lang=<code>` for the language of plugin pages (`manualWindowUrl()` / `parseManualWindowUrl()`). Navigation uses `history.pushState`. The window lists plugin pages with `GET /api/v1/manual/contributions?all_roles=true`: roles only keep the drawer free of pages that do not concern the user.
- **Search**: `app/src/modules/manual-search.js` builds a full-text index with one entry per section (heading and text up to the next heading) and ranks matches by field: page title 8, heading 5, plugin page description 3, body 1 per query word, plus bonuses for exact words and phrases. `app/src/modules/manual-search-box.js` has the search field and result list (`ManualSearchBox`), loads the index on first use (`loadManualIndex()`: core pages from `GET /api/v1/manual/pages`, plugin pages from the contributions, fetched through the viewer) and highlights the query words in the opened section (`markSectionMatches()`). The core page list (`fastapi_app/lib/utils/manual_pages.py`) is `index.md`, `about.md` and `user-manual/**`, in link order from `index.md`; developer documentation is not searched.

`attachDrawerSearch()` in `manual-search-box.js` connects a drawer's search button, `Ctrl+K` and `Esc` to its search field; both the manual and the annotation guide drawer use it.

## Annotation Guide Window and Search

The annotation guide drawer (`app/src/plugins/annotation-guide.js`) and the standalone guide window (`app/src/guide.js`, `app/web/guide.html`, third Rollup bundle and importmap entry point, `data-entry="guide"`) render the guide with `GuideViewer` (`app/src/modules/guide-viewer.js`, also a `MarkdownPageViewer`). The viewer fetches the guide as raw text (`blobUrlToRawUrl()`), resolves images against the raw URL, sanitizes the HTML with DOMPurify (`sanitizeHtml()`; the guide comes from another site, and a document's editorialDecl can point anywhere) and opens links to other files on the forge.

- **Window**: the backend serves `app/web/guide.html` for every path below `/guide/`, without authentication. URLs: `/guide/<guide id>?ref=<commit>#<anchor>` (`guideWindowUrl()` / `parseGuideWindowUrl()` in `app/src/modules/guide-links.js`); `/guide/` lists the guides. The window renders only the Markdown guide files that the extractors declare, listed by `GET /api/v1/annotation-guides` (`fastapi_app/lib/utils/annotation_guides.py`): one entry per file with a readable id (repository and file name, e.g. `fossil-guidelines`) and a `url_template` with `{ref}` in place of the branch. `ref` must be a commit SHA, since documents pin their guide refs to commits; `findGuide()` maps a document's ref URL to the guide and commit. The window shows no personal versions (overrides need a session); the drawer does.
- **Search**: the drawer and the window build the index from the one guide shown (`buildIndex()` with a single page) and use `ManualSearchBox` with `groupByPage: false` and `subject: 'the guide'`.

The table of contents drop-up and the heading link buttons of the user manual and the annotation guide drawers come from `app/src/modules/markdown-toc.js`.
