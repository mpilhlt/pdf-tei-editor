"""
The pages of the core user manual in ``docs/``, for the manual search (``app/src/modules/manual-search.js``).

The manual consists of ``index.md``, ``about.md`` and the Markdown files below ``user-manual/``. The developer
documentation (``development/``, ``code-assistant/``, ``api/``) is not part of it. Pages are listed in the order in
which they are linked, starting from ``index.md``; pages that no manual page links to follow in alphabetical order.
"""

import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

MANUAL_ROOT_PAGES: tuple[str, ...] = ("index.md", "about.md")
"""Pages directly in ``docs/`` that belong to the manual"""

MANUAL_DIRECTORY = "user-manual"
"""Directory below ``docs/`` whose Markdown files belong to the manual"""

_LINK = re.compile(r"\]\(\s*<?([^)\s>#]+\.md)(?:#[^)\s>]*)?>?(?:\s+\"[^\"]*\")?\s*\)")
_TITLE = re.compile(r"^#\s+(.+?)\s*#*\s*$", re.MULTILINE)
_FENCE = re.compile(r"^(```|~~~).*?^\1", re.MULTILINE | re.DOTALL)


@dataclass(frozen=True)
class ManualPageInfo:
    """A page of the core manual."""

    path: str
    """Path relative to ``docs/``, e.g. ``user-manual/review-workflow.md``"""
    title: str
    """Text of the first level-1 heading, or the file name without extension"""


def _manual_files(docs_root: Path) -> set[str]:
    """Paths (relative to ``docs_root``) of the Markdown files that belong to the manual."""
    files = {name for name in MANUAL_ROOT_PAGES if (docs_root / name).is_file()}
    directory = docs_root / MANUAL_DIRECTORY
    if directory.is_dir():
        files.update(path.relative_to(docs_root).as_posix() for path in directory.rglob("*.md") if path.is_file())
    return files


def _resolve_link(page: str, target: str) -> str | None:
    """The path relative to ``docs/`` of a relative link ``target`` on ``page``, or None if it leaves ``docs/``."""
    if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.IGNORECASE) or target.startswith("/"):
        return None
    parts: list[str] = list(PurePosixPath(page).parent.parts)
    for part in PurePosixPath(target).parts:
        if part == "..":
            if not parts:
                return None
            parts.pop()
        elif part != ".":
            parts.append(part)
    return "/".join(parts)


def _title(markdown: str, path: str) -> str:
    """The first level-1 heading of a page (outside code blocks), else the file name."""
    match = _TITLE.search(_FENCE.sub("", markdown))
    return match.group(1) if match else PurePosixPath(path).stem


def list_manual_pages(docs_root: Path) -> list[ManualPageInfo]:
    """
    The pages of the core user manual, in reading order.

    Args:
        docs_root: The ``docs/`` directory

    Returns:
        The pages reachable by links from ``index.md`` in breadth-first order, then the remaining manual pages
        alphabetically
    """
    files = _manual_files(docs_root)
    texts = {path: (docs_root / path).read_text(encoding="utf-8") for path in files}
    ordered: list[str] = []
    seen: set[str] = set()
    queue = [page for page in MANUAL_ROOT_PAGES[:1] if page in files]
    while queue:
        page = queue.pop(0)
        if page in seen:
            continue
        seen.add(page)
        ordered.append(page)
        for match in _LINK.finditer(_FENCE.sub("", texts[page])):
            target = _resolve_link(page, match.group(1))
            if target in files and target not in seen:
                queue.append(target)
    ordered.extend(sorted(files - seen))
    return [ManualPageInfo(path=path, title=_title(texts[path], path)) for path in ordered]
