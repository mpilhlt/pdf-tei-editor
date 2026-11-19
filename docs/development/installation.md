# Installation Overview

This guide provides an overview of different installation and setup options for the PDF-TEI Editor.

## 🚀 Quick Testdrive with Docker

**The fastest way to try PDF TEI Editor:**

```bash
# Run with Docker (includes all dependencies)
docker run -p 8000:8000 -e APP_ADMIN_PASSWORD=admin123 cboulanger/pdf-tei-editor:latest
```

Then visit: **<http://localhost:8000>**

- Login: `admin` / `admin123`

**📖 For detailed Docker setup and configuration options:** [**→ Docker Testdrive Guide**](../user-manual/testdrive-docker.md)

## Local Development Installation

### Prerequisites

- **Python 3.13** with the [uv](https://docs.astral.sh/uv/) package manager
- **Node.js 24+** with npm
- **Git** for version control

### System Packages

Text recognition (OCR) and the repair of broken text layers in the extraction dialog use the core OCRmyPDF plugin, which needs these programs:

| Package | Needed for |
| --- | --- |
| `tesseract-ocr` | Text recognition and the layout check of the text layer. Without it, the OCRmyPDF plugin is not loaded and the extraction dialog offers no text recognition. |
| `tesseract-ocr-<lang>` | The language models, one package per language (e.g. `tesseract-ocr-deu`). The OCR options dialog offers the installed languages. |
| `ghostscript` | Optional: replaces a broken digital text layer while keeping the pages as vector graphics. Without it, such PDFs are converted to images before recognition. |
| `libmagic1` | Validation of uploaded files, see [File Upload Security](#file-upload-security) |

On Debian and Ubuntu, with the languages that the Docker image installs by default:

```bash
sudo apt-get install -y libmagic1 ghostscript tesseract-ocr \
  tesseract-ocr-eng tesseract-ocr-deu tesseract-ocr-fra tesseract-ocr-ita \
  tesseract-ocr-spa tesseract-ocr-por tesseract-ocr-nld tesseract-ocr-lat \
  tesseract-ocr-grc tesseract-ocr-ell tesseract-ocr-rus tesseract-ocr-pol tesseract-ocr-ces
```

On macOS: `brew install libmagic tesseract tesseract-lang ghostscript`. `tesseract --list-langs` shows the installed languages.

The Python packages for text recognition (`ocrmypdf`, `pikepdf`, `pypdfium2`, `pypdf`, `pillow`, `py3langid`) are core dependencies and installed by `uv sync`. See the [OCRmyPDF plugin README](../../fastapi_app/plugins/ocrmypdf/README.md) for the modes and parameters.

Plugins from the pte-plugins repository list their own requirements, such as API keys of LLM providers, in their READMEs.

### Installation Steps

```bash
# Clone the repository
git clone https://github.com/mpilhlt/pdf-tei-editor.git
cd pdf-tei-editor

# Configure environment for development
cp .env.development .env

# Install Python dependencies, with the default plugins from the pte-plugins repository
# (see "Plugins" below; plain `uv sync` installs the editor without plugins)
uv sync --extra default

# Install Node.js dependencies
npm install
```

### Plugins

Most plugins live in the [pte-plugins](https://github.com/mpilhlt/pte-plugins) repository and are optional dependencies of the editor: `uv sync --extra <name>` installs one (e.g. `--extra kisski`), `--extra default` the default set and `--all-extras` all of them (see the `[project.optional-dependencies]` table in `pyproject.toml`). `uv sync` removes plugins that are not selected, so pass the extras every time; `uv run` (used by the npm scripts) keeps the installed set.

To work on plugins, clone pte-plugins next to the editor and install its plugins into the editor's environment as editable packages, with their Python dependencies:

```bash
cd ../pte-plugins
npm run dev:install    # PTE_ROOT=<editor checkout> if it is not ../pdf-tei-editor
```

The editor then loads the plugins from the pte-plugins checkout, so changes need neither a release nor a reinstall, and the dev server (`npm run start:dev`) also reloads on changes in their directories (see `get_plugin_reload_dirs()` in `fastapi_app/lib/plugins/plugin_paths.py`). The watched directories are determined when the server starts, so restart it after installing a new plugin. The editable installs also take precedence over versions of the same plugins installed in the Plugin Manager (`data/plugins/site/`); those are not loaded while the editable install exists, which the server log notes at startup. `uv sync` removes the editable installs again, and `uv sync --extra <name>` replaces them with the pinned versions; run `npm run dev:install` again afterwards. See the pte-plugins README for running the plugin tests.

### Start the Development Server

```bash
npm run start:dev
```

The server listens on <http://localhost:8000> (`HOST` and `PORT` in `.env` change this) and reloads on changes of the backend code. Open <http://localhost:8000?dev> to load the frontend source files directly instead of the built bundle, so no build is needed after frontend changes. See [Development Server](dev-server.md) for details.

### Build the Application

```bash
npm run build
```

The build bundles the frontend for production mode (the URL without `?dev`). The Docker image runs it while it is built.

### Next Steps for Development

- **[Developer Documentation](index.md)** - Application architecture, plugin system, and development workflows
- **[Testing Guide](testing.md)** - Running tests and validation

## Production and Container Deployment

For production deployments, containerized deployments, and comprehensive deployment options, see the [**→ Deployment Guide**](deployment.md).


## Security Considerations

### File Upload Security

File uploads are validated using the libmagic package to prevent malicious content. This requires the native libmagic library:

- **Linux**: Available via package manager (`apt install libmagic1` or `yum install file-libs`)
- **Intel MacOS and Windows**: Use `uv add python-magic-bin`
- **Apple Silicon Macs**: Use Homebrew: `brew install libmagic`

### Development vs Production

- **Development mode**: Access to source files and node_modules for debugging
- **Production mode**: Set `FASTAPI_APPLICATION_MODE=production` in `.env` (as in `.env.production`) or `"application.mode": "production"` in `data/db/config.json` to disable development file access

For comprehensive security considerations in deployment scenarios, see the [**→ Deployment Guide**](deployment.md#security-considerations).

## Installation Options Summary

| Option | Purpose | Guide |
| --- | --- | --- |
| **Docker Testdrive** | Quick evaluation and testing | [Docker Testdrive Guide](../user-manual/testdrive-docker.md) |
| **Local Development** | Code development and contributions | See above + [Developer Documentation](index.md) |
| **Production Deployment** | Live server deployment | [Deployment Guide](deployment.md) |

## Additional Resources

- **[User Management](../user-manual/user-management.md)** - Managing users and authentication
- **[XML Validation](validation.md)** - Schema validation system
