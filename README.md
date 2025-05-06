# pdf-tei-editor

A viewer/editor web app to compare the PDF source and TEI extraction/annotation results

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
python.exe bin\server
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


