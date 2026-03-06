"""
Library module exports for PDF-TEI-Editor.

Provides convenient access to commonly used utilities and core components.

Modules:
- core: Database management and migrations
- models: Pydantic data models
- repository: Data access layer
- services: Business logic services
- storage: File storage and I/O
- permissions: Access control
- plugins: Plugin system
- extraction: Extraction engine framework
- sse: Server-sent events
- utils: Common utilities
"""

from .utils.config_utils import get_config

__all__ = ["get_config"]
