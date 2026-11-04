"""
Registration of the core garbage-collection tasks (see ``gc_registry.py``), called at startup.
"""

from fastapi_app.config import get_settings

from .gc_registry import register_directory_gc_task


def register_core_gc_tasks() -> None:
    """Register the tasks of the file repository and storage, the message index, the caches and the tmp dir."""
    from fastapi_app.lib.messages.service import register_message_gc_task
    from fastapi_app.lib.storage.file_gc import register_file_gc_tasks

    register_file_gc_tasks()
    register_message_gc_task()
    register_directory_gc_task("schema-cache", "Schema cache", lambda: get_settings().schema_cache_dir, order=800)
    # Fully reproducible; entries for a SHA-pinned URL never expire on their own (see url_cache.py)
    register_directory_gc_task(
        "annotation-rules-cache", "Annotation-rules cache", lambda: get_settings().annotation_rules_cache_dir, order=810
    )
    register_directory_gc_task("tmp", "Temporary files", lambda: get_settings().tmp_dir, order=900)
