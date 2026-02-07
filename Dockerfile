# Production-optimized multi-stage Dockerfile
#
# Version configuration (can be overridden with --build-arg)
# Example: podman build --build-arg PYTHON_VERSION=3.12 --build-arg NODE_VERSION=18.20.4 .
ARG PYTHON_VERSION=3.13
ARG NODE_VERSION=20.18.0

# Stage 1: Base system with essential tools
FROM python:${PYTHON_VERSION}-slim AS base

# Re-declare ARG variables for this stage
ARG NODE_VERSION=20.18.0

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
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    # Clean up
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean \
    && rm -rf /tmp/* /var/tmp/*

# Install uv
RUN pip install --no-cache-dir uv

WORKDIR /app

# Stage 2: Build stage (includes all dependencies temporarily)
FROM base AS builder

# Copy dependency files first
COPY package.json package-lock.json* ./
COPY pyproject.toml uv.lock ./

# Install all dependencies (both prod and dev) - this layer is cached unless deps change
RUN uv sync --frozen && npm install --ignore-scripts --no-audit --no-fund

# Copy source code (needed for build scripts)
COPY . .

# Run the build and cleanup in one layer
RUN uv run python bin/compile-sl-icons.py \
    && node bin/build.js --steps=templates,version,pdfjs,bundle \
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

# Copy dependency files first
COPY package.json package-lock.json* ./
COPY pyproject.toml uv.lock ./

# Install ALL dependencies (including dev dependencies for testing)
RUN uv sync --frozen && npm install --ignore-scripts --no-audit --no-fund

# Install Playwright browsers immediately after dependencies for early caching
# This creates a separate layer that will be cached unless dependencies change
RUN npx playwright install --with-deps

# Copy source code and tests
COPY . .

# Build the application (needed for some tests)
RUN node bin/build.js

# Set environment for unbuffered output (critical for streaming)
ENV PYTHONUNBUFFERED=1 \
    NODE_OPTIONS="--enable-source-maps" \
    TEST_IN_PROGRESS=1 \
    E2E_SKIP_WEBSERVER=1

# Copy CI entrypoint
COPY docker/entrypoint-ci.sh /entrypoint-ci.sh
RUN chmod +x /entrypoint-ci.sh

ENTRYPOINT ["/entrypoint-ci.sh"]