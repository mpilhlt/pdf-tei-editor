"""
HTML templates and stylesheets of backend plugin frontend extensions.

A plugin may ship a ``templates/`` directory next to its ``extensions/`` directory:

    my_plugin/
    ├── extensions/my-extension.js
    └── templates/
        ├── my-dialog.html
        └── my-plugin.css

The directory is derived from each registered extension file as
``<extension file>.parent.parent / "templates"``, so ``plugin.py`` needs no change.
``*.html`` files become templates named by their file stem, ``*.css`` files are
concatenated into the plugin's stylesheet. Subdirectories and other files are ignored.

``GET /api/v1/plugins/extensions.js`` inlines both into the extension bundle (see
:func:`render_plugin_assets`), so templates behave the same in dev and production mode.

Template HTML is inserted with ``innerHTML``, where inline event handlers and
``javascript:`` URLs would execute and bypass the JS validator of the extensions.
Templates and stylesheets containing such content are rejected.
"""

import json
import logging
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

logger = logging.getLogger(__name__)

TEMPLATES_DIR = "templates"

_TEMPLATE_PATTERNS: list[tuple[str, str]] = [
    (r"<\s*script\b", "<script> element"),
    (r"<[^>]*\son[a-z]+\s*=", "inline event handler attribute (on*=)"),
    (r"javascript\s*:", "javascript: URL"),
]

_STYLESHEET_PATTERNS: list[tuple[str, str]] = [
    (r"@import\b", "@import rule"),
    (r"expression\s*\(", "CSS expression()"),
    (r"javascript\s*:", "javascript: URL"),
    (r"url\(\s*['\"]?\s*(?!data:|/api/|['\")\s])[a-z][a-z0-9+.-]*:", "url() with an external scheme"),
]

_VOID_ELEMENTS = frozenset(
    "area base br col embed hr img input link meta param source track wbr".split()
)


@dataclass
class PluginAssets:
    """Templates and stylesheet of one plugin, plus the problems found while collecting them."""

    templates: dict[str, str] = field(default_factory=dict)
    stylesheet: str = ""
    errors: list[str] = field(default_factory=list)


def _find_problems(content: str, patterns: list[tuple[str, str]]) -> list[str]:
    """Return the descriptions of all patterns that match ``content`` (case-insensitive)."""
    return [label for pattern, label in patterns if re.search(pattern, content, flags=re.IGNORECASE)]


def validate_template_html(content: str) -> list[str]:
    """
    Check template HTML for content that would execute when inserted via ``innerHTML``.

    Args:
        content: Template HTML

    Returns:
        Descriptions of the problems found; empty if the template is valid
    """
    return _find_problems(content, _TEMPLATE_PATTERNS)


def validate_stylesheet(content: str) -> list[str]:
    """
    Check a plugin stylesheet for imports, script URLs and external resources.

    ``url()`` may reference ``data:`` URIs, relative paths and ``/api/`` paths.

    Args:
        content: CSS text

    Returns:
        Descriptions of the problems found; empty if the stylesheet is valid
    """
    return _find_problems(content, _STYLESHEET_PATTERNS)


class _TopLevelNameParser(HTMLParser):
    """Collects the ``name`` attributes of the top-level elements of an HTML fragment."""

    def __init__(self) -> None:
        super().__init__()
        self.depth = 0
        self.names: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.depth == 0:
            name = dict(attrs).get("name")
            if name:
                self.names.append(name)
        if tag not in _VOID_ELEMENTS:
            self.depth += 1

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.depth == 0:
            name = dict(attrs).get("name")
            if name:
                self.names.append(name)

    def handle_endtag(self, tag: str) -> None:
        if tag not in _VOID_ELEMENTS and self.depth > 0:
            self.depth -= 1


def top_level_names(html: str) -> list[str]:
    """
    Return the ``name`` attributes of the top-level elements of an HTML fragment.

    Args:
        html: Template HTML

    Returns:
        Names in document order
    """
    parser = _TopLevelNameParser()
    parser.feed(html)
    parser.close()
    return parser.names


