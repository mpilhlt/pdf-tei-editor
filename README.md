# PDF-TEI Editor

A viewer/editor web app to compare the PDF source and automated TEI extraction/annotation

![grafik](https://github.com/user-attachments/assets/864185f5-864a-439f-806c-537267470c46)

Note: this is a development prototype, not a production-ready application.

This repo is part of the ["Legal Theory Knowledge Graph" project](https://www.lhlt.mpg.de/2514927/03-boulanger-legal-theory-graph)
at the Max Planck Institute of Legal History and Legal Theory.

Related repositories:

- <https://github.com/mpilhlt/llamore>
- <https://github.com/mpilhlt/bibliographic-tei>

Information for end users [can be found here](./docs/index.md)

## 🚀 Quick Start with Docker

**The fastest way to try PDF TEI Editor:**

```bash
# Run with Docker (includes all dependencies)
docker run -p 8000:8000 -e APP_ADMIN_PASSWORD=admin123 cboulanger/pdf-tei-editor:latest
```

Then visit: **http://localhost:8000**
- Login: `admin` / `admin123`

**📖 For detailed Docker setup and configuration options:** [**→ Docker Testdrive Guide**](docs/testdrive-docker.md)

## Developer Documentation

This section provides comprehensive documentation for developers working on the PDF-TEI Editor.

### Getting Started
- **[Installation](docs/installation.md)** - Setup and installation for development and production
- **[Development Guide](docs/development.md)** - Application architecture, plugin system, and best practices
- **[Testing Guide](docs/testing.md)** - Comprehensive testing infrastructure including unit, integration, and E2E tests

### Deployment
- **[Docker Deployment](docs/docker-deployment.md)** - Containerized deployment options and production setup
- **[User Management](docs/user-management.md)** - Authentication system and user account management

### Technical Features
- **[XML Validation](docs/xml-validation.md)** - Schema validation and intelligent autocomplete system

### Quick Commands

```bash
# Development
npm start                       # Start development server
npm run build                   # Build application for production

# Testing
npm test                        # Run all tests (unit + integration)
npm run test:e2e                # Run end-to-end tests in containers
npm run test:js                 # Run JavaScript unit tests only

# User management
npm run manage help            # Management help
```

### Development Mode
Use `http://localhost:3001?dev` to load source files directly for faster development iteration.

