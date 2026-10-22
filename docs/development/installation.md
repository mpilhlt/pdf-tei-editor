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

**📖 For detailed Docker setup and configuration options:** [**→ Docker Testdrive Guide**](testdrive-docker.md)

## Local Development Installation

### Prerequisites

- **Python 3.13+** with uv package manager
- **Node.js 22+ (LTS)** with npm
- **Git** for version control

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

To work on plugins, clone pte-plugins next to the editor and install the plugins as editable packages instead; see its README.

### Build the Application

```bash
npm run build
```

### Start Development Server

```bash
# Development server (Python/Flask backend + JS frontend)
npm start

# Access at http://localhost:3001?dev
```

**Development Mode**: `http://localhost:3001?dev`  loads source files directly instead of the built bundle.

### Next Steps for Development

- **[Development Guide](development.md)** - Application architecture, plugin system, and development workflows
- **[Testing Guide](testing.md)** - Running tests and validation

## Production and Container Deployment

For production deployments, containerized deployments, and comprehensive deployment options, see the [**→ Deployment Guide**](deployment.md).


## LLamore Extraction Engine

To extract references from PDF, the [LLamore library](https://github.com/mpilhlt/llamore) is used. LLamore runs on the LLM model selected under Tools > Default Model, so at least one LLM provider must be configured, for example Google Gemini:

1. Get a key at <https://aistudio.google.com>
2. Ensure you've copied the appropriate `.env.development` or `.env.production` file to `.env`
3. Add your key to the `.env` file as `GEMINI_API_KEY`

Other providers (KISSKI, Anthropic) work the same way. Gemini and Anthropic models receive the PDF itself; other providers receive the PDF's text layer, so scanned PDFs without a text layer need one of the former.

## Security Considerations

### File Upload Security

File uploads are validated using the libmagic package to prevent malicious content. This requires the native libmagic library:

- **Linux**: Available via package manager (`apt install libmagic1` or `yum install file-libs`)
- **Intel MacOS and Windows**: Use `uv add python-magic-bin`
- **Apple Silicon Macs**: Use Homebrew: `brew install libmagic`

### Development vs Production

- **Development mode**: Access to source files and node_modules for debugging
- **Production mode**: Set `"application.mode": "production"` in `config/config.json` to disable development file access

For comprehensive security considerations in deployment scenarios, see the [**→ Deployment Guide**](deployment.md#security-considerations).

## Installation Options Summary

| Option | Purpose | Guide |
|--------|---------|-------|
| **Docker Testdrive** | Quick evaluation and testing | [Docker Testdrive Guide](testdrive-docker.md) |
| **Local Development** | Code development and contributions | See above + [Development Guide](development.md) |
| **Production Deployment** | Live server deployment | [Deployment Guide](deployment.md) |

## Additional Resources

- **[User Management](user-management.md)** - Managing users and authentication
- **[XML Validation](validation.md)** - Schema validation system
