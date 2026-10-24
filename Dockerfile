# Production-optimized multi-stage Dockerfile
#
# Version configuration (can be overridden with --build-arg)
# Example: podman build --build-arg PYTHON_VERSION=3.12 --build-arg NODE_VERSION=22.15.0 .
ARG PYTHON_VERSION=3.13
ARG NODE_VERSION=24.21.0

# Stage 1: Base system with essential tools
FROM python:${PYTHON_VERSION}-slim AS base

# Re-declare ARG variables for this stage
ARG NODE_VERSION=24.21.0

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    libmagic1 \
    libmagic-dev \
    ca-certificates \
    gnupg \
    poppler-utils \
    # Clean up package cache
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install Node.js via NodeSource repository (avoids tar permission issues)
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_VERSION%%.*}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    # Clean up
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean \
    && rm -rf /tmp/* /var/tmp/*

# Install uv
RUN pip install --no-cache-dir uv

WORKDIR /app

# Dependency manifests for the install layers. semantic-release bumps "version" in
# package.json and package-lock.json on every release; neutralizing it here keeps the
# dependency layers cached across releases. The real files arrive later with `COPY . .`.
# playwright-version lets the browser layer depend on the Playwright version only.
FROM base AS deps-manifest
WORKDIR /deps
COPY package.json package-lock.json pyproject.toml uv.lock ./
RUN node -e ' \
      const fs = require("fs"); \
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); \
      const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")); \
      pkg.version = lock.version = lock.packages[""].version = "0.0.0"; \
      fs.writeFileSync("package.json", JSON.stringify(pkg, null, 4) + "\n"); \
      fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 4) + "\n"); \
      fs.writeFileSync("playwright-version", lock.packages["node_modules/playwright"].version + "\n"); \
    '

# Stage 2: Build stage (includes all dependencies temporarily)
FROM base AS builder

# Plugins from the pte-plugins repository to install: names of optional dependencies of
# pyproject.toml separated by commas or spaces ("default", "analytics", single plugins),
# "all" for all of them, or empty for none
ARG PTE_PLUGIN_EXTRAS=default

# Copy dependency files first (version-neutralized, see deps-manifest)
COPY --from=deps-manifest /deps/package.json /deps/package-lock.json /deps/pyproject.toml /deps/uv.lock ./

# Install all dependencies (both prod and dev) - this layer is cached unless deps change
RUN uv sync --frozen $(extras="$(echo "$PTE_PLUGIN_EXTRAS" | tr ',' ' ')"; \
        if [ "$extras" = "all" ]; then echo --all-extras; \
        else for extra in $extras; do printf -- '--extra %s ' "$extra"; done; fi) \
    && npm install --ignore-scripts --no-audit --no-fund

# Copy source code (needed for build scripts)
COPY . .

# Run the build and cleanup in one layer
RUN uv run python scripts/build/compile-sl-icons.py \
    && node scripts/build/build.js --steps=templates,version,pdfjs,bundle \
    && uv run python scripts/build/generate-sandbox-client-script.py \
    # Remove dev dependencies immediately after build
    && npm prune --omit=dev \
    && npm cache clean --force \
    && uv cache clean \
    # Remove all build-time files and directories
    && rm -rf .git \
    && rm -rf tests \
    && rm -rf app/src \
    && rm -rf node_modules/.cache \
    && rm -rf /root/.cache \
    && rm -rf /root/.npm \
    && rm -rf /tmp/* /var/tmp/* \
    # Remove unnecessary files
    && rm -f .dockerignore .gitignore README.md LICENSE \
    && rm -f playwright.config.js docker-compose.test.yml \
    && rm -f package-lock.json \
    # Keep only essential directories and files
    && find . -name "*.pyc" -delete \
    && find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

# Stage 3: Production runtime (minimal final image)
FROM base AS production

# Copy only production files from builder
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/app/web /app/app/web
COPY --from=builder /app/fastapi_app /app/fastapi_app
COPY --from=builder /app/config /app/config
COPY --from=builder /app/docs /app/docs
# Note: data/db/ is created at runtime from config/ by db_init.py

# Set production mode in the container
RUN sed -i 's/"application.mode": "development"/"application.mode": "production"/' /app/config/config.json
# bin/ only: scripts/ (build, dev and deploy tooling) is intentionally not shipped
COPY --from=builder /app/bin /app/bin
COPY --from=builder /app/schema /app/schema
COPY --from=builder /app/pyproject.toml /app/pyproject.toml
COPY --from=builder /app/run_fastapi.py /app/run_fastapi.py

# Copy demo data and import script
COPY docker/demo-data /app/docker/demo-data
COPY docker/import-demo-data.sh /app/docker/import-demo-data.sh
RUN chmod +x /app/docker/import-demo-data.sh

# Expose port
EXPOSE 8000

# Create entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

# Stage 4: CI test runner (runs tests internally, not as a server)
FROM base AS ci

# Install Playwright browsers first: this large layer only depends on the Playwright
# version, not on other dependency changes
COPY --from=deps-manifest /deps/playwright-version /tmp/playwright-version
RUN npx -y "playwright@$(cat /tmp/playwright-version)" install --with-deps \
    && rm -rf /root/.npm/_npx

# Copy dependency files (version-neutralized, see deps-manifest)
COPY --from=deps-manifest /deps/package.json /deps/package-lock.json /deps/pyproject.toml /deps/uv.lock ./

# Install ALL dependencies (including dev dependencies for testing)
RUN uv sync --frozen --all-extras && npm install --ignore-scripts --no-audit --no-fund

# Copy source code and tests
COPY . .

# Build the application (needed for some tests)
RUN node scripts/build/build.js

# Set environment for unbuffered output (critical for streaming)
ENV PYTHONUNBUFFERED=1 \
    NODE_OPTIONS="--enable-source-maps" \
    TEST_IN_PROGRESS=1 \
    E2E_SKIP_WEBSERVER=1

# Copy CI entrypoint
COPY docker/entrypoint-ci.sh /entrypoint-ci.sh
RUN chmod +x /entrypoint-ci.sh

ENTRYPOINT ["/entrypoint-ci.sh"]