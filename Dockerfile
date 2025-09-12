# Use Python slim for smaller image with Python pre-installed (~45MB vs ~78MB)
FROM python:3.13-slim
# Alternative options:
# FROM ubuntu:22.04          # ~78MB - full Ubuntu
# FROM ubuntu:22.04-minimal  # ~29MB - minimal Ubuntu  
# FROM python:3.13-slim      # ~45MB - Debian-based, Python pre-installed (recommended)

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    libmagic1 \
    libmagic-dev \
    && rm -rf /var/lib/apt/lists/*

# Install uv (Python already available, no need for pipx)
RUN pip install uv

# Install Node.js via nvm
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
ENV NVM_DIR="/root/.nvm"
RUN bash -c "source $NVM_DIR/nvm.sh && nvm install lts/jod && nvm use lts/jod && nvm alias default lts/jod"
RUN bash -c "source $NVM_DIR/nvm.sh && ln -sf \$NVM_DIR/versions/node/\$(node --version)/bin/* /usr/local/bin/"

# Create app directory
WORKDIR /app

# Copy source code
COPY . .

# Install Python dependencies
RUN uv sync

# Install Node.js dependencies
RUN bash -c "source $NVM_DIR/nvm.sh && npm install"

# Build the application
RUN bash -c "source $NVM_DIR/nvm.sh && npm run build"

# Expose port for waitress server
EXPOSE 8000

# Create entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]