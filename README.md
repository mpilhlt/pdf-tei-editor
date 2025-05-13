# pdf-tei-editor

A viewer/editor web app to compare the PDF source and TEI extraction/annotation results

![grafik](https://github.com/user-attachments/assets/864185f5-864a-439f-806c-537267470c46)


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
python.exe bin\download-pdfjs
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

To extract references from PDF, the [LLamore library](https://github.com/mpilhlt/llamore) is used. Since it is work in progress, we use the GitHub source. As we do not include it as a submodule in this repo, it needs to be installed separately:

```bash
git clone https://github.com/mpilhlt/llamore.git
uv pip install -r llamore/pyproject.toml
```

Once the library stabilizes, the PyPi distribution will be used.

For LLamore to work, you currently need a Gemini API Key (got to <https://aistudio.google.com> to get one). Rename `.env.dist` to `.env` and add the key.

## Public deployments

For public deployments, the development server is inadequate. You need to put a real http server in front of the flask server. In addition, file uploads should be checked using the libmagic package to prevent malicious file content. This package depends on the native libmagic library, which is available on Linux via package manager. On Intel MacOS and Windows, use `uv add python-magic-bin`, on Apple Silicon Macs, use Homebrew and `brew install libmagic`. If the bindings are not available, the backend will only check for the correct file extension.

## Application architecture

The application has a modular architecture that makes it easy to extend. It is also lightweight and does not involve any particular framework.

In particular, there is no central application instance. All functionality of the application is implemented through plugins, based on the [js-plugin](https://github.com/supnate/js-plugin#readme) plugin manager. In order to propagate state changes throughout the application, invoke [extension endpoints](./src/endpoints.js) implemented by other plugins (see [app.js](./src/app.js)). The most relevant endpoints, each invoked with the state object, are the following:

 - `install`: Invoked once as the first operation of the application, in order to let the plugins add components to the DOM, do server queries to initialize values, etc. 
 - `start`: Invoked once when all plugins have been installed and the application is starting normal operations 
 - `state.update` invoked when the application state has changed, each plugin can then update the part of the UI it is responsible for. 

New plugins can be easily added without having to change the application.

The UI is (mostly) build with WebComponents provided by https://shoelace.style . The UI of the application is mirrored in an object structure, which can be easily traversed in order to locate the UI element via autocompletion (e.g., ui.toolbar.loginButton). In this structure, each named DOM element encapsulates all named descencdent elements, which can be accessed as virtual properties by the value of the name attribute. The top element of this hierarchy is the default export of [ui.js](./src/ui.js).

In addition to the loosely coupled approach realized via plugin invocation, the plugins can also export an "api" object that exposes methods that can be imported and executed where this approach makes more sense.
