# PDF-TEI Editor (working title)

A viewer/editor web app to compare the PDF source and TEI extraction/annotation results

![grafik](https://github.com/user-attachments/assets/864185f5-864a-439f-806c-537267470c46)

Note: this is a development prototype, not a production-ready application.

This repo is part of the ["Legal Theory Knowledge Graph" project](https://www.lhlt.mpg.de/2514927/03-boulanger-legal-theory-graph)
at the Max Planck Institute of Legal History and Legal Theory.

Related repositories:

- <https://github.com/mpilhlt/llamore>
- <https://github.com/mpilhlt/bibliographic-tei>

Information for end users can be found [here](./docs/index.md)

## Installation

Install uv and nodejs/npm

```bash
uv sync
npm install
```

On Windows, use

```powershell
uv sync
npm --ignore-scripts install
uv run python bin\download-pdfjs
```

## Start the development server

```bash
./bin/server
```

On Windows, use

```powershell
uv run python bin\server
```

Then open <http://localhost:3001/web/index.html>

## Using the LLamore extraction engine

To extract references from PDF, the [LLamore library](https://github.com/mpilhlt/llamore) is used. For LLamore to work, you currently need a Gemini API Key (got to <https://aistudio.google.com> to get one). Rename `.env.dist` to `.env` and add the key.

## Public deployments

For public deployments, the current approach using a development server is inadequate.

- You need to put a real http server in front of the flask server.
- File uploads should be checked using the libmagic package to prevent malicious file content. This package depends on the native libmagic library, which is available on Linux via package manager. On Intel MacOS and Windows, use `uv add python-magic-bin`, on Apple Silicon Macs, use Homebrew and `brew install libmagic`. If the bindings are not available, the backend will only check for the correct file extension.

## Application architecture

The application has a modular architecture that makes it easy to extend. It is also lightweight and does not have a dependency on any particular web framework.

Please note there is no central application instance. All functionality of the application is implemented through plugins, managed by [js-plugin](https://github.com/supnate/js-plugin#readme). In order to propagate state changes throughout the application, invoke [extension endpoints](./src/endpoints.js) which may or may not be implemented by other plugins (see [app/src/app.js](./src/app.js)). The most relevant endpoints, each invoked with the state object, are the following:

- `install`: Invoked once as the first operation of the application, in order to let the plugins add components to the DOM, do server queries to initialize values, etc.
- `start`: Invoked once when all plugins have been installed and the application is starting normal operations
- `state.update` invoked when the application state has changed, each plugin can then update the part of the UI it is responsible for.

New plugins can be easily added without having to change the application.

The UI is (mostly) build with WebComponents provided by <https://shoelace.style> . The UI of the application is mirrored in an object structure, which can be easily traversed in order to locate the UI element via autocompletion (e.g., ui.toolbar.loginButton). In this structure, each named DOM element provides a reference to all named descencdent elements, which can be accessed as virtual properties by the value of the name attribute. The top element of this hierarchy is the default export of [ui.js](./src/ui.js).

In addition to the loosely coupled way of plugin invocation (which might or might not be listened to), the plugins can also export an "api" object that exposes methods that can be imported and executed where a tightly coupled approach makes more sense.
