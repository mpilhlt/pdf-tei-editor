"""
Tesseract model folders of the OCRmyPDF plugin.

The fast models come from the system packages (`tesseract-ocr-<lang>` on Debian). The more
accurate `tessdata_best` models are downloaded at startup into the host-wide shared data
directory (see fastapi_app/lib/core/shared_data.py), once per host.

Tesseract reads its models from one folder, `TESSDATA_PREFIX`. The plugin therefore builds an
instance-local link folder with a symlink to every entry of the system folder (the fast
models, `configs/`, `tessconfigs/`) plus `best` pointing to the shared best-model folder, and
sets `TESSDATA_PREFIX` to it once at startup. Tesseract lists the best models as `best/<lang>`;
OCRmyPDF's worker processes and the footnote marker recognizer inherit the environment.
"""

import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, Optional

from fastapi_app.lib.core.shared_data import download_shared_file

logger = logging.getLogger(__name__)

TESSDATA_BEST_VERSION = "4.1.0"
BEST_MODELS_DIR_NAME = f"tesseract/tessdata_best-{TESSDATA_BEST_VERSION}"
"""Name of the shared directory with the tessdata_best models (see get_shared_data_dir())."""

BEST_MODEL_URL = "https://github.com/tesseract-ocr/tessdata_best/raw/" + TESSDATA_BEST_VERSION + "/{lang}.traineddata"

BEST_LINK_NAME = "best"
"""Name of the link to the best-model folder in the link folder; Tesseract lists its models as best/<lang>."""

_LANGUAGE_CODE = re.compile(r"^[A-Za-z0-9_]+$")


def system_tessdata_dir(link_dir: Path) -> Optional[Path]:
    """
    Return the folder Tesseract reads its models from without the link folder.

    Parsed from the first line of `tesseract --list-langs`
    (`List of available languages in "/usr/share/tesseract-ocr/5/tessdata/" (4):`).
    A TESSDATA_PREFIX set by the administrator is respected; one pointing to the link folder
    (set by an earlier initialization in this process) is ignored.

    Args:
        link_dir: The link folder

    Returns:
        The folder, or None if Tesseract does not report it
    """
    env = dict(os.environ)
    prefix = env.get("TESSDATA_PREFIX")
    if prefix and Path(prefix).resolve() == link_dir.resolve():
        del env["TESSDATA_PREFIX"]
    try:
        result = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=30, check=True, env=env)
    except (OSError, subprocess.SubprocessError) as e:
        logger.warning(f"Could not determine the Tesseract model folder: {e}")
        return None
    first_line = (result.stdout.splitlines() or [""])[0]
    match = re.search(r'"([^"]+)"', first_line)
    if match is None:
        logger.warning(f"Could not determine the Tesseract model folder from: {first_line!r}")
        return None
    return Path(match.group(1))


def _expected_links(system_dir: Path, best_dir: Path) -> dict[str, Path]:
    """Return the link names of the link folder and their targets."""
    links = {entry.name: entry.resolve() for entry in system_dir.iterdir() if entry.name != BEST_LINK_NAME}
    links[BEST_LINK_NAME] = best_dir.resolve()
    return links


def _is_current(link_dir: Path, links: dict[str, Path]) -> bool:
    """Return whether the link folder exists and contains exactly the expected links."""
    if not link_dir.is_dir():
        return False
    entries = list(link_dir.iterdir())
    if {entry.name for entry in entries} != set(links):
        return False
    return all(entry.is_symlink() and Path(os.readlink(entry)) == links[entry.name] for entry in entries)


def build_link_dir(system_dir: Path, best_dir: Path, link_dir: Path) -> bool:
    """
    Build the link folder that TESSDATA_PREFIX points to, unless it is already up to date.

    The folder gets a symlink to every entry of `system_dir` and a link `best` to `best_dir`.
    It is built next to `link_dir` and swapped in with renames, so that a process starting at
    the same time never sees a half-built folder. An up-to-date folder is left alone, since
    other workers may be using it.

    Args:
        system_dir: The system model folder
        best_dir: The shared folder with the tessdata_best models
        link_dir: The link folder to create or replace

    Returns:
        True if the folder was (re)built, False if it was up to date
    """
    links = _expected_links(system_dir, best_dir)
    if _is_current(link_dir, links):
        return False
    link_dir.parent.mkdir(parents=True, exist_ok=True)
    new_dir = Path(tempfile.mkdtemp(prefix=f".{link_dir.name}-", dir=link_dir.parent))
    try:
        for name, target in links.items():
            (new_dir / name).symlink_to(target, target_is_directory=target.is_dir())
        new_dir.chmod(0o755)
        old_dir: Optional[Path] = None
        if link_dir.exists():
            # a directory cannot be replaced by a rename; move the old one aside first
            old_dir = Path(tempfile.mkdtemp(prefix=f".{link_dir.name}-old-", dir=link_dir.parent))
            old_dir.rmdir()
            try:
                link_dir.rename(old_dir)
            except FileNotFoundError:
                old_dir = None  # another process moved it aside first
        try:
            new_dir.rename(link_dir)
        except OSError:
            # another process swapped in its folder first; both are equivalent
            if not link_dir.is_dir():
                raise
            shutil.rmtree(new_dir, ignore_errors=True)
        if old_dir is not None:
            shutil.rmtree(old_dir, ignore_errors=True)
        return True
    except BaseException:
        shutil.rmtree(new_dir, ignore_errors=True)
        raise


def parse_languages(value: str | list[str] | None) -> list[str]:
    """
    Parse the configured best-model languages.

    Args:
        value: Tesseract codes separated by spaces or commas, or a list of codes

    Returns:
        The valid codes in order, without duplicates; invalid ones are logged and dropped
    """
    if value is None:
        return []
    items = value if isinstance(value, list) else re.split(r"[\s,]+", value)
    languages: list[str] = []
    for item in items:
        code = str(item).strip()
        if not code:
            continue
        if not _LANGUAGE_CODE.match(code):
            logger.warning(f"Ignoring invalid Tesseract language code {code!r} in the best-model languages")
            continue
        if code not in languages:
            languages.append(code)
    return languages


def download_best_models(languages: list[str], best_dir: Path, on_downloaded: Callable[[], None]) -> None:
    """
    Download the missing tessdata_best models of the given languages.

    A failed download is logged and the next language is tried; it is retried at the next start.

    Args:
        languages: Tesseract codes such as "deu"
        best_dir: The shared folder with the tessdata_best models
        on_downloaded: Called after each newly downloaded model
    """
    for lang in languages:
        target = best_dir / f"{lang}.traineddata"
        if target.exists():
            continue
        url = BEST_MODEL_URL.format(lang=lang)
        try:
            if download_shared_file(url, target):
                on_downloaded()
        except Exception as e:
            logger.warning(f"Could not download the tessdata_best model '{lang}' from {url}: {e}")


def set_tessdata_prefix(link_dir: Path) -> None:
    """Point Tesseract at the link folder, for this process and the processes it starts."""
    os.environ["TESSDATA_PREFIX"] = str(link_dir)
