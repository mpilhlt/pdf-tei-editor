"""
CodeMirror autocomplete data generation from RelaxNG schemas.

"""

from typing import Dict
from .relaxng_to_codemirror import generate_autocomplete_map

# Re-export the function
__all__ = ['generate_autocomplete_map']


def generate_codemirror_autocomplete(
    schema_file: str,
    include_global_attrs: bool = True,
    sort_alphabetically: bool = True,
    deduplicate: bool = False
) -> Dict:
    """
    Generate CodeMirror autocomplete data from a RelaxNG schema file.

    This is a convenience wrapper around the existing generate_autocomplete_map function.

    Args:
        schema_file: Path to the RelaxNG schema file
        include_global_attrs: Whether to include common global attributes
        sort_alphabetically: Whether to sort children and attributes alphabetically
        deduplicate: Whether to deduplicate redundant data using references

    Returns:
        Dictionary suitable for use as CodeMirror autocomplete map

    Raises:
        ValueError: If schema file cannot be parsed
        FileNotFoundError: If schema file doesn't exist
    """
    return generate_autocomplete_map(
        schema_file,
        include_global_attrs=include_global_attrs,
        sort_alphabetically=sort_alphabetically,
        deduplicate=deduplicate
    )
