"""
Utility functions for database migrations.

Contains shared functionality for migrations that operate on TEI files.
"""

import sqlite3
from pathlib import Path
from typing import Tuple, Optional, Callable, Any


def get_file_storage_paths(conn: sqlite3.Connection) -> Tuple[Optional[Path], Optional[Path]]:
    """
    Get the file storage directory path from database connection.
    
    Args:
        conn: SQLite database connection
        
    Returns:
        Tuple of (db_dir, files_dir) or (None, None) if not found
    """
    try:
        # Get database path from PRAGMA
        db_path_row = conn.execute("PRAGMA database_list").fetchone()
        if not db_path_row:
            return None, None
            
        db_path = Path(db_path_row[2])
        db_dir = db_path.parent
        files_dir = db_dir.parent / "files"
        
        return db_dir, files_dir
    except Exception:
        return None, None


def get_tei_files(conn: sqlite3.Connection) -> list:
    """
    Get all TEI files from the database.
    
    Args:
        conn: SQLite database connection
        
    Returns:
        List of tuples (file_id, file_type) for TEI files
    """
    cursor = conn.execute("""
        SELECT id, file_type
        FROM files
        WHERE file_type = 'tei' AND deleted = 0
    """)
    return cursor.fetchall()
    
    
def update_file_column(conn: sqlite3.Connection, file_id: str, column_name: str, value: str) -> None:
    """
    Update a file's column value.
    
    Args:
        conn: SQLite database connection
        file_id: File identifier
        column_name: Name of column to update
        value: New value for the column
    """
    # Using parameterized query to avoid SQL injection
    query = f"""
        UPDATE files
        SET {column_name} = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    """
    conn.execute(query, (value, file_id))


def add_column_with_index(
    conn: sqlite3.Connection,
    column_name: str,
    column_type: str,
    index_name: str,
    logger: Any,
    column_description: str = "column"
) -> None:
    """
    Add a column and index to the files table.

    Args:
        conn: SQLite database connection
        column_name: Name of the column to add
        column_type: SQL type for the column (e.g., 'TEXT', 'INTEGER')
        index_name: Name of the index to create
        logger: Logger instance
        column_description: Human-readable description of the column
    """
    logger.info(f"Adding {column_description} column to files table")

    # Add column
    conn.execute(f"""
        ALTER TABLE files
        ADD COLUMN {column_name} {column_type}
    """)

    # Create index on column
    conn.execute(f"""
        CREATE INDEX IF NOT EXISTS {index_name}
        ON files({column_name})
        WHERE {column_name} IS NOT NULL
    """)

    logger.info(f"{column_description.capitalize()} column and index created successfully")


def repopulate_column_from_tei_files(
    conn: sqlite3.Connection,
    files_dir: Path,
    column_name: str,
    extract_function: Callable[[bytes], Optional[str]],
    logger: Any,
    column_description: str = "column"
) -> dict:
    """
    Repopulate an existing column from TEI files.

    This function can be used both during migrations and for maintenance
    re-population of fields from TEI documents.

    Args:
        conn: SQLite database connection
        files_dir: Path to the files storage directory
        column_name: Name of the column to populate
        extract_function: Function that extracts value from TEI XML bytes
        logger: Logger instance
        column_description: Human-readable description of the column

    Returns:
        dict with statistics: {updated: int, errors: int, skipped: int, total: int}
    """
    logger.info(f"Populating {column_description} from existing TEI files")

    if not files_dir or not files_dir.exists():
        logger.debug(f"Files directory not found: {files_dir}, skipping data population")
        return {"updated": 0, "errors": 0, "skipped": 0, "total": 0}

    # Get all TEI files
    tei_files = get_tei_files(conn)
    total_files = len(tei_files)
    updated_count = 0
    error_count = 0

    logger.info(f"Found {total_files} TEI file(s) to process")

    # Import here to avoid circular dependencies during module loading
    from ...lib.hash_utils import get_storage_path

    for file_id, file_type in tei_files:
        try:
            # Get storage path and read file content directly
            storage_path = get_storage_path(files_dir, file_id, file_type)
            if not storage_path.exists():
                file_id_short = file_id[:8] if len(file_id) >= 8 else file_id
                logger.warning(f"File not found in storage: {file_id_short}")
                continue

            content = storage_path.read_bytes()

            # Extract value from XML
            value = extract_function(content)

            if value:
                # Update column in database
                update_file_column(conn, file_id, column_name, value)
                updated_count += 1

        except Exception as e:
            error_count += 1
            file_id_short = file_id[:8] if len(file_id) >= 8 else file_id
            logger.warning(
                f"Failed to extract {column_description} from file {file_id_short}: {e}"
            )

    skipped_count = total_files - updated_count - error_count
    logger.info(
        f"Population complete: updated {updated_count} file(s), "
        f"{error_count} skipped due to issues, "
        f"{skipped_count} file(s) without {column_description}"
    )

    return {
        "updated": updated_count,
        "errors": error_count,
        "skipped": skipped_count,
        "total": total_files
    }


def populate_column_from_tei_files(
    conn: sqlite3.Connection,
    column_name: str,
    column_type: str,
    index_name: str,
    extract_function: Callable[[bytes], Optional[str]],
    logger: Any,
    column_description: str = "column"
) -> None:
    """
    Generic function to add a column and populate it from TEI files.

    This is a convenience function for migrations that combines
    add_column_with_index and repopulate_column_from_tei_files.

    Args:
        conn: SQLite database connection
        column_name: Name of the column to add
        column_type: SQL type for the column (e.g., 'TEXT', 'INTEGER')
        index_name: Name of the index to create
        extract_function: Function that extracts value from TEI XML bytes
        logger: Logger instance
        column_description: Human-readable description of the column
    """
    # Add column and index
    add_column_with_index(
        conn=conn,
        column_name=column_name,
        column_type=column_type,
        index_name=index_name,
        logger=logger,
        column_description=column_description
    )

    # Get file storage path
    db_dir, files_dir = get_file_storage_paths(conn)

    if not files_dir or not files_dir.exists():
        logger.debug(f"Files directory not found: {files_dir}, skipping data population")
        return

    # Populate from TEI files
    repopulate_column_from_tei_files(
        conn=conn,
        files_dir=files_dir,
        column_name=column_name,
        extract_function=extract_function,
        logger=logger,
        column_description=column_description
    )
