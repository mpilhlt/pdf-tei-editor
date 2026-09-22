"""
Pluggable registry of git-forge URL adapters (GitHub, GitLab, ...).

Each adapter recognizes one forge's blob-URL shape and knows how to turn it
into a raw-fetchable URL and how to resolve a branch/tag ref to the current
commit SHA, so annotation-rules links (see annotation_rules_utils.py) can be
permalink-pinned and fetched as raw text regardless of which forge hosts
them. See docs/superpowers/specs/2026-09-22-editorial-decl-annotation-rules-design.md
(Part D) for the rationale. Modeled on the existing ExtractorRegistry pattern
(fastapi_app/lib/extraction/registry.py).

Adding a new forge: implement BaseGitForgeAdapter and register an instance
in _register_builtin_adapters() below (or, for an institution-specific host,
call GitForgeAdapterRegistry.get_instance().register(...) from anywhere,
e.g. a plugin's initialize()).
"""

import logging
import re
from abc import ABC, abstractmethod
from urllib.parse import quote, urlsplit

import requests

from fastapi_app.lib.core.url_cache import UrlCache

logger = logging.getLogger(__name__)

_SHA_RE = re.compile(r'^[0-9a-f]{40}$')


class BaseGitForgeAdapter(ABC):
    """One recognized git-forge URL shape (GitHub, GitLab, ...)."""

    @abstractmethod
    def matches(self, url: str) -> bool:
        """True if this adapter recognizes the URL's host/path shape."""

    @abstractmethod
    def to_raw_url(self, url: str) -> str:
        """Transform a blob/view URL (fragment already stripped) into a directly-fetchable raw-text URL."""

    @abstractmethod
    def resolve_ref_to_sha(self, url: str, cache: UrlCache) -> str:
        """Return `url` with its branch/tag ref replaced by the current commit SHA, fragment preserved."""


class GitHubAdapter(BaseGitForgeAdapter):
    """Adapter for github.com blob URLs."""

    _BLOB_RE = re.compile(r'^/(?P<owner>[^/]+)/(?P<repo>[^/]+)/blob/(?P<ref>[^/]+)/(?P<path>.+)$')

    def matches(self, url: str) -> bool:
        parts = urlsplit(url)
        return parts.hostname == "github.com" and "/blob/" in parts.path

    def _parse(self, base_url: str) -> "re.Match[str]":
        parts = urlsplit(base_url)
        match = self._BLOB_RE.match(parts.path)
        if not match:
            raise ValueError(f"Not a recognized GitHub blob URL: {base_url}")
        return match

    def to_raw_url(self, url: str) -> str:
        m = self._parse(url)
        return (
            f"https://raw.githubusercontent.com/{m['owner']}/{m['repo']}/"
            f"{m['ref']}/{m['path']}"
        )

    def resolve_ref_to_sha(self, url: str, cache: UrlCache) -> str:
        base_url, _, fragment = url.partition("#")
        m = self._parse(base_url)
        ref = m['ref']
        if _SHA_RE.match(ref):
            return url
        api_url = f"https://api.github.com/repos/{m['owner']}/{m['repo']}/commits/{ref}"
        sha = cache.get_text(api_url)
        if sha is None:
            response = requests.get(
                api_url, timeout=10, headers={"Accept": "application/vnd.github+json"}
            )
            response.raise_for_status()
            sha = response.json()["sha"]
            cache.set_text(api_url, sha)
        resolved = f"https://github.com/{m['owner']}/{m['repo']}/blob/{sha}/{m['path']}"
        return f"{resolved}#{fragment}" if fragment else resolved


class GitLabAdapter(BaseGitForgeAdapter):
    """Adapter for GitLab blob URLs (gitlab.com and self-hosted instances)."""

    _MARKER = "/-/blob/"

    def matches(self, url: str) -> bool:
        return self._MARKER in urlsplit(url).path

    def _split(self, base_url: str) -> "tuple[str, str, str, str]":
        """Returns (origin, project_path, ref, file_path)."""
        parts = urlsplit(base_url)
        project_path, _, rest = parts.path.partition(self._MARKER)
        ref, _, file_path = rest.partition("/")
        origin = f"{parts.scheme}://{parts.netloc}"
        return origin, project_path.strip("/"), ref, file_path

    def to_raw_url(self, url: str) -> str:
        origin, project_path, ref, file_path = self._split(url)
        return f"{origin}/{project_path}/-/raw/{ref}/{file_path}"

    def resolve_ref_to_sha(self, url: str, cache: UrlCache) -> str:
        base_url, _, fragment = url.partition("#")
        origin, project_path, ref, file_path = self._split(base_url)
        if _SHA_RE.match(ref):
            return url
        encoded_project = quote(project_path, safe="")
        api_url = f"{origin}/api/v4/projects/{encoded_project}/repository/commits/{ref}"
        sha = cache.get_text(api_url)
        if sha is None:
            response = requests.get(api_url, timeout=10)
            response.raise_for_status()
            sha = response.json()["id"]
            cache.set_text(api_url, sha)
        resolved = f"{origin}/{project_path}/-/blob/{sha}/{file_path}"
        return f"{resolved}#{fragment}" if fragment else resolved


class GitForgeAdapterRegistry:
    """Registry of adapters, checked in registration order."""

    _instance: "GitForgeAdapterRegistry | None" = None

    def __init__(self):
        self._adapters: list[BaseGitForgeAdapter] = []

    @classmethod
    def get_instance(cls) -> "GitForgeAdapterRegistry":
        """Get the singleton registry instance, pre-populated with the built-in adapters."""
        if cls._instance is None:
            cls._instance = cls()
            _register_builtin_adapters(cls._instance)
        return cls._instance

    def register(self, adapter: BaseGitForgeAdapter) -> None:
        """Register an adapter. Called at module import for built-ins, or by a plugin for a custom one."""
        self._adapters.append(adapter)

    def get_adapter_for(self, url: str) -> "BaseGitForgeAdapter | None":
        """First registered adapter whose matches() returns True for `url`, else None."""
        for adapter in self._adapters:
            if adapter.matches(url):
                return adapter
        return None


def _register_builtin_adapters(registry: GitForgeAdapterRegistry) -> None:
    registry.register(GitHubAdapter())
    registry.register(GitLabAdapter())
