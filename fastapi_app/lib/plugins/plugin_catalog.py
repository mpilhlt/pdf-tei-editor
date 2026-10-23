"""
Discovery of installable plugins on GitHub.

Plugin repositories are the configured sources (``PTE_PLUGIN_SOURCES``, default
``mpilhlt/pte-plugins``) and the repositories with the GitHub topic ``pte-plugin``
(see ``plugin_install_policy``). Each repository has an index ``pte-plugins.json`` on its
default branch::

    {"repository": "...", "plugins": [{"id": "grobid", "package": "pte-plugin-grobid",
      "module": "pte_plugin_grobid", "path": "plugins/grobid", "version": "1.0.0",
      "description": "...", "requires": [], "dependencies": ["requests>=2"],
      "engines": {"pte": ">=0.76.0"}}]}

``requires`` lists the ids of the plugins it requires, ``dependencies`` its other Python requirements.

A repository with a single plugin lists it with ``"path": "."``. Installable versions are the
repository's GitHub releases: the tag is ``<id>-v<version>`` (``v<version>`` in a single-plugin
repository), and the release has the wheel and a ``SHA256SUMS`` file as assets.

The catalog is cached in memory for an hour.
"""

import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import requests

from fastapi_app.lib.plugins.plugin_install_policy import (
    discover_topic,
    github_token,
    is_repository_name,
    is_trusted,
    plugin_sources,
    trusted_only,
)

logger = logging.getLogger(__name__)

API_URL = "https://api.github.com"
RAW_URL = "https://raw.githubusercontent.com"
INDEX_FILE = "pte-plugins.json"
CHECKSUMS_ASSET = "SHA256SUMS"
CACHE_TTL = 3600.0
REQUEST_TIMEOUT = 20.0
MAX_TOPIC_REPOSITORIES = 50
MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024


class CatalogError(Exception):
    """A plugin repository or release cannot be read."""


class GitHubClient(Protocol):
    """HTTP access to GitHub (replaced by a fake in tests)."""

    def get_json(self, url: str) -> Any:
        """GET a JSON document; raises CatalogError."""
        ...

    def get_text(self, url: str) -> str:
        """GET a text document; raises CatalogError."""
        ...

    def download(self, url: str, dest: Path) -> None:
        """Download a file; raises CatalogError."""
        ...


