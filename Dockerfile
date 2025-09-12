FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    pipx \
    libmagic1 \
    libmagic-dev \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN pipx install uv
ENV PATH="/root/.local/bin:$PATH"

# Install Node.js via nvm
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
ENV NVM_DIR="/root/.nvm"
RUN bash -c "source $NVM_DIR/nvm.sh && nvm install lts/iron && nvm use lts/iron && nvm alias default lts/iron"
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