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

# Install system dependencies and Node.js in one optimized layer
RUN apt-get update && apt-get install -y \
    curl \
    git \
    libmagic1 \
    libmagic-dev \
    ca-certificates \
    xz-utils \
    # Install Node.js directly (smaller than nvm) with permission workaround
    && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && tar -xJ -f /tmp/node.tar.xz -C /tmp --no-same-permissions \
    && cp -r /tmp/node-v${NODE_VERSION}-linux-x64/* /usr/local/ \
    && rm -rf /tmp/node-v${NODE_VERSION}-linux-x64 /tmp/node.tar.xz \
    # Clean up all caches and temporary files in same layer
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

# Install Python dependencies first (no dev dependencies needed yet)
RUN uv sync --no-dev --no-cache

# Install Node.js dependencies without postinstall (which needs source files)
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Copy source code
COPY . .

# Now install dev dependencies and run optimized build process once
RUN uv sync --no-cache \
    && npm install --no-audit --no-fund \
    # Run postinstall components that aren't covered by main build
    && node bin/generate-importmap.js \
    && uv run python bin/compile-sl-icons.py \
    && uv run python bin/download-pdfjs \
    # Run full build process (templates + bundle only, since importmap/icons done above)
    && node bin/build.js --steps=templates,bundle \
    # Remove dev dependencies immediately after build
    && npm prune --omit=dev \
    && npm cache clean --force \
    && uv sync --no-dev --no-cache \
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
COPY --from=builder /app/data /app/data
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pyproject.toml /app/pyproject.toml

# Expose port
EXPOSE 8000

# Create entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

# Stage 4: Test-optimized variant (inherits from builder)
FROM builder as test

# Override entrypoint for test environment
COPY docker/entrypoint-test.sh /entrypoint-test.sh
RUN chmod +x /entrypoint-test.sh

ENTRYPOINT ["/entrypoint-test.sh"]