class RequestsGitHubClient:
    """GitHubClient using requests, with the optional ``GITHUB_TOKEN``."""

    def _headers(self, url: str, accept: str) -> dict[str, str]:
        headers = {"Accept": accept, "User-Agent": "pdf-tei-editor-plugin-manager"}
        token = github_token()
        if token and url.startswith(API_URL):
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def _get(self, url: str, accept: str, stream: bool = False) -> requests.Response:
        try:
            response = requests.get(url, headers=self._headers(url, accept), timeout=REQUEST_TIMEOUT, stream=stream)
        except requests.RequestException as e:
            raise CatalogError(f"Request to {url} failed: {e}") from e
        if response.status_code != 200:
            raise CatalogError(f"Request to {url} failed with HTTP {response.status_code}")
        return response

    def get_json(self, url: str) -> Any:
        try:
            return self._get(url, "application/vnd.github+json").json()
        except ValueError as e:
            raise CatalogError(f"Invalid JSON from {url}: {e}") from e

    def get_text(self, url: str) -> str:
        return self._get(url, "text/plain").text

    def download(self, url: str, dest: Path) -> None:
        response = self._get(url, "application/octet-stream", stream=True)
        size = 0
        try:
            with open(dest, "wb") as f:
                for chunk in response.iter_content(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_DOWNLOAD_SIZE:
                        raise CatalogError(f"Download of {url} exceeds {MAX_DOWNLOAD_SIZE // (1024 * 1024)} MB")
                    f.write(chunk)
        except requests.RequestException as e:
            raise CatalogError(f"Download of {url} failed: {e}") from e


@dataclass(frozen=True)
class CatalogRelease:
    """An installable release of a plugin."""

    version: str
    tag: str
    wheel_name: str
    wheel_url: str
    checksums_url: str | None
    published_at: str
    prerelease: bool


@dataclass
class CatalogEntry:
    """A plugin listed in a repository's index, with its installable releases."""

    id: str
    repository: str
    package: str
    module: str
    path: str
    version: str
    description: str
    requires: list[str]
    engines: dict[str, str]
    trusted: bool
    dependencies: list[str] = field(default_factory=list)  # Python requirements besides plugins
    releases: list[CatalogRelease] = field(default_factory=list)

    @property
    def latest(self) -> CatalogRelease | None:
        """The newest release that is not a prerelease (or the newest prerelease)."""
        stable = [r for r in self.releases if not r.prerelease]
        return (stable or self.releases or [None])[0]

    def release(self, version: str) -> CatalogRelease | None:
        """The release of a version, or None."""
        return next((r for r in self.releases if r.version == version), None)


@dataclass
class Catalog:
    """Plugins available for installation, and the repositories that could not be read."""

    entries: list[CatalogEntry]
    errors: dict[str, str]
    fetched_at: float


def _release_tag_pattern(plugin_id: str, single: bool) -> re.Pattern[str]:
    prefix = "" if single else re.escape(plugin_id) + "-"
    return re.compile(rf"^{prefix}v(?P<version>\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)$")


def _wheel_prefix(module: str, version: str) -> str:
    return f"{module}-{version}-"


class PluginCatalog:
    """Reads and caches the plugins available in the plugin repositories."""

    def __init__(self, client: GitHubClient | None = None, ttl: float = CACHE_TTL):
        self.client: GitHubClient = client or RequestsGitHubClient()
        self.ttl = ttl
        self._cache: Catalog | None = None
        self._cache_key: tuple[object, ...] | None = None

    def repositories(self) -> tuple[list[str], dict[str, str]]:
        """
        The repositories to read: the configured sources, then the topic search results.

        Returns:
            (repositories, errors by source)
        """
        repos = list(dict.fromkeys(plugin_sources()))
        errors: dict[str, str] = {}
        topic = discover_topic()
        if topic:
            url = f"{API_URL}/search/repositories?q=topic:{topic}&per_page={MAX_TOPIC_REPOSITORIES}"
            try:
                result = self.client.get_json(url)
                for item in result.get("items", []) if isinstance(result, dict) else []:
                    name = str(item.get("full_name", ""))
                    if is_repository_name(name) and name not in repos and not item.get("archived"):
                        repos.append(name)
            except CatalogError as e:
                errors[f"topic:{topic}"] = str(e)
        if trusted_only():
            repos = [r for r in repos if is_trusted(r)]
        return repos, errors

    @property
    def fetched_at(self) -> float | None:
        """When the cached catalog was read, None if there is none."""
        return self._cache.fetched_at if self._cache is not None else None

    def get(self, refresh: bool = False) -> Catalog:
        """
        The catalog, from the cache unless it is older than the TTL or ``refresh`` is set.
        """
        key = (tuple(plugin_sources()), discover_topic(), trusted_only())
        cached = self._cache
        if not refresh and cached is not None and self._cache_key == key and time.time() - cached.fetched_at < self.ttl:
            return cached
        repos, errors = self.repositories()
        entries: list[CatalogEntry] = []
        for repo in repos:
            try:
                entries.extend(self.read_repository(repo))
            except CatalogError as e:
                logger.warning(f"Cannot read plugin repository {repo}: {e}")
                errors[repo] = str(e)
        catalog = Catalog(entries=entries, errors=errors, fetched_at=time.time())
        self._cache, self._cache_key = catalog, key
        return catalog

    def read_repository(self, repository: str) -> list[CatalogEntry]:
        """
        Read the index and the releases of a plugin repository.

        Raises:
            CatalogError: If the repository or its index cannot be read
        """
        if not is_repository_name(repository):
            raise CatalogError(f"Invalid repository name: {repository}")
        info = self.client.get_json(f"{API_URL}/repos/{repository}")
        branch = str(info.get("default_branch", "main")) if isinstance(info, dict) else "main"
        index = self.client.get_json(f"{RAW_URL}/{repository}/{branch}/{INDEX_FILE}")
        if not isinstance(index, dict) or not isinstance(index.get("plugins"), list):
            raise CatalogError(f"{INDEX_FILE} must contain a 'plugins' list")
        releases = self.client.get_json(f"{API_URL}/repos/{repository}/releases?per_page=100")
        if not isinstance(releases, list):
            raise CatalogError("Unexpected answer for the releases")
        trusted = is_trusted(repository)
        entries: list[CatalogEntry] = []
        plugins = [p for p in index["plugins"] if isinstance(p, dict)]
        single = len(plugins) == 1 and str(plugins[0].get("path", "")) in (".", "")
        for item in plugins:
            plugin_id = str(item.get("id", ""))
            module = str(item.get("module", ""))
            if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", plugin_id) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", module):
                logger.warning(f"Skipping invalid entry in {repository}/{INDEX_FILE}: {item!r}")
                continue
            engines = item.get("engines") if isinstance(item.get("engines"), dict) else {}
            entry = CatalogEntry(
                id=plugin_id,
                repository=repository,
                package=str(item.get("package", "")),
                module=module,
                path=str(item.get("path", ".")),
                version=str(item.get("version", "")),
                description=str(item.get("description", "")),
                requires=[str(r) for r in item.get("requires", []) if isinstance(r, str)],
                engines={str(k): str(v) for k, v in (engines or {}).items()},
                trusted=trusted,
                dependencies=[str(d) for d in item.get("dependencies", []) if isinstance(d, str)],
            )
            entry.releases = self._releases(entry, releases, single)
            entries.append(entry)
        return entries

    @staticmethod
    def _releases(entry: CatalogEntry, releases: list[Any], single: bool) -> list[CatalogRelease]:
        """The releases of a plugin that have a matching wheel, newest first (GitHub order)."""
        pattern = _release_tag_pattern(entry.id, single)
        result: list[CatalogRelease] = []
        for release in releases:
            if not isinstance(release, dict) or release.get("draft"):
                continue
            match = pattern.match(str(release.get("tag_name", "")))
            if not match:
                continue
            version = match.group("version")
            assets = {str(a.get("name")): str(a.get("browser_download_url")) for a in release.get("assets", []) if isinstance(a, dict)}
            wheel = next(
                (n for n in sorted(assets) if n.endswith("-py3-none-any.whl") and n.startswith(_wheel_prefix(entry.module, version))),
                None,
            )
            if wheel is None:
                continue
            result.append(
                CatalogRelease(
                    version=version,
                    tag=str(release["tag_name"]),
                    wheel_name=wheel,
                    wheel_url=assets[wheel],
                    checksums_url=assets.get(CHECKSUMS_ASSET),
                    published_at=str(release.get("published_at", "")),
                    prerelease=bool(release.get("prerelease")),
                )
            )
        return result

    def find(self, repository: str, plugin_id: str) -> CatalogEntry:
        """
        Read a plugin's current releases (bypassing the cache) from a listed repository.

        Raises:
            CatalogError: If the repository is not a plugin source or does not list the plugin
        """
        repos, _ = self.repositories() if repository not in plugin_sources() else ([repository], {})
        if repository not in repos:
            raise CatalogError(f"{repository} is not a plugin repository of this installation")
        entry = next((e for e in self.read_repository(repository) if e.id == plugin_id), None)
        if entry is None:
            raise CatalogError(f"{repository} does not list the plugin {plugin_id}")
        return entry

    def invalidate(self) -> None:
        """Drop the cached catalog."""
        self._cache = None
