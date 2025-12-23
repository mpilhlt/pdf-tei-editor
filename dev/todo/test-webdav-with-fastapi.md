# RE-enable WebDAV

**GitHub Issue:** https://github.com/mpilhlt/pdf-tei-editor/issues/121

the WebDAV synchronization has not been tested with the new FastAPI backend. Unit and API tests pass, but only with mocked depenndencies.

---

## Container Engine Detection and Management - Completed

Fixed container tool detection, renamed Docker-specific references to generic container terminology, and added container management scripts.

**Container Detection:**

1. Created [tests/lib/detect-container-tool.js](tests/lib/detect-container-tool.js) - Shared detection for Docker/Podman
2. Updated [playwright.config.js](playwright.config.js) - Dynamic compose command, conditional webServer config
3. Updated [tests/lib/container-server-manager.js](tests/lib/container-server-manager.js) - Use shared detection

**Terminology Updates:**

4. Renamed npm scripts: `docker:*` → `container:*` in [package.json](package.json)
5. Renamed test script: `test:e2e:docker-infra` → `test:e2e:container-infra`
6. Updated [docs/code-assistant/testing-guide.md](docs/code-assistant/testing-guide.md) - Container terminology
7. Updated [tests/e2e/tests/docker-infrastructure.spec.js](tests/e2e/tests/docker-infrastructure.spec.js) - Container terminology
8. Updated [tests/e2e-runner.js](tests/e2e-runner.js) - Container terminology
9. Updated [CLAUDE.md](CLAUDE.md) - Container commands quick reference
10. Updated [docs/development/docker.md](docs/development/docker.md) - Container management commands

**New Management Scripts:**

11. Created [bin/container-start.js](bin/container-start.js) - Start containers with tag/name/port options
12. Created [bin/container-stop.js](bin/container-stop.js) - Stop/remove containers by name or all

**Usage:**

```bash
# Start container
npm run container:start                           # Latest on port 8000
npm run container:start -- --tag v1.0.0 --port 8080

# Stop container
npm run container:stop                            # Stop default
npm run container:stop -- --name my-container --remove

# Build and push
npm run container:build -- v1.0.0
npm run container:push -- v1.0.0
```

The system automatically detects Docker or Podman and uses the appropriate commands. All container operations work with both engines.
