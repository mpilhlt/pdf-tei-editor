# PDF-TEI Editor

A viewer/editor web app to compare the PDF source and automated TEI extraction/annotation

![grafik](https://github.com/user-attachments/assets/864185f5-864a-439f-806c-537267470c46)

Note: this is a development prototype, not a production-ready application.

This repo is part of the ["Legal Theory Knowledge Graph" project](https://www.lhlt.mpg.de/2514927/03-boulanger-legal-theory-graph)
at the Max Planck Institute of Legal History and Legal Theory.

Related repositories:

- <https://github.com/mpilhlt/llamore>
- <https://github.com/mpilhlt/bibliographic-tei>

Information for end users [can be found here](./docs/index.md)

## Installation

See the dedicated page on [installation](docs/install.md).

## Start the server

### Development server
```bash
npm run start        # or npm run start:dev
```
Uses Flask's development server with hot-reloading and debug mode.
Then open <http://localhost:3001>

### Production server
```bash
npm run start:prod
```
Uses waitress WSGI server optimized for production with multiple threads.

## Build the application

```bash
npm run build
```

## Other available commands

- **Update import map**: `npm run update-importmap`
- **User management**: `npm run manage <command>`
- **Run tests**: `npm test`

## Using the LLamore extraction engine

To extract references from PDF, the [LLamore library](https://github.com/mpilhlt/llamore) is used. For LLamore to work, you currently need a Gemini API Key (got to <https://aistudio.google.com> to get one). Rename `.env.dist` to `.env` and add the key.

## Production deployment

For production deployments, use the production server and a reverse proxy:

### Backend server
```bash
npm run start:prod           # Start production waitress server
# or directly:
./bin/start-prod 127.0.0.1 3001
```

### Security considerations
- **Application mode**: For production deployments, set `"application.mode": "production"` in `config/config.json`. This disables access to development files (`/src/` and `/node_modules/`) that should not be exposed in production.
- File uploads are checked using the libmagic package to prevent malicious file content. This package depends on the native libmagic library, which is available on Linux via package manager. On Intel MacOS and Windows, use `uv add python-magic-bin`, on Apple Silicon Macs, use Homebrew and `brew install libmagic`. If the bindings are not available, the backend will only check for the correct file extension.
- The application includes HTTPS middleware that properly handles X-Forwarded-Proto headers from reverse proxies.

## Development

### Application Architecture

The application uses a **plugin-based architecture** with immutable state management and reactive updates:

#### Plugin System
All functionality is implemented through **Plugin classes** that extend a common base class:

```javascript
class MyPlugin extends Plugin {
  constructor(context) {
    super(context, { name: 'my-plugin', deps: ['dependency'] });
  }
  
  async install(state) {
    // Setup UI components and event handlers
  }
  
  async onStateUpdate(changedKeys) {
    // React efficiently to specific state changes
    if (changedKeys.includes('user')) {
      const user = this.state.user
      this.updateUserUI(user);
    }
  }
  
  async someAction() {
    // Trigger state updates
    await this.dispatchStateChange({ pdf: 'new-document.pdf' });
  }
}
```

#### Core Architecture
- **PluginManager**: Handles plugin registration with automatic dependency resolution
- **StateManager**: Manages immutable state with change detection and history
- **Application**: Orchestrates plugins and state management
- **PluginContext**: Provides controlled access to application services

#### Key Plugin Lifecycle
- `install` - Plugin initialization and DOM setup
- `start` - Application startup after all plugins installed
- `onStateUpdate` - Reactive updates when state properties change
- `dispatchStateChange` - Trigger immutable state updates


#### UI Parts Construction & Documentation

Plugins can programmatically create UI elements or use HTML templates located in the `app/src/templates` directory. The `createHtmlElements` function in `app/src/ui.js` is used to load these templates and create the corresponding DOM elements.

The UI of the application is (mostly) build with WebComponents provided by <https://shoelace.style> . It has an internal hierarchy of named elements and their named descendants, which constitute a logical grouping and are called a "UI Part". These elements can be easily traversed in order to locate a specific UI element via autocompletion (e.g., ui.toolbar.loginButton). The top element of this hierarchy is the default export of [ui.js](https://github.com/mpilhlt/pdf-tei-editor/blob/main/app/src/ui.js). Each part provides a reference to its named descendants through properties with the name of the value of these descendants' "name" attribute. 

The UI hierarchy is documented using JSDoc `@typedef` definitions that describe the structure and properties of each UI part. To annotate a UI part, you use the  `UIPart<T, N>` pattern that combines DOM element type `T` with navigation properties type `N`

For example, a toolbar part might be defined as:
```javascript
/**
 * @typedef {object} toolbarPart
 * @property {SlButton} saveButton - Save document button
 * @property {UIPart<SlButtonGroup, actionPart>} actions - Button group for document actions, defined in a separate part typedef
 */
```

This documentation system ensures type safety and provides comprehensive autocompletion support throughout the JavaScript codebase without requiring TypeScript compilation.

### Template Registration System

The application uses a modern template registration system that optimizes performance for both development and production:

**Key Features:**
- **Development Mode** (`?dev`): Templates loaded dynamically from files for fast iteration
- **Production Mode**: Templates pre-bundled into `templates.json` for optimal performance  
- **Parameter Substitution**: Templates support `${param}` syntax for dynamic content
- **Type Safety**: Synchronous template creation with proper TypeScript support

**Basic Usage:**
```javascript
// Register templates at module level
import { registerTemplate, createFromTemplate, createSingleFromTemplate } from '../ui.js';

await registerTemplate('dialog-template', 'dialog.html');
await registerTemplate('button-template', 'button.html');

// Create elements synchronously in install functions
async function install(state) {
  // Create single element (no [0] suffix needed)
  const button = createSingleFromTemplate('button-template');
  
  // Create with parameters
  const customButton = createSingleFromTemplate('button-template', null, {
    text: 'Save Document',
    variant: 'primary'
  });
}
```

**Build Integration:**
- Templates are automatically analyzed and bundled during `npm run build`
- Build script `bin/bundle-templates.js` scans for `registerTemplate()` calls
- Development mode uses live template files, production uses bundled JSON

## Dev environment

During development, it is often easier to work with the NPM source files rather than the compiled bundle. You can load the application in this mode by attaching `?dev` to the URL, for example, `http://localhost:3001?dev`.

When you change the NPM dependencies, `npm run update-importmap` so that the source version picks up this change. Once you are done with working on the source code, run `npm run build` to regenerate the bundle.

## Git Hooks via Husky

The project uses a "pre-push" git hook via [Husky](https://typicode.github.io/husky/). In order for this to work, you need to inialize Husky that the hook scripts are executed in the project's virtual environment

```bash
npx husky init
mkdir -p ~/.config/husky/ && echo "source .venv/bin/activate" > ~/.config/husky/init.sh && chmod +x ~/.config/husky/init.sh
```

## Authentication and User Management

The application uses a simple, file-based authentication system. User data is stored in `db/users.json`. You can manage users with the `npm run manage` command.

### User management commands

- **List users:** `npm run manage user list`
- **Add a user:** `npm run manage user add <username> --password <password> --fullname "<Full Name>" --email "<email>"`
- **Remove a user:** `npm run manage user remove <username>`
- **Update a user's password:** `npm run manage user update-password <username> --password <new_password>`
- **Add a role to a user:** `npm run manage user add-role <username> <rolename>`
- **Remove a role from a user:** `npm run manage user remove-role <username> <rolename>`
- **Set a user's property:** `npm run manage user set <username> <property> <value>` (properties: fullname, username, email)

For more information, run `npm run manage help` or `npm run manage help user`.

The default user is "admin" with a password of "admin". Please remove that user immediately and add your own instead:

```bash
npm run manage user remove admin
npm run manage user add myusername --password myuserpass --fullname "Full Name" --email "user@example.com"
npm run manage user add-role myusername admin
```

Currently, only the roles "user" and "admin" are used. A more fine-grained permission system will be added if necessary later.

## XML Schema Validation and Autocomplete

The PDF-TEI Editor supports two types of XML schema validation: **XSD (XML Schema Definition)** and **RelaxNG (Regular Language for XML Next Generation)**. The validation approach is automatically detected based on how the schema is declared in your XML documents.

### XSD Validation

For XSD-based validation, use the standard `xsi:schemaLocation` attribute in your root element:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.tei-c.org/ns/1.0 https://tei-c.org/release/xml/tei/custom/schema/xsd/tei_all.xsd">
  <teiHeader>
    <!-- Your TEI content -->
  </teiHeader>
</TEI>
```

**Features:**
- Full validation against XSD schemas
- No autocomplete support (XSD schemas are not compatible with the autocomplete generator)

### RelaxNG Validation

For RelaxNG-based validation, use the `xml-model` processing instruction:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<?xml-model href="https://tei-c.org/release/xml/tei/custom/schema/relaxng/tei_all.rng" 
            type="application/xml" 
            schematypens="http://relaxng.org/ns/structure/1.0"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <!-- Your TEI content -->
  </teiHeader>
</TEI>
```

**Features:**

- Full validation against RelaxNG schemas
- **Intelligent autocomplete** with TEI documentation extracted directly from the schema
- Context-aware suggestions for elements, attributes, and attribute values
- Documentation popups with detailed explanations from the TEI schema

The autocomplete system uses the schema file specified in the `xml-model` processing instruction to generate contextual suggestions with full TEI documentation support.

### Schema Caching

Both XSD and RelaxNG schemas are downloaded and cached automatically when first encountered. The cache is stored in the `schema/cache` directory. To refresh cached schemas, simply delete the `schema/cache` directory manually.

### Best Practices

- **For validation only**: Use XSD schemas with `xsi:schemaLocation`
- **For validation + autocomplete**: Use RelaxNG schemas with `xml-model` processing instructions
- **TEI Projects**: RelaxNG is recommended as it provides the full editing experience with intelligent autocomplete and documentation

