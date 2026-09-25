"""
Admin-configurable allow-list filter for LLM models.

Not owned by any single provider plugin - it applies uniformly across every
registered provider (see registry.py), filtered against the same
"<Provider label>/<Model label>" string the frontend's default-model picker
shows (app/src/plugins/inference-settings.js), letting an admin block
expensive/premium models or restrict usage to e.g. only "flash" models
without needing to know each provider's internal model ids.

Registered as a flat `llm.*` config key rather than `plugin.<name>.*` since
it isn't provider-specific - see docs/code-assistant/backend-plugins.md's
naming convention for plugin-owned keys, which this deliberately departs
from for that reason.
"""

import re

from fastapi_app.lib.plugins.plugin_tools import get_plugin_config
from fastapi_app.lib.utils.config_utils import get_config

MODEL_FILTER_CONFIG_KEY = "llm.model-filter"
MODEL_FILTER_ENV_VAR = "LLM_MODEL_FILTER"

_registered = False


def _ensure_registered() -> None:
    """
    Seed the config key (env var fallback + description metadata) exactly
    once per process. get_plugin_config() writes to config.json on every
    call (atomic write + file lock), so - like every other plugin config key
    in this codebase - it must be registered once, not re-invoked on every
    read; get_model_filter_patterns() reads the live value via get_config()
    afterwards, so a config.json edit still takes effect without a restart.
    """
    global _registered
    if not _registered:
        get_plugin_config(
            MODEL_FILTER_CONFIG_KEY,
            MODEL_FILTER_ENV_VAR,
            default="",
            description=(
                'Comma-separated, double-quoted regular expressions matched against '
                'each model\'s "<Provider>/<Model>" label (as shown in the frontend '
                'default-model picker). If non-empty, only models matching at least '
                'one pattern are listed or usable; empty means no filtering.'
            ),
        )
        _registered = True


def reset_registration() -> None:
    """Reset the one-time registration guard. For tests only."""
    global _registered
    _registered = False


def _parse_patterns(raw: str) -> list[re.Pattern[str]]:
    """Extract each double-quoted regex from a comma-separated, quoted list."""
    return [re.compile(pattern) for pattern in re.findall(r'"([^"]*)"', raw or "")]


def get_model_filter_patterns() -> list[re.Pattern[str]]:
    """The currently configured allow-list patterns (empty means no filtering)."""
    _ensure_registered()
    raw = get_config().get(MODEL_FILTER_CONFIG_KEY, "")
    return _parse_patterns(raw)


def is_model_allowed(label: str) -> bool:
    """
    True if `label` (a "<Provider>/<Model>" string) matches at least one
    configured allow-list pattern, or the allow-list is empty (no filtering
    configured). Matching is a substring search (`re.search`), not a full
    match, so a pattern like "flash" allows any label containing it.
    """
    patterns = get_model_filter_patterns()
    if not patterns:
        return True
    return any(pattern.search(label) for pattern in patterns)
