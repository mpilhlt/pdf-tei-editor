"""
Wrapper to run FastAPI app without package name conflicts.
This resolves the issue where 'fastapi' directory shadows the fastapi library.
"""

import sys
from pathlib import Path

# Ensure we can import from the fastapi directory as a module
project_root = Path(__file__).parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

# Now we can safely import - the fastapi library will be found first in site-packages
# and our local 'fastapi' directory will be importable as a regular package
from fastapi_app.main import app

__all__ = ['app']
