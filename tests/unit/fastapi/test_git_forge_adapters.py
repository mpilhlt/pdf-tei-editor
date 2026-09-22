"""
Unit tests for the pluggable git-forge adapter registry.

@testCovers fastapi_app/lib/core/git_forge_adapters.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.lib.core.git_forge_adapters import (
    BaseGitForgeAdapter,
    GitForgeAdapterRegistry,
    GitHubAdapter,
    GitLabAdapter,
)


class _AlwaysMatchesAdapter(BaseGitForgeAdapter):
    def matches(self, url: str) -> bool:
        return True

    def to_raw_url(self, url: str) -> str:
        return "raw:" + url

    def resolve_ref_to_sha(self, url: str, cache) -> str:
        return "sha:" + url


class _NeverMatchesAdapter(BaseGitForgeAdapter):
    def matches(self, url: str) -> bool:
        return False

    def to_raw_url(self, url: str) -> str:
        raise AssertionError("should not be called")

    def resolve_ref_to_sha(self, url: str, cache) -> str:
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
