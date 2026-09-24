"""
KISSKI LLM provider connector.

Registers Kisski's chat/completions endpoint into the core LLM provider
registry (fastapi_app/lib/llm/), in addition to (not instead of) its
existing ExtractorRegistry/ServiceRegistry registrations in plugin.py.

Adds live per-model demand/busy status on top of the generic
OpenAICompatibleProvider - Kisski's /models response includes a `demand`
integer per entry, which this module classifies into the shared 3-tier
ModelStatus.availability vocabulary. This classification (thresholds
0 / 1-5 / 6+) matches the sibling zotero-rag project's
backend/utils/kisski.py, reused here as the canonical thresholds rather
than inventing new ones.
"""

from typing import Literal

from fastapi_app.lib.extraction.http_utils import get_retry_session
from fastapi_app.lib.llm.base import LLMModel, ModelStatus
from fastapi_app.lib.llm.openai_compatible import OpenAICompatibleProvider


def _demand_to_availability(demand: int) -> Literal["available", "busy", "very_busy"]:
    if demand == 0:
        return "available"
    if demand <= 5:
        return "busy"
    return "very_busy"


class KisskiLLMProvider(OpenAICompatibleProvider):
    """LLM provider connector for KISSKI Academic Cloud, with live demand status."""

    def list_models(self) -> list[LLMModel]:
        session = get_retry_session(retries=3, backoff_factor=1.0)
        url = f"{self._base_url}/models"
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        response = session.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        entries = response.json().get("data", [])
        models: list[LLMModel] = []
        for entry in entries:
            if "id" not in entry:
                continue
            try:
                demand = int(entry.get("demand", 0) or 0)
            except (TypeError, ValueError):
                demand = 0
            status = ModelStatus(availability=_demand_to_availability(demand), detail=f"demand: {demand}")
            models.append(
                LLMModel(
                    id=entry["id"],
                    label=entry.get("name", entry["id"]),
                    capabilities=frozenset({"chat"}),
                    status=status,
                )
            )
        return models
