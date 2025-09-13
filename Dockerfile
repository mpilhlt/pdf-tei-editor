# Multi-stage Dockerfile optimized for fast rebuilds and testing
# Stage 1: Base system dependencies (changes rarely)
FROM python:3.13-slim as base

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies - cached layer
RUN apt-get update && apt-get install -y \
    curl \
    git \
    libmagic1 \
    libmagic-dev \
    && rm -rf /var/lib/apt/lists/*

# Install uv - cached layer
RUN pip install uv

# Install Node.js via nvm - cached layer
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
ENV NVM_DIR="/root/.nvm"
RUN bash -c "source $NVM_DIR/nvm.sh && nvm install lts/jod && nvm use lts/jod && nvm alias default lts/jod"
RUN bash -c "source $NVM_DIR/nvm.sh && ln -sf \$NVM_DIR/versions/node/\$(node --version)/bin/* /usr/local/bin/"

WORKDIR /app

# Stage 2: Dependencies installation (changes when package files change)
FROM base as deps

# Copy dependency files
COPY package.json package-lock.json* ./
COPY pyproject.toml uv.lock ./

# Install Python dependencies - cached when pyproject.toml/uv.lock unchanged
RUN uv sync

# Install Node.js dependencies without postinstall scripts that need source files
RUN bash -c "source $NVM_DIR/nvm.sh && npm install --ignore-scripts"

# Stage 3: Application build (rebuilds when source changes)
FROM deps as app

# Copy source code
COPY . .

# Run postinstall scripts now that source files are available
RUN bash -c "source $NVM_DIR/nvm.sh && npm run postinstall"

# Expose port for waitress server
EXPOSE 8000

# Create entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

# Stage 4: Test-optimized variant
FROM app as test

# Override entrypoint for test environment
COPY docker/entrypoint-test.sh /entrypoint-test.sh
RUN chmod +x /entrypoint-test.sh

ENTRYPOINT ["/entrypoint-test.sh"]