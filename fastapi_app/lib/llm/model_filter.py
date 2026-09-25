"""
Admin-configurable include/exclude filter for LLM models.

Not owned by any single provider plugin - it applies uniformly across every
registered provider (see registry.py), filtered against the same
"<Provider label>/<Model label>" string the frontend's default-model picker
shows (app/src/plugins/inference-settings.js), letting an admin block
expensive/premium models or restrict usage to e.g. only "flash" models
without needing to know each provider's internal model ids.

Registered as flat `llm.*` config keys rather than `plugin.<name>.*` since
it isn't provider-specific - see docs/code-assistant/backend-plugins.md's
naming convention for plugin-owned keys, which this deliberately departs
from for that reason.
"""

import re

from fastapi_app.lib.plugins.plugin_tools import get_plugin_config
from fastapi_app.lib.utils.config_utils import get_config

INCLUDE_CONFIG_KEY = "llm.model-filter.include"
EXCLUDE_CONFIG_KEY = "llm.model-filter.exclude"
INCLUDE_ENV_VAR = "LLM_MODEL_FILTER_INCLUDE"
EXCLUDE_ENV_VAR = "LLM_MODEL_FILTER_EXCLUDE"

_PATTERN_SYNTAX = (
    'Comma-separated, double-quoted regular expressions matched (substring search) against '
    'each model\'s "<Provider>/<Model>" label (as shown in the frontend default-model picker). '
)

_registered = False


def _ensure_registered() -> None:
    """
    Seed the config keys (env var fallback + description metadata) exactly
    once per process. get_plugin_config() writes to config.json on every
    call (atomic write + file lock), so - like every other plugin config key
    in this codebase - it must be registered once, not re-invoked on every
    read; the getters read the live value via get_config() afterwards, so a
    config.json edit still takes effect without a restart.
    """
    global _registered
    if not _registered:
        get_plugin_config(
            INCLUDE_CONFIG_KEY,
            INCLUDE_ENV_VAR,
            default="",
            description=_PATTERN_SYNTAX + "If non-empty, only models matching at least one pattern are listed or usable; empty means no include filtering.",
        )
        get_plugin_config(
            EXCLUDE_CONFIG_KEY,
            EXCLUDE_ENV_VAR,
            default="",
            description=_PATTERN_SYNTAX + "Models matching at least one pattern are neither listed nor usable, even if they match an include pattern; empty means nothing is excluded.",
        )
        _registered = True


def reset_registration() -> None:
    """Reset the one-time registration guard. For tests only."""
    global _registered
    _registered = False


def _parse_patterns(raw: str) -> list[re.Pattern[str]]:
    """
    Extract each double-quoted regex from a comma-separated, quoted list. A
    non-empty value without any double quotes is taken as one single pattern,
    so a plain `[Ff]lash` does not silently disable the filter.
    """
    raw = (raw or "").strip()
    quoted = re.findall(r'"([^"]*)"', raw)
    patterns = quoted if quoted else ([raw] if raw else [])
    return [re.compile(pattern) for pattern in patterns]


def get_include_patterns() -> list[re.Pattern[str]]:
    """The currently configured include patterns (empty means no include filtering)."""
    _ensure_registered()
    return _parse_patterns(get_config().get(INCLUDE_CONFIG_KEY, ""))


def get_exclude_patterns() -> list[re.Pattern[str]]:
    """The currently configured exclude patterns (empty means nothing is excluded)."""
    _ensure_registered()
    return _parse_patterns(get_config().get(EXCLUDE_CONFIG_KEY, ""))


def has_model_filter() -> bool:
    """True if any include or exclude pattern is configured."""
    return bool(get_include_patterns() or get_exclude_patterns())


def is_model_allowed(label: str) -> bool:
    """
    True if `label` (a "<Provider>/<Model>" string) matches no exclude
    pattern and - if include patterns are configured - at least one include
    pattern. Matching is a substring search (`re.search`), not a full match,
    so a pattern like "flash" matches any label containing it.
    """
    if any(pattern.search(label) for pattern in get_exclude_patterns()):
        return False
    include = get_include_patterns()
    return not include or any(pattern.search(label) for pattern in include)