def name_prefix(plugin_id: str) -> str:
    """
    Return the prefix that top-level element names of a plugin's templates should start with.

    It is the plugin id in camelCase (``my-plugin`` and ``my_plugin`` become ``myPlugin``),
    since all named elements share the global ``ui`` tree.

    Args:
        plugin_id: Backend plugin id

    Returns:
        camelCase prefix
    """
    parts = [part for part in re.split(r"[-_.]", plugin_id) if part]
    if not parts:
        return ""
    return parts[0] + "".join(part[:1].upper() + part[1:] for part in parts[1:])


def templates_dir_for(extension_file: Path) -> Path:
    """
    Return the templates directory belonging to an extension file.

    Args:
        extension_file: Path of a registered extension (``<plugin>/extensions/x.js``)

    Returns:
        ``<plugin>/templates``
    """
    return extension_file.parent.parent / TEMPLATES_DIR


def collect_plugin_assets(templates_dir: Path, plugin_id: str) -> PluginAssets:
    """
    Read and validate the templates and stylesheets in a plugin's templates directory.

    Invalid or unreadable files are left out and recorded in ``errors``. A top-level
    element name without the plugin prefix (see :func:`name_prefix`) is logged as a warning.

    Args:
        templates_dir: The plugin's ``templates/`` directory
        plugin_id: Backend plugin id

    Returns:
        The plugin's assets; empty if the directory does not exist
    """
    assets = PluginAssets()
    if not templates_dir.is_dir():
        return assets

    prefix = name_prefix(plugin_id)
    stylesheets: list[str] = []
    for path in sorted(p for p in templates_dir.iterdir() if p.is_file()):
        if path.suffix not in (".html", ".css"):
            continue
        try:
            content = path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError) as e:
            assets.errors.append(f"{path.name}: {e}")
            continue

        problems = validate_template_html(content) if path.suffix == ".html" else validate_stylesheet(content)
        if problems:
            assets.errors.append(f"{path.name}: rejected ({', '.join(problems)})")
            continue

        if path.suffix == ".css":
            stylesheets.append(f"/* {path.name} */\n{content}")
            continue

        for name in top_level_names(content):
            if prefix and not name.startswith(prefix):
                logger.warning(
                    "Template %s of plugin %s: top-level name '%s' does not start with '%s'; it may clash with other named elements in the UI",
                    path.name, plugin_id, name, prefix,
                )
        assets.templates[path.stem] = content

    assets.stylesheet = "\n\n".join(stylesheets)
    return assets


def render_plugin_assets(plugin_id: str, assets: PluginAssets) -> str:
    """
    Render a plugin's assets as bundle JavaScript.

    Emits a ``window.registerFrontendExtensionStyles()`` call for the stylesheet, a
    ``window.registerFrontendExtensionTemplates()`` call for the templates and a
    comment for every rejected file. Values are serialized with ``json.dumps``, so
    they are JSON string literals, not JS template literals.

    Args:
        plugin_id: Backend plugin id
        assets: The plugin's assets

    Returns:
        JavaScript, or an empty string if the plugin has no assets and no errors
    """
    lines: list[str] = []
    for error in assets.errors:
        lines.append(f"// Skipped template file from {plugin_id}: {error}")
    plugin_literal = json.dumps(plugin_id)
    if assets.stylesheet:
        lines.append(f"// Frontend styles from plugin: {plugin_id}")
        lines.append(f"window.registerFrontendExtensionStyles({plugin_literal}, {json.dumps(assets.stylesheet)});")
    if assets.templates:
        lines.append(f"// Frontend templates from plugin: {plugin_id}")
        lines.append(f"window.registerFrontendExtensionTemplates({plugin_literal}, {json.dumps(assets.templates)});")
    return "\n".join(lines)
