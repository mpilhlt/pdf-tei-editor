# PDF-TEI Editor

A comprehensive viewer/editor web application for comparing PDF sources with TEI extraction and annotation results, specifically designed for creating gold standard datasets of TEI documents from legal and humanities literature.

![grafik](https://github.com/user-attachments/assets/864185f5-864a-439f-806c-537267470c46)

## Key Features

- **Dual-pane interface** with synchronized PDF viewer and XML editor
- **AI-powered extraction** supporting multiple extraction engines (GROBID, etc.)
- **Version management** with branching, merging, and comparison tools
- **Schema validation** with automatic TEI compliance checking
- **Access control** with role-based permissions and collection management
- **Collection organization** for managing document sets
- **WebDAV synchronization** for external system integration
- **Revision tracking** with detailed change documentation

## Target Use Cases

- Creating gold standard datasets for reference extraction research
- Manual validation and correction of AI-extracted bibliographic data
- Collaborative annotation of legal and humanities literature
- Training data preparation for machine learning models
- Quality assurance for large-scale digitization projects


## About

This repository is part of the ["Legal Theory Knowledge Graph" project](https://www.lhlt.mpg.de/2514927/03-boulanger-legal-theory-graph) at the Max Planck Institute of Legal History and Legal Theory.

Related repositories:

- [llamore](https://github.com/mpilhlt/llamore)
- [bibliographic-tei](https://github.com/mpilhlt/bibliographic-tei)

## 🚀 Quick Start

### Try with Docker (Fastest)

The fastest way to try PDF-TEI Editor using our deployment script:

```bash
# Clone the repository
git clone https://github.com/mpilhlt/pdf-tei-editor.git
cd pdf-tei-editor

# Deploy demo container (builds and starts automatically)
npm run deploy .env.deploy.demo.localhost
```

Then visit: **<http://localhost:8080>**

- Login: `admin` / `admin` or `demo` / `demo`

**Or use Docker directly:**

```bash
docker run -p 8000:8000 -e APP_ADMIN_PASSWORD=admin123 cboulanger/pdf-tei-editor:latest
```

Visit: **<http://localhost:8000>** - Login: `admin` / `admin123`

**📖 For detailed setup:** See the [Docker Deployment Guide](docs/user-manual/docker-deployment.md)

### Development Setup

```bash
# Clone the repository
git clone https://github.com/mpilhlt/pdf-tei-editor.git
cd pdf-tei-editor

# Configure environment
cp .env.development .env

# Install dependencies
npm install

# Start development server
npm run start:dev
```

Visit: **<http://localhost:8000>**

**📖 For complete setup instructions:** See the [Installation Guide](docs/development/installation.md)

## Documentation

**📚 [Complete Documentation](docs/index.md)**

### For End Users

- [User Manual](docs/user-manual/index.md) - How to use the application
- [Getting Started](docs/user-manual/getting-started.md) - First-time user guide
- [Interface Overview](docs/user-manual/interface-overview.md) - Understanding the interface
- [Workflows](docs/user-manual/extraction-workflow.md) - Extraction, editing, and sync workflows

### For Developers

- [Developer Documentation](docs/development/index.md) - Architecture and development guides
- [Architecture Overview](docs/development/architecture.md) - System design and structure
- [Testing Guide](docs/development/testing.md) - Running and writing tests

### General reference

- [Installation Guide](docs/development/installation.md) - Development environment setup
- [CLI](docs/user-manual/cli.md) - Command line interface

### For Code Assistants

- [Code Assistant Documentation](docs/code-assistant/README.md) - Concise technical guides

## Technology Stack

**Backend:** FastAPI (Python 3.13+), SQLite, lxml
**Frontend:** ES6 modules, CodeMirror 6, PDF.js, Shoelace
**Testing:** Playwright (E2E), pytest (backend), Node.js test runner (API)

## License

See the project repository for license information.

## Contributing

Developers interested in contributing should:

1. Read the [Developer Documentation](docs/development/index.md)
2. Follow [Coding Standards](docs/code-assistant/coding-standards.md)
3. Write tests following the [Testing Guide](docs/development/testing.md)
4. Submit pull requests with proper documentation

---

**Questions or issues?** Check the [documentation](docs/index.md) or [open an issue](https://github.com/mpilhlt/pdf-tei-editor/issues).
