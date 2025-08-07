# PDF-TEI Editor (working title)

A viewer/editor web app to compare the PDF source and TEI extraction/annotation results

![grafik](https://github.com/user-attachments/assets/864185f5-864a-439f-806c-537267470c46)

Note: this is a development prototype, not a production-ready application.

This repo is part of the ["Legal Theory Knowledge Graph" project](https://www.lhlt.mpg.de/2514927/03-boulanger-legal-theory-graph)
at the Max Planck Institute of Legal History and Legal Theory.

Related repositories:

- <https://github.com/mpilhlt/llamore>
- <https://github.com/mpilhlt/bibliographic-tei>

Information for end users [can be found here](./docs/index.md)

## Installation

Install uv and nodejs/npm

```bash
uv sync
npm install
```

## Start the development server

```bash
npm run start
```

Then open <http://localhost:3001>

## Build the application

```bash
npm run build
```

## Other available commands

- **Update import map**: `npm run update-importmap`
- **User management**: `npm run manage <command>`
- **Run tests**: `npm test`
- **Run sync algorithm tests**: `npm run test:sync`

## Using the LLamore extraction engine

To extract references from PDF, the [LLamore library](https://github.com/mpilhlt/llamore) is used. For LLamore to work, you currently need a Gemini API Key (got to <https://aistudio.google.com> to get one). Rename `.env.dist` to `.env` and add the key.

## Public deployments

For public deployments, the current approach using a development server is inadequate.

- You need to put a real http server in front of the flask server.
- File uploads should be checked using the libmagic package to prevent malicious file content. This package depends on the native libmagic library, which is available on Linux via package manager. On Intel MacOS and Windows, use `uv add python-magic-bin`, on Apple Silicon Macs, use Homebrew and `brew install libmagic`. If the bindings are not available, the backend will only check for the correct file extension.

## Development

### Application architecture

The application has a modular architecture that makes it easy to extend. It is also lightweight and does not have a dependency on any particular web framework.

Please note there is no central application instance. All functionality of the application is implemented through plugins, managed by [js-plugin](https://github.com/supnate/js-plugin#readme). In order to propagate state changes throughout the application, invoke [extension endpoints](https://github.com/mpilhlt/pdf-tei-editor/blob/main/app/src/endpoints.js) which may or may not be implemented by other plugins (see [app.js](https://github.com/mpilhlt/pdf-tei-editor/blob/main/app/src/app.js)). The most relevant endpoints, each invoked with the state object, are the following:

- `install`: Invoked once as the first operation of the application, in order to let the plugins add components to the DOM, do server queries to initialize values, etc.
- `start`: Invoked once when all plugins have been installed and the application is starting normal operations
- `state.update` invoked when the application state has changed, each plugin can then update the part of the UI it is responsible for.

New plugins can be easily added without having to change the application.

The UI is (mostly) build with WebComponents provided by <https://shoelace.style> . The UI of the application is mirrored in an object structure, which can be easily traversed in order to locate the UI element via autocompletion (e.g., ui.toolbar.loginButton). In this structure, each named DOM element provides a reference to all named descencdent elements, which can be accessed as virtual properties by the value of the name attribute. The top element of this hierarchy is the default export of [ui.js](https://github.com/mpilhlt/pdf-tei-editor/blob/main/app/src/ui.js).

UI components are generated from HTML templates located in the `app/src/templates` directory. The `createHtmlElements` function in `app/src/ui.js` is used to load these templates and create the corresponding UI elements.

In addition to the loosely coupled way of plugin invocation (which might or might not be listened to), the plugins can also export an "api" object that exposes methods that can be imported and executed where a tightly coupled approach makes more sense.

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

The roles ("user", "admin") are currently not used, but will be in future releases. 

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

## Planned features
 - [ ] Document ownership: lock document version for edits via ownership declaration in the xml until it is removed
 - [ ] Slider to change size of editor window vs. pdf viewer
 - [ ] Real statusbar implementation with permanent sections (such as document info, xpath breadcrumb, etc )
