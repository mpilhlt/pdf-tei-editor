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

