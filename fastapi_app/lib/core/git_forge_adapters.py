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
from dataclasses import dataclass
from urllib.parse import quote, urlencode, urlsplit

import requests

from fastapi_app.lib.core.url_cache import UrlCache

logger = logging.getLogger(__name__)

_SHA_RE = re.compile(r'^[0-9a-f]{40}$')

# Conservative margin under common browser/proxy URL-length limits (~8KB) -
# see BaseGitForgeAdapter.build_propose_change_url()'s docstring.
_MAX_PROPOSE_URL_LENGTH = 7600


@dataclass(frozen=True)
class ProposeChangeTarget:
    """Where build_propose_change_url() sends the visitor, and whether `text` made it into the URL itself."""

    url: str
    content_prefilled: bool


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

    @abstractmethod
    def strip_ref(self, url: str) -> str:
        """
        Return `url` (fragment removed) with its branch/tag/SHA ref segment
        replaced by a fixed placeholder, so two URLs to the same file
        differing only in ref normalize to the same string. Assumes no real
        branch/tag is itself named the same as the placeholder.
        """

    @abstractmethod
    def is_sha_pinned(self, url: str) -> bool:
        """True if `url`'s ref segment is already a 40-character commit SHA (immutable content)."""

    @abstractmethod
    def build_propose_change_url(self, url: str, text: str, cache: UrlCache) -> "ProposeChangeTarget | None":
        """
        Build a URL that lets the visitor's own forge session propose `text`
        as the new content of the file `url` points to (blob or raw form,
        any ref - branch, tag, or commit SHA). Returns None if `url`'s
        owner/repo/ref/path can't be parsed. A SHA-pinned ref is resolved to
        the repo's default branch via one `cache`-backed, unauthenticated API
        call, mirroring resolve_ref_to_sha().
        """


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

    def strip_ref(self, url: str) -> str:
        base_url, _, _ = url.partition("#")
        m = self._parse(base_url)
        return f"https://github.com/{m['owner']}/{m['repo']}/blob/_/{m['path']}"

    def is_sha_pinned(self, url: str) -> bool:
        base_url, _, _ = url.partition("#")
        m = self._parse(base_url)
        return bool(_SHA_RE.match(m['ref']))

    _RAW_RE = re.compile(r'^/(?P<owner>[^/]+)/(?P<repo>[^/]+)/(?P<ref>[^/]+)/(?P<path>.+)$')

    def _parse_any(self, base_url: str) -> "re.Match[str]":
        """Parse either a github.com blob URL or a raw.githubusercontent.com URL into the same named groups."""
        parts = urlsplit(base_url)
        if parts.hostname == "github.com" and "/blob/" in parts.path:
            return self._parse(base_url)
        if parts.hostname == "raw.githubusercontent.com":
            match = self._RAW_RE.match(parts.path)
            if not match:
                raise ValueError(f"Not a recognized raw.githubusercontent.com URL: {base_url}")
            return match
        raise ValueError(f"Not a recognized GitHub URL: {base_url}")

    def _default_branch(self, owner: str, repo: str, cache: UrlCache) -> str:
        api_url = f"https://api.github.com/repos/{owner}/{repo}"
        # Cached under a key distinct from api_url itself: resolve_ref_to_sha()
        # caches "{api_url}/commits/{ref}", which would make cache_root/.../{repo}
        # a directory - colliding with the file get_cache_info() would derive
        # for api_url here (same path, one segment shorter).
        cache_key = f"{api_url}/_default_branch"
        branch = cache.get_text(cache_key)
        if branch is None:
            response = requests.get(
                api_url, timeout=10, headers={"Accept": "application/vnd.github+json"}
            )
            response.raise_for_status()
            branch = response.json()["default_branch"]
            cache.set_text(cache_key, branch)
        return branch

    def build_propose_change_url(self, url: str, text: str, cache: UrlCache) -> "ProposeChangeTarget | None":
        base_url, _, _ = url.partition("#")
        try:
            m = self._parse_any(base_url)
        except ValueError:
            return None
        owner, repo, ref, path = m['owner'], m['repo'], m['ref'], m['path']
        branch = ref if not _SHA_RE.match(ref) else self._default_branch(owner, repo, cache)

        # /edit/, not /new/: this feature always targets a resource that
        # already exists upstream (an override is layered on top of one).
        # /new/{branch}?filename={existing path} looks like it would work -
        # GitHub happily prefills the editor with `value` either way - but
        # it performs a create-blob operation on commit, which GitHub
        # rejects with "A file with the same name already exists" for a
        # path that's already there. /edit/{branch}/{path} is the route
        # GitHub's own UI uses for editing an existing file and correctly
        # performs an update instead.
        edit_url = f"https://github.com/{owner}/{repo}/edit/{branch}/{path}"
        prefilled_url = f"{edit_url}?{urlencode({'value': text})}"
        if len(prefilled_url) <= _MAX_PROPOSE_URL_LENGTH:
            return ProposeChangeTarget(url=prefilled_url, content_prefilled=True)

        return ProposeChangeTarget(url=edit_url, content_prefilled=False)


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

    def strip_ref(self, url: str) -> str:
        base_url, _, _ = url.partition("#")
        origin, project_path, _ref, file_path = self._split(base_url)
        return f"{origin}/{project_path}/-/blob/_/{file_path}"

    def is_sha_pinned(self, url: str) -> bool:
        base_url, _, _ = url.partition("#")
        _origin, _project_path, ref, _file_path = self._split(base_url)
        return bool(_SHA_RE.match(ref))

    _RAW_MARKER = "/-/raw/"

    def _split_any(self, base_url: str) -> "tuple[str, str, str, str]":
        """Like _split(), but also recognizes a `/-/raw/` (rather than only `/-/blob/`) URL shape."""
        parts = urlsplit(base_url)
        for marker in (self._MARKER, self._RAW_MARKER):
            if marker in parts.path:
                project_path, _, rest = parts.path.partition(marker)
                ref, _, file_path = rest.partition("/")
                origin = f"{parts.scheme}://{parts.netloc}"
                return origin, project_path.strip("/"), ref, file_path
        raise ValueError(f"Not a recognized GitLab URL: {base_url}")

    def _default_branch(self, origin: str, project_path: str, cache: UrlCache) -> str:
        encoded_project = quote(project_path, safe="")
        api_url = f"{origin}/api/v4/projects/{encoded_project}"
        # Cached under a key distinct from api_url itself: resolve_ref_to_sha()
        # caches "{api_url}/repository/commits/{ref}", which would make
        # cache_root/.../{encoded_project} a directory - colliding with the
        # file get_cache_info() would derive for api_url here.
        cache_key = f"{api_url}/_default_branch"
        branch = cache.get_text(cache_key)
        if branch is None:
            response = requests.get(api_url, timeout=10)
            response.raise_for_status()
            branch = response.json()["default_branch"]
            cache.set_text(cache_key, branch)
        return branch

    def build_propose_change_url(self, url: str, text: str, cache: UrlCache) -> "ProposeChangeTarget | None":
        base_url, _, _ = url.partition("#")
        try:
            origin, project_path, ref, file_path = self._split_any(base_url)
        except ValueError:
            return None
        branch = ref if not _SHA_RE.match(ref) else self._default_branch(origin, project_path, cache)
        edit_url = f"{origin}/{project_path}/-/edit/{branch}/{file_path}"
        return ProposeChangeTarget(url=edit_url, content_prefilled=False)


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

    def all_adapters(self) -> "list[BaseGitForgeAdapter]":
        """Every registered adapter, in registration order - unlike get_adapter_for(), not filtered by matches()."""
        return list(self._adapters)


def _register_builtin_adapters(registry: GitForgeAdapterRegistry) -> None:
    registry.register(GitHubAdapter())
    registry.register(GitLabAdapter())
