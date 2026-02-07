# Batch Processing

When you have a large number of files to process, you can use the batch processing feature to process them all at once.

The repository contains several batch processing scripts in the `bin` directory:

- [batch-extract.js](https://github.com/mpilhlt/pdf-tei-editor/blob/main/bin/batch-extract.js) - uploads PDF files and/or extracts TEI from PDF files
- [export_files.py](https://github.com/mpilhlt/pdf-tei-editor/blob/main/bin/export_files.py) - exports one or more collections of PDF/TEI to a folder structure
- [import_files.py](https://github.com/mpilhlt/pdf-tei-editor/blob/main/bin/import_files.py) - imports PDF/TEI files into collections

## Installation and requirements

To use the scripts, you need to have a recent version of Node.js installed on your system. For the python scripts, you need [`uv`](https://docs.astral.sh/uv/getting-started/installation/).

Then, you need to clone or download the repository, install the required dependencies, and run the scripts from within the repository directory.

To download as a ZIP:

```bash
curl -L -O  https://github.com/mpilhlt/pdf-tei-editor/archive/refs/heads/main.zip
unzip main.zip  
cd pdf-tei-editor-main  
npm install 
uv sync # only for the python scripts
```

Using `git clone`

```bash
git clone https://github.com/mpilhlt/pdf-tei-editor.git
cd pdf-tei-editor
npm install
uv sync # only for the python scripts
```

## Authentication

In order to use the scripts, you need to store your credentials in a file called `.env` in the directory from which you launch the scripts. The file should contain the following lines:

```env
API_USER=<your user name>
API_PASSWORD=<your password>
API_BASE_URL=<the url of the PDF-TEI-Editor instance>
```

## Batch Extraction

The batch extraction script is used to upload files from your local computer to the PDF-TEI-Editor instance and/or extract TEI from uploaded PDF files.

### Usage

To see all available options run: `node bin/batch-extract.js --help` or `npm run batch-extract -- --help`

This shows the following help message:

```text

Usage: batch-extract [options] [path]

Batch extract metadata from PDFs in a directory

Arguments:
  path                   Directory containing PDF files (required unless --extract-only)

Options:
  --env <path>           Path to .env file (default: "./.env")
  --user <username>      Username for authentication (default: from .env API_USER)
  --password <password>  Password for authentication (default: from .env API_PASSWORD)
  --base-url <url>       API base URL (default: from .env API_BASE_URL or http://localhost:8000)
  --collection <id>      Collection ID (default: directory basename, required for --extract-only)
  --extractor <id>       Extractor ID (can be specified multiple times)
  --option <key=value>   Extractor option (repeatable)
  --recursive            Recursively search directories (default: false)
  --extract-only         Extract from existing files in collection (no upload) (default: false)
  -h, --help             display help for command

DOI Filename Encoding:
  If PDF filenames contain DOIs, they will be automatically extracted and passed
  to the extractor. Encode DOIs in filenames by replacing "/" with "__" (double underscore).

  Example: "10.5771/2699-1284-2024-3-149.pdf" → "10.5771__2699-1284-2024-3-149.pdf"
```

### Running the script

It is advised to create a small batch script which can be more easily edited and reused than the command line.

For example, create this script `batch-extract.sh`

```shell
# run from the project root

# first upload and extract using grobid
npm run batch-extract -- \
     --extractor grobid \
     --option variant_id=grobid.service.references \
     --option flavor=article/dh-law-footnotes \
     --collection mycollection \
     '/path/to/pdfs'

# now extract using the llamore extractor
npm run batch-extract -- \
    --extractor llamore-gemini \
    --option variant_id=llamore-default \
    --extract-only \
    --collection omycollectiono

```

and then run it using `bash batch-extract.sh`

### Usage recommendations

Since the PDF-TEI-Editor is a tool for manual annotation and quality control rather than for processing large batches of documents, we recommend to keep the collections small and manageable. If you have a larger number of documents, they should be broken up in smaller batches, which are stored in one collection each.

For this, you can create scripts which traverse a directory tree and create collections for documents in subdirectories or based on filename patterns.

For example, given a directory of PDFs named by year (e.g., `2005_1.pdf`, `2005_2.pdf`, `2023_article.pdf`), the following script creates one collection per year and uploads the matching files:

```shell
#!/bin/bash
# batch-by-year.sh - Upload PDFs grouped by year prefix into per-year collections
# Usage: bash batch-by-year.sh /path/to/pdfs

PDF_DIR="${1:?Usage: bash batch-by-year.sh /path/to/pdfs}"

# Find all year prefixes from filenames matching YYYY_*.pdf
years=$(ls "$PDF_DIR"/*.pdf 2>/dev/null | xargs -n1 basename | grep -oE '^[0-9]{4}' | sort -u)

if [ -z "$years" ]; then
  echo "No PDF files matching YYYY_*.pdf found in $PDF_DIR"
  exit 1
fi

for year in $years; do
  echo "--- Processing collection: $year ---"

  # Create a temp directory with symlinks to matching PDFs
  tmpdir=$(mktemp -d)
  for pdf in "$PDF_DIR"/${year}_*.pdf; do
    ln -s "$(realpath "$pdf")" "$tmpdir/"
  done

  # Upload and extract 
  npm run batch-extract -- \
    --extractor grobid \
    --extractor llamore-gemini \
    --option variant_id=llamore-default \ 
    --collection "$year" \
    "$tmpdir"

  rm -rf "$tmpdir"
done
```

## Import and Export

TODO
