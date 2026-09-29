"""
Unit tests for the pluggable git-forge adapter registry.

@testCovers fastapi_app/lib/core/git_forge_adapters.py
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.parse import urlencode

from fastapi_app.lib.core.git_forge_adapters import (
    BaseGitForgeAdapter,
    GitForgeAdapterRegistry,
    GitHubAdapter,
    GitLabAdapter,
)
from fastapi_app.lib.core.url_cache import UrlCache


class _AlwaysMatchesAdapter(BaseGitForgeAdapter):
    def matches(self, url: str) -> bool:
        return True

    def to_raw_url(self, url: str) -> str:
        return "raw:" + url

    def resolve_ref_to_sha(self, url: str, cache) -> str:
        return "sha:" + url

    def strip_ref(self, url: str) -> str:
        return "stripped:" + url

    def is_sha_pinned(self, url: str) -> bool:
        return False

    def build_propose_change_url(self, url: str, text: str, cache):
        return None


class _NeverMatchesAdapter(BaseGitForgeAdapter):
    def matches(self, url: str) -> bool:
        return False

    def to_raw_url(self, url: str) -> str:
        raise AssertionError("should not be called")

    def resolve_ref_to_sha(self, url: str, cache) -> str:
        raise AssertionError("should not be called")

    def strip_ref(self, url: str) -> str:
        raise AssertionError("should not be called")

    def is_sha_pinned(self, url: str) -> bool:
        raise AssertionError("should not be called")

    def build_propose_change_url(self, url: str, text: str, cache):
        raise AssertionError("should not be called")


class TestGitForgeAdapterRegistry(unittest.TestCase):
    def test_returns_none_when_no_adapter_registered(self):
        registry = GitForgeAdapterRegistry()
        self.assertIsNone(registry.get_adapter_for("https://example.com/x"))

    def test_returns_first_matching_adapter(self):
        registry = GitForgeAdapterRegistry()
        never = _NeverMatchesAdapter()
        always = _AlwaysMatchesAdapter()
        registry.register(never)
        registry.register(always)
        self.assertIs(registry.get_adapter_for("https://example.com/x"), always)

    def test_returns_none_when_nothing_matches(self):
        registry = GitForgeAdapterRegistry()
        registry.register(_NeverMatchesAdapter())
        self.assertIsNone(registry.get_adapter_for("https://example.com/x"))

    def test_get_instance_is_a_singleton(self):
        self.assertIs(GitForgeAdapterRegistry.get_instance(), GitForgeAdapterRegistry.get_instance())

    def test_get_instance_has_builtin_github_and_gitlab_adapters(self):
        adapter_types = [type(a) for a in GitForgeAdapterRegistry.get_instance()._adapters]
        self.assertIn(GitHubAdapter, adapter_types)
        self.assertIn(GitLabAdapter, adapter_types)


class TestGitForgeAdapterRegistryAllAdapters(unittest.TestCase):
    def test_all_adapters_returns_every_registered_adapter_in_order(self):
        registry = GitForgeAdapterRegistry()
        never = _NeverMatchesAdapter()
        always = _AlwaysMatchesAdapter()
        registry.register(never)
        registry.register(always)
        self.assertEqual(registry.all_adapters(), [never, always])


class TestGitHubAdapter(unittest.TestCase):
    def setUp(self):
        self.adapter = GitHubAdapter()

    def test_matches_github_blob_url(self):
        self.assertTrue(self.adapter.matches("https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"))

    def test_does_not_match_non_github_url(self):
        self.assertFalse(self.adapter.matches("https://gitlab.com/mpilhlt/fossil/-/blob/main/docs/guidelines.md"))

    def test_does_not_match_github_non_blob_url(self):
        self.assertFalse(self.adapter.matches("https://github.com/mpilhlt/fossil"))

    def test_to_raw_url(self):
        raw = self.adapter.to_raw_url("https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md")
        self.assertEqual(raw, "https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/guidelines.md")

    def test_resolve_ref_to_sha_returns_unchanged_when_already_a_sha(self):
        cache = MagicMock()
        sha = "a" * 40
        url = f"https://github.com/mpilhlt/fossil/blob/{sha}/docs/guidelines.md#L1-L5"
        self.assertEqual(self.adapter.resolve_ref_to_sha(url, cache), url)
        cache.get_text.assert_not_called()

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_resolve_ref_to_sha_resolves_branch_via_api(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_response = MagicMock()
        mock_response.json.return_value = {"sha": "b" * 40}
        mock_get.return_value = mock_response

        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#L1-L5"
        resolved = self.adapter.resolve_ref_to_sha(url, cache)

        mock_get.assert_called_once_with(
            "https://api.github.com/repos/mpilhlt/fossil/commits/main",
            timeout=10,
            headers={"Accept": "application/vnd.github+json"},
        )
        self.assertEqual(resolved, f"https://github.com/mpilhlt/fossil/blob/{'b' * 40}/docs/guidelines.md#L1-L5")
        cache.set_text.assert_called_once_with(
            "https://api.github.com/repos/mpilhlt/fossil/commits/main", "b" * 40
        )

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_resolve_ref_to_sha_uses_cache_when_available(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = "c" * 40

        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"
        resolved = self.adapter.resolve_ref_to_sha(url, cache)

        mock_get.assert_not_called()
        self.assertEqual(resolved, f"https://github.com/mpilhlt/fossil/blob/{'c' * 40}/docs/guidelines.md")


class TestGitLabAdapter(unittest.TestCase):
    def setUp(self):
        self.adapter = GitLabAdapter()

    def test_matches_gitlab_com_blob_url(self):
        self.assertTrue(self.adapter.matches("https://gitlab.com/group/project/-/blob/main/docs/guide.md"))

    def test_matches_self_hosted_gitlab_blob_url(self):
        self.assertTrue(self.adapter.matches("https://gitlab.example.org/group/sub/project/-/blob/main/docs/guide.md"))

    def test_does_not_match_github_url(self):
        self.assertFalse(self.adapter.matches("https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"))

    def test_to_raw_url(self):
        raw = self.adapter.to_raw_url("https://gitlab.com/group/project/-/blob/main/docs/guide.md")
        self.assertEqual(raw, "https://gitlab.com/group/project/-/raw/main/docs/guide.md")

    def test_to_raw_url_preserves_nested_group_path(self):
        raw = self.adapter.to_raw_url("https://gitlab.com/group/subgroup/project/-/blob/main/docs/guide.md")
        self.assertEqual(raw, "https://gitlab.com/group/subgroup/project/-/raw/main/docs/guide.md")

    def test_resolve_ref_to_sha_returns_unchanged_when_already_a_sha(self):
        cache = MagicMock()
        sha = "a" * 40
        url = f"https://gitlab.com/group/project/-/blob/{sha}/docs/guide.md#L1-5"
        self.assertEqual(self.adapter.resolve_ref_to_sha(url, cache), url)
        cache.get_text.assert_not_called()

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_resolve_ref_to_sha_resolves_branch_via_api(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_response = MagicMock()
        mock_response.json.return_value = {"id": "b" * 40}
        mock_get.return_value = mock_response

        url = "https://gitlab.com/group/project/-/blob/main/docs/guide.md#L1-5"
        resolved = self.adapter.resolve_ref_to_sha(url, cache)

        mock_get.assert_called_once_with(
            "https://gitlab.com/api/v4/projects/group%2Fproject/repository/commits/main",
            timeout=10,
        )
        self.assertEqual(resolved, f"https://gitlab.com/group/project/-/blob/{'b' * 40}/docs/guide.md#L1-5")
        cache.set_text.assert_called_once_with(
            "https://gitlab.com/api/v4/projects/group%2Fproject/repository/commits/main", "b" * 40
        )


class TestGitHubAdapterStripRef(unittest.TestCase):
    def setUp(self):
        self.adapter = GitHubAdapter()

    def test_sha_and_branch_urls_normalize_to_the_same_key(self):
        sha_url = "https://github.com/mpilhlt/pdf-tei-editor/blob/abc123def456/rules.md"
        branch_url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md"
        self.assertEqual(self.adapter.strip_ref(sha_url), self.adapter.strip_ref(branch_url))

    def test_strip_ref_keeps_owner_repo_and_path(self):
        url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/docs/rules.md"
        stripped = self.adapter.strip_ref(url)
        self.assertIn("mpilhlt/pdf-tei-editor", stripped)
        self.assertIn("docs/rules.md", stripped)
        self.assertNotIn("/main/", stripped)


class TestGitLabAdapterStripRef(unittest.TestCase):
    def setUp(self):
        self.adapter = GitLabAdapter()

    def test_sha_and_branch_urls_normalize_to_the_same_key(self):
        sha_url = "https://gitlab.com/group/project/-/blob/abc123/rules.md"
        branch_url = "https://gitlab.com/group/project/-/blob/main/rules.md"
        self.assertEqual(self.adapter.strip_ref(sha_url), self.adapter.strip_ref(branch_url))


class TestGitHubAdapterIsShaPinned(unittest.TestCase):
    def setUp(self):
        self.adapter = GitHubAdapter()

    def test_branch_ref_is_not_pinned(self):
        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"
        self.assertFalse(self.adapter.is_sha_pinned(url))

    def test_sha_ref_is_pinned(self):
        url = f"https://github.com/mpilhlt/fossil/blob/{'a' * 40}/docs/guidelines.md"
        self.assertTrue(self.adapter.is_sha_pinned(url))

    def test_fragment_is_ignored(self):
        url = f"https://github.com/mpilhlt/fossil/blob/{'a' * 40}/docs/guidelines.md#L1-L5"
        self.assertTrue(self.adapter.is_sha_pinned(url))


class TestGitLabAdapterIsShaPinned(unittest.TestCase):
    def setUp(self):
        self.adapter = GitLabAdapter()

    def test_branch_ref_is_not_pinned(self):
        url = "https://gitlab.com/group/project/-/blob/main/docs/guidelines.md"
        self.assertFalse(self.adapter.is_sha_pinned(url))

    def test_sha_ref_is_pinned(self):
        url = f"https://gitlab.com/group/project/-/blob/{'b' * 40}/docs/guidelines.md"
        self.assertTrue(self.adapter.is_sha_pinned(url))


class TestGitHubAdapterBuildProposeChangeUrl(unittest.TestCase):
    def setUp(self):
        self.adapter = GitHubAdapter()
        self.cache = MagicMock()

    def test_builds_prefilled_url_from_blob_url_with_branch_ref(self):
        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"
        target = self.adapter.build_propose_change_url(url, "new content", self.cache)
        expected_query = urlencode({"value": "new content"})
        self.assertEqual(target.url, f"https://github.com/mpilhlt/fossil/edit/main/docs/guidelines.md?{expected_query}")
        self.assertTrue(target.content_prefilled)
        self.cache.get_text.assert_not_called()

    def test_builds_prefilled_url_from_raw_url(self):
        url = "https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/guidelines.md"
        target = self.adapter.build_propose_change_url(url, "new content", self.cache)
        expected_query = urlencode({"value": "new content"})
        self.assertEqual(target.url, f"https://github.com/mpilhlt/fossil/edit/main/docs/guidelines.md?{expected_query}")
        self.assertTrue(target.content_prefilled)

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_resolves_sha_pinned_ref_to_default_branch_via_api(self, mock_get):
        self.cache.get_text.return_value = None
        mock_response = MagicMock()
        mock_response.json.return_value = {"default_branch": "main"}
        mock_get.return_value = mock_response

        url = f"https://github.com/mpilhlt/fossil/blob/{'a' * 40}/docs/guidelines.md"
        target = self.adapter.build_propose_change_url(url, "text", self.cache)

        mock_get.assert_called_once_with(
            "https://api.github.com/repos/mpilhlt/fossil",
            timeout=10,
            headers={"Accept": "application/vnd.github+json"},
        )
        self.assertIn("/edit/main/docs/guidelines.md?", target.url)
        self.cache.set_text.assert_called_once_with(
            "https://api.github.com/repos/mpilhlt/fossil/_default_branch", "main"
        )

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_uses_cached_default_branch(self, mock_get):
        self.cache.get_text.return_value = "develop"
        url = f"https://github.com/mpilhlt/fossil/blob/{'a' * 40}/docs/guidelines.md"
        target = self.adapter.build_propose_change_url(url, "text", self.cache)
        mock_get.assert_not_called()
        self.assertIn("/edit/develop/docs/guidelines.md?", target.url)

    def test_falls_back_to_unprefilled_when_url_too_long(self):
        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"
        huge_text = "x" * 8000
        target = self.adapter.build_propose_change_url(url, huge_text, self.cache)
        self.assertFalse(target.content_prefilled)
        self.assertEqual(target.url, "https://github.com/mpilhlt/fossil/edit/main/docs/guidelines.md")

    def test_returns_none_for_unrecognized_host(self):
        target = self.adapter.build_propose_change_url("https://example.com/docs/guidelines.md", "text", self.cache)
        self.assertIsNone(target)


class TestGitLabAdapterBuildProposeChangeUrl(unittest.TestCase):
    def setUp(self):
        self.adapter = GitLabAdapter()
        self.cache = MagicMock()

    def test_builds_edit_url_from_blob_url(self):
        url = "https://gitlab.com/group/project/-/blob/main/docs/guide.md"
        target = self.adapter.build_propose_change_url(url, "new content", self.cache)
        self.assertEqual(target.url, "https://gitlab.com/group/project/-/edit/main/docs/guide.md")
        self.assertFalse(target.content_prefilled)

    def test_builds_edit_url_from_raw_url(self):
        url = "https://gitlab.com/group/project/-/raw/main/docs/guide.md"
        target = self.adapter.build_propose_change_url(url, "new content", self.cache)
        self.assertEqual(target.url, "https://gitlab.com/group/project/-/edit/main/docs/guide.md")
        self.assertFalse(target.content_prefilled)

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_resolves_sha_pinned_ref_to_default_branch_via_api(self, mock_get):
        self.cache.get_text.return_value = None
        mock_response = MagicMock()
        mock_response.json.return_value = {"default_branch": "main"}
        mock_get.return_value = mock_response

        url = f"https://gitlab.com/group/project/-/blob/{'b' * 40}/docs/guide.md"
        target = self.adapter.build_propose_change_url(url, "text", self.cache)

        mock_get.assert_called_once_with("https://gitlab.com/api/v4/projects/group%2Fproject", timeout=10)
        self.assertEqual(target.url, "https://gitlab.com/group/project/-/edit/main/docs/guide.md")
        self.cache.set_text.assert_called_once_with(
            "https://gitlab.com/api/v4/projects/group%2Fproject/_default_branch", "main"
        )

    def test_returns_none_for_unrecognized_host(self):
        target = self.adapter.build_propose_change_url("https://example.com/docs/guide.md", "text", self.cache)
        self.assertIsNone(target)


class TestDefaultBranchCacheKeyDoesNotCollideWithCommitsCache(unittest.TestCase):
    """
    Regression test: a prior resolve_ref_to_sha() call caches its result under
    "{api_url}/commits/{ref}" (GitHub) or "{api_url}/repository/commits/{ref}"
    (GitLab), which makes cache_root/.../{repo} a directory. _default_branch()
    must not reuse that same path as its own cache file, or writing it raises
    IsADirectoryError.
    """

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_github(self, mock_get):
        with tempfile.TemporaryDirectory() as tmp:
            cache = UrlCache(Path(tmp))
            adapter = GitHubAdapter()

            commits_response = MagicMock()
            commits_response.json.return_value = {"sha": "a" * 40}
            mock_get.return_value = commits_response
            adapter.resolve_ref_to_sha(
                "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md", cache
            )

            branch_response = MagicMock()
            branch_response.json.return_value = {"default_branch": "main"}
            mock_get.return_value = branch_response
            target = adapter.build_propose_change_url(
                f"https://github.com/mpilhlt/fossil/blob/{'b' * 40}/docs/guidelines.md",
                "text",
                cache,
            )

            self.assertIn("/edit/main/docs/guidelines.md?", target.url)

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_gitlab(self, mock_get):
        with tempfile.TemporaryDirectory() as tmp:
            cache = UrlCache(Path(tmp))
            adapter = GitLabAdapter()

            commits_response = MagicMock()
            commits_response.json.return_value = {"id": "a" * 40}
            mock_get.return_value = commits_response
            adapter.resolve_ref_to_sha(
                "https://gitlab.com/group/project/-/blob/main/docs/guide.md", cache
            )

            branch_response = MagicMock()
            branch_response.json.return_value = {"default_branch": "main"}
            mock_get.return_value = branch_response
            target = adapter.build_propose_change_url(
                f"https://gitlab.com/group/project/-/blob/{'b' * 40}/docs/guide.md",
                "text",
                cache,
            )

            self.assertEqual(target.url, "https://gitlab.com/group/project/-/edit/main/docs/guide.md")
