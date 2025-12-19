"""Cache management utilities."""

import shutil
from pathlib import Path


def clear_schema_cache(schema_cache_dir: str | Path | None = None) -> tuple[bool, str]:
    """
    Clears the schema cache directory.

    Args:
        schema_cache_dir: Path to the schema cache directory. If None, uses data/schema/cache

    Returns:
        Tuple of (success, message)
    """
    if schema_cache_dir is None:
        schema_cache_dir = Path(__file__).parent.parent.parent / "data" / "schema" / "cache"
    else:
        schema_cache_dir = Path(schema_cache_dir)

    if not schema_cache_dir.exists():
        return True, f"Cache directory does not exist: {schema_cache_dir}"

    try:
        # Remove all contents of the cache directory
        for item in schema_cache_dir.iterdir():
            if item.is_dir():
                shutil.rmtree(item)
            else:
                item.unlink()

        return True, f"Cleared schema cache: {schema_cache_dir}"
    except Exception as e:
        return False, f"Error clearing schema cache: {e}"
