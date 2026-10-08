"""
Unit tests for the revision feed plugin's metadata and config registration.

@testCovers fastapi_app/plugins/revision_feed/plugin.py
"""

import os
import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.plugins.revision_feed.plugin import RevisionFeedPlugin


class TestRevisionFeedPlugin(unittest.TestCase):
    def test_metadata_has_required_fields(self):
        plugin = RevisionFeedPlugin()
        metadata = plugin.metadata

        self.assertEqual(metadata["id"], "revision-feed")
        self.assertEqual(metadata["required_roles"], ["user"])
        self.assertEqual(metadata["endpoints"], [])

    def test_get_endpoints_is_empty(self):
        plugin = RevisionFeedPlugin()
        self.assertEqual(plugin.get_endpoints(), {})

    @patch("fastapi_app.lib.utils.config_utils.get_config")
    def test_registers_default_included_statuses_from_lifecycle_order(self, mock_get_config):
        """RevisionFeedPlugin.__init__ does a LOCAL `from
        fastapi_app.lib.utils.config_utils import get_config` (both directly and inside
        get_plugin_config()), so patching that attribute on the source module - rather than
        on fastapi_app.plugins.revision_feed.plugin, which never imports get_config at module
        level - is what's actually read at call time. This keeps the test from reading or
        writing the real on-disk data/db/config.json (see the kisski plugin's
        test_plugin_llm_registration.py for the same pattern applied to a module-level import).
        """
        lifecycle_order = ["extraction", "draft", "review", "published"]
        mock_config = MagicMock()
        mock_config.get.side_effect = lambda key, *a, **kw: (
            lifecycle_order if key == "annotation.lifecycle.order" else None
        )
        mock_get_config.return_value = mock_config

        with patch.dict(os.environ):
            os.environ.pop("REVISION_FEED_INCLUDED_STATUSES", None)
            RevisionFeedPlugin()

        mock_config.set.assert_called_once_with(
            "plugin.revision-feed.included-statuses",
            ["draft", "review", "published"],
            allowed_values=None,
            description="Lifecycle statuses whose revisionDesc changes appear in the revision feed",
            masked=None,
        )


if __name__ == "__main__":
    unittest.main()
