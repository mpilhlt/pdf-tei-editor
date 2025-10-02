# Production-optimized multi-stage Dockerfile
#
# Version configuration (can be overridden with --build-arg)
# Example: podman build --build-arg PYTHON_VERSION=3.12 --build-arg NODE_VERSION=18.20.4 .
ARG PYTHON_VERSION=3.13
ARG NODE_VERSION=20.18.0

# Stage 1: Base system with essential tools
FROM python:${PYTHON_VERSION}-slim as base

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
FROM base as builder

# Copy dependency files first
COPY package.json package-lock.json* ./
COPY pyproject.toml uv.lock ./

# Install all dependencies (both prod and dev) - this layer is cached unless deps change
RUN uv sync --no-cache \
    && npm install --ignore-scripts --no-audit --no-fund

# Copy source code (needed for build scripts)
COPY . .

# Run the build and cleanup in one layer
RUN uv run python bin/compile-sl-icons.py \
    && uv run python bin/download-pdfjs \
    && node bin/build.js --steps=templates,bundle \
    # Remove dev dependencies immediately after build
    && npm prune --omit=dev \
    && npm cache clean --force \
    && uv cache clean \
    # Remove all build-time files and directories
    && rm -rf .git \
    && rm -rf tests \
    && rm -rf docs \
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
FROM base as production

# Copy only production files from builder (no node_modules needed!)
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/app/web /app/app/web
COPY --from=builder /app/server /app/server
COPY --from=builder /app/config /app/config

# Set production mode in the container
RUN sed -i 's/"application.mode": "development"/"application.mode": "production"/' /app/config/config.json
COPY --from=builder /app/bin /app/bin
COPY --from=builder /app/schema /app/schema
COPY --from=builder /app/demo/data /app/data
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pyproject.toml /app/pyproject.toml

# Expose port
EXPOSE 8000

# Create entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

# Stage 4: Test-optimized variant (inherits from production)
FROM production as test

# Copy test fixtures and helpers for E2E tests
COPY tests/e2e/fixtures /app/tests/e2e/fixtures
COPY tests/e2e/backend/helpers /app/tests/e2e/backend/helpers
COPY tests/e2e/frontend/helpers /app/tests/e2e/frontend/helpers
COPY tests/py/fixtures /app/tests/py/fixtures

# Override entrypoint for test environment
COPY docker/entrypoint-test.sh /entrypoint-test.sh
RUN chmod +x /entrypoint-test.sh

ENTRYPOINT ["/entrypoint-test.sh"]