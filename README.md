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

## Start the server

```bash
./bin/server
```

On Windows, use

```powershell
python.exe bin\server
```

Then open <http://localhost:3001/web/index.html>

## To use the LLamore extraction engine

For the moment, we use the GitHub source.

```bash
git clone https://github.com/mpilhlt/llamore.git
uv pip install -r llamore/pyproject.toml
```

Once it stabilizes, the PyPi distribution will be used.

The backend checks file uploads, which requires the libmagic library installed. On Intel MacOS and Windows, use `uv add python-magic-bin`, on Apple Silicon Macs, use Homebrew and `brew install libmagic`.

Currently, you also need a Gemini API Key (got to <https://aistudio.google.com> to get one). Rename `.env.dist` to `.env` and add the key.
