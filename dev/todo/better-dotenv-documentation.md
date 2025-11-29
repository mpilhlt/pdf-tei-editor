# Better .env documentation

like so:

```env
# Zotero RAG Backend Configuration
# Copy this file to .env and fill in your values

# =============================================================================
# API Configuration
# =============================================================================

# API server host and port
# API_HOST=localhost
# API_PORT=8119

# =============================================================================
# Model Configuration
# =============================================================================

# Hardware preset to use
# Options: See docs/presets.md
# Default: cpu-only
MODEL_PRESET=cpu-only

# Paths for model weights and vector database
# Default: ~/.cache/zotero-rag/models and ~/.local/share/zotero-rag/qdrant
MODEL_WEIGHTS_PATH=~/.cache/zotero-rag/models
VECTOR_DB_PATH=~/.local/share/zotero-rag/qdrant

# =============================================================================
# Zotero Configuration
# =============================================================================

# Zotero local API URL
# Default: http://localhost:23119
# ZOTERO_API_URL=http://localhost:23119

# =============================================================================
# Logging Configuration
# =============================================================================

# Logging level: DEBUG, INFO, WARNING, ERROR, CRITICAL
# Default: INFO
LOG_LEVEL=INFO

# Log file path
# Default: ~/.local/share/zotero-rag/logs/server.log
LOG_FILE=~/.local/share/zotero-rag/logs/server.log

# =============================================================================
# API Keys (for remote inference and model downloads)
# =============================================================================

# HuggingFace token for downloading models (required for some models like nomic-embed-text-v1.5)
# Get your token at: https://huggingface.co/settings/tokens
# HF_TOKEN=your_huggingface_token_here

# OpenAI API key (for remote-openai preset or remote embeddings)
# OPENAI_API_KEY=sk-...

# Anthropic API key (for Claude models)
# ANTHROPIC_API_KEY=sk-ant-...

# Cohere API key (for Cohere embeddings/models)
# COHERE_API_KEY=...

# GWDG KISSKI Academic Cloud LLM service (for remote-kisski preset)
# Get access at: https://kisski.gwdg.de/
# KISSKI_API_KEY=your_kisski_api_key

# =============================================================================
# Development Configuration (only useful for developing the Zotero plugin)
# =============================================================================

# Path to the Zotero binary file.
# For macOS, the path is typically `*/Zotero.app/Contents/MacOS/zotero`.
# ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/path/to/zotero.exe

# Path to the profile used for development.
# To create a profile for development, start the profile manager with `/path/to/zotero.exe -p`.
# More info: https://www.zotero.org/support/kb/profile_directory
# ZOTERO_PLUGIN_PROFILE_PATH=/path/to/profile

# Optional path to the data directory (if needed).
# ZOTERO_PLUGIN_DATA_DIR=/path/to/data
```