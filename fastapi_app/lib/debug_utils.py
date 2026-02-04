"""
Debug utilities for extraction logging
"""

import logging
import os
import datetime
from pathlib import Path
from typing import Optional

from fastapi_app.config import get_settings

logger = logging.getLogger(__name__)


def create_debug_log_dir(extractor_name: Optional[str] = None) -> Path:
    """
    Create and return the debug log directory.

    Args:
        extractor_name: Optional extractor name for subdirectory

    Returns:
        Path to the log directory (creates if needed)
    """
    settings = get_settings()
    if extractor_name:
        log_dir = settings.tmp_dir / extractor_name
    else:
        log_dir = settings.tmp_dir
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir

def write_comment(f, comment, prefix = "# ", suffix = ""):
    f.write(f'{prefix}{comment}{suffix}')

def log_extraction_response(
    extractor_name: str,
    pdf_path: str,
    response_content: str,
    file_suffix: str = ".xml",
    error: Optional[str] = None
) -> Optional[Path]:
    """
    Log extraction response content to a debug file (only when DEBUG logging enabled).

    Args:
        extractor_name: Name of the extractor (e.g., "grobid", "llamore")
        pdf_path: Path to the source PDF file
        response_content: The raw response content to log
        file_suffix: File extension for the log file
        error: Optional error message to include

    Returns:
        Path to the created log file, or None if DEBUG logging not enabled
    """
    if not logger.isEnabledFor(logging.DEBUG):
        return None

    log_dir = create_debug_log_dir(extractor_name)

    # Create timestamp
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    
    # Extract PDF filename without extension
    pdf_name = os.path.splitext(os.path.basename(pdf_path))[0]
    
    # Create log filename
    log_filename = f"{timestamp}_{extractor_name}_{pdf_name}{file_suffix}"
    log_file_path = log_dir / log_filename
    
    # define comment prefix/suffix according to file suffix
    prefix = suffix = None # defaults to "# "
    if file_suffix == ".xml":
        # create a valid xml file by putting comments into <!-- ... -->
        prefix = "<!-- "
        suffix = " -->"
    
    # Write content to log file
    with open(log_file_path, 'w', encoding='utf-8') as f:
        write_comment(f, f"Debug log for {extractor_name} extraction\n", prefix, suffix)
        write_comment(f, f"PDF: {pdf_path}\n", prefix, suffix)
        write_comment(f, f"Timestamp: {datetime.datetime.now().isoformat()}\n", prefix, suffix)
        if error:
            write_comment(f, f"Error: {error}\n", prefix, suffix)
        write_comment(f, f"Content length: {len(response_content)} characters\n", prefix, suffix)
        write_comment(f, "="*70 + "\n\n", prefix, suffix)
        f.write(response_content)
    
    logger.debug(f"Logged {extractor_name} response to {log_file_path}")
    return log_file_path


def log_xml_parsing_error(
    extractor_name: str,
    pdf_path: str,
    xml_content: str,
    error_message: str
) -> Optional[Path]:
    """
    Log XML content that failed to parse (only when DEBUG logging enabled).

    Args:
        extractor_name: Name of the extractor
        pdf_path: Path to the source PDF file
        xml_content: The XML content that failed to parse
        error_message: The parsing error message

    Returns:
        Path to the created log file, or None if DEBUG logging not enabled
    """
    return log_extraction_response(
        extractor_name=extractor_name,
        pdf_path=pdf_path,
        response_content=xml_content,
        file_suffix=".error.xml",
        error=error_message
    )