"""
Unit tests for the GROBID training-data cache.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_cache.py -v

@testCovers fastapi_app/plugins/grobid/cache.py
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))


class CacheFlavorIsolationTestCase(unittest.TestCase):
    """Reproduces issue #480: the cache must not serve data cached under a
    different flavor for the same (doc_id, revision) pair, since flavors
    change the columns emitted by the GROBID feature files."""

    def setUp(self):
        self._cache_tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._cache_tmp.cleanup)
        cache_dir = Path(self._cache_tmp.name)

        patcher = mock.patch(
            "fastapi_app.plugins.grobid.cache.get_cache_dir",
            return_value=cache_dir,
        )
        patcher.start()
        self.addCleanup(patcher.stop)

        # Source directory whose content gets cached ("default" flavor extraction)
        self._src_tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._src_tmp.cleanup)
        src_dir = Path(self._src_tmp.name)
        (src_dir / "doc-1.training.segmentation").write_text("col1 col2\n")
        self.src_dir = src_dir

    def test_different_flavor_is_a_cache_miss(self):
        from fastapi_app.plugins.grobid.cache import cache_training_data, check_cache

        cache_training_data(
            "doc-1", "rev-1", "default", str(self.src_dir),
            ["doc-1.training.segmentation"],
        )

        # Same doc_id and revision, but a different flavor: must NOT reuse
        # the "default"-flavor cache entry, since its feature file lacks the
        # extra columns the other flavor's model emits.
        result = check_cache("doc-1", "rev-1", "article/footnotes-refs")
        self.assertIsNone(result)

    def test_same_flavor_is_a_cache_hit(self):
        from fastapi_app.plugins.grobid.cache import cache_training_data, check_cache

        cache_training_data(
            "doc-1", "rev-1", "default", str(self.src_dir),
            ["doc-1.training.segmentation"],
        )

        result = check_cache("doc-1", "rev-1", "default")
        self.assertIsNotNone(result)
        self.assertIn("doc-1.training.segmentation", result["files"])


if __name__ == "__main__":
    unittest.main()
