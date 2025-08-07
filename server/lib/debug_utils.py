"""
Debug utilities for extraction logging
"""

import os
import datetime
from pathlib import Path
from typing import Optional


def create_debug_log_dir() -> Path:
    """Create and return the debug log directory."""
    project_root = Path(__file__).resolve().parent.parent.parent
    log_dir = project_root / 'log'
    log_dir.mkdir(exist_ok=True)
    return log_dir


def log_extraction_response(
    extractor_name: str,
    pdf_path: str,
    response_content: str,
    file_suffix: str = ".xml",
    error: Optional[str] = None
) -> Path:
    """
    Log extraction response content to a debug file.
    
    Args:
        extractor_name: Name of the extractor (e.g., "grobid", "llamore")
        pdf_path: Path to the source PDF file
        response_content: The raw response content to log
        file_suffix: File extension for the log file
        error: Optional error message to include
        
    Returns:
        Path to the created log file
    """
    log_dir = create_debug_log_dir()
    
    # Create timestamp
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    
    # Extract PDF filename without extension
    pdf_name = os.path.splitext(os.path.basename(pdf_path))[0]
    
    # Create log filename
    log_filename = f"{timestamp}_{extractor_name}_{pdf_name}{file_suffix}"
    log_file_path = log_dir / log_filename
    
    # Write content to log file
    with open(log_file_path, 'w', encoding='utf-8') as f:
        f.write(f"# Debug log for {extractor_name} extraction\n")
        f.write(f"# PDF: {pdf_path}\n")
        f.write(f"# Timestamp: {datetime.datetime.now().isoformat()}\n")
        if error:
            f.write(f"# Error: {error}\n")
        f.write(f"# Content length: {len(response_content)} characters\n")
        f.write("# " + "="*70 + "\n\n")
        f.write(response_content)
    
    print(f"DEBUG: Logged {extractor_name} response to {log_file_path}")
    return log_file_path


def log_xml_parsing_error(
    extractor_name: str,
    pdf_path: str,
    xml_content: str,
    error_message: str
) -> Path:
    """
    Log XML content that failed to parse.
    
    Args:
        extractor_name: Name of the extractor
        pdf_path: Path to the source PDF file
        xml_content: The XML content that failed to parse
        error_message: The parsing error message
        
    Returns:
        Path to the created log file
    """
    return log_extraction_response(
        extractor_name=extractor_name,
        pdf_path=pdf_path,
        response_content=xml_content,
        file_suffix=".error.xml",
        error=error_message
    )