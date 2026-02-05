"""PDF image extraction utilities for KISSKI plugin."""

import logging
import shutil
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

# Flag to track if pdf2image/poppler is available
_pdf2image_available: bool | None = None


def check_pdf2image_available() -> bool:
    """Check if pdf2image and poppler are available."""
    global _pdf2image_available
    if _pdf2image_available is not None:
        return _pdf2image_available

    try:
        from pdf2image import convert_from_path  # noqa: F401
        from pdf2image.exceptions import PDFInfoNotInstalledError

        # pdf2image is importable, now check if poppler is actually installed
        # by calling pdfinfo --help (which pdf2image uses internally)
        import subprocess

        try:
            subprocess.run(
                ["pdfinfo", "-v"],
                capture_output=True,
                check=True,
                timeout=5,
            )
            _pdf2image_available = True
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            logger.warning(
                "poppler not installed - PDF extraction disabled. "
                "Install with: brew install poppler (macOS) or apt-get install poppler-utils (Linux)"
            )
            _pdf2image_available = False

    except ImportError:
        logger.warning("pdf2image not installed - PDF extraction disabled")
        _pdf2image_available = False

    return _pdf2image_available


def extract_pdf_to_images(
    pdf_path: str,
    dpi: int = 150,
    max_pages: int = 5
) -> tuple[list[Path], Path]:
    """
    Extract images from PDF pages to a temporary directory.

    Args:
        pdf_path: Path to PDF file
        dpi: Resolution for image extraction (default 150 for balance of quality/size)
        max_pages: Maximum number of pages to extract (default 5 for metadata extraction)

    Returns:
        Tuple of (list of image paths, temp directory path for cleanup)

    Raises:
        RuntimeError: If pdf2image/poppler not available
    """
    if not check_pdf2image_available():
        raise RuntimeError(
            "PDF image extraction requires pdf2image and poppler. "
            "Install with: pip install pdf2image (and install poppler on your system)"
        )

    from pdf2image import convert_from_path
    from pdf2image.exceptions import PDFInfoNotInstalledError

    # Create temp directory for this extraction
    temp_dir = Path(tempfile.mkdtemp(prefix="kisski_pdf_"))

    try:
        # Limit to first max_pages pages for efficiency
        pages = convert_from_path(
            pdf_path,
            dpi=dpi,
            first_page=1,
            last_page=max_pages
        )
    except PDFInfoNotInstalledError:
        global _pdf2image_available
        _pdf2image_available = False
        # Clean up temp dir on error
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise RuntimeError(
            "poppler not installed. Install poppler-utils on Linux, "
            "or use 'brew install poppler' on macOS"
        )

    image_paths = []
    for i, page in enumerate(pages):
        img_path = temp_dir / f"page_{i:04d}.jpg"
        page.save(str(img_path), format="JPEG", quality=85)
        image_paths.append(img_path)

    logger.debug(f"Extracted {len(pages)} images from PDF to {temp_dir} (max_pages={max_pages})")
    return image_paths, temp_dir


def cleanup_temp_dir(temp_dir: Path) -> None:
    """
    Clean up temporary directory after extraction.

    Args:
        temp_dir: Path to temporary directory to delete
    """
    if temp_dir and temp_dir.exists():
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.debug(f"Cleaned up temp directory {temp_dir}")
