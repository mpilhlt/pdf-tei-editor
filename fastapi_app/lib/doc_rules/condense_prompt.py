"""
Prompt used to condense a human annotation guide section into its machine
layer. Extractor plugins may override it per guide through the optional
DocumentRulesProvider.get_condense_prompt() hook.
"""

import logging

from fastapi_app.lib.doc_rules.rules_providers import get_document_rules_provider_for_document

logger = logging.getLogger(__name__)

DEFAULT_CONDENSE_PROMPT = "You maintain a condensed version of annotation guidelines for language models. Write terse rules and tables; no rationale, no links, few and short examples. Keep every rule, element and attribute value. Write attribute values out one by one (`@type` is one of `court`, `legislature`), never as `type=\"a|b\"`, which a model may copy literally. Keep the section heading exactly as it is."


def resolve_condense_prompt(xml_string: str, guide_url: str) -> str:
    """
    The condensing prompt for a guide: the prompt the document's extractor
    provider returns for guide_url, else DEFAULT_CONDENSE_PROMPT. Providers
    without a callable get_condense_prompt (older plugins) get the default,
    as does a provider returning None or "". A non-string return is logged
    and ignored. Exceptions raised by the provider propagate.
    """
    resolved = get_document_rules_provider_for_document(xml_string)
    if resolved is None:
        return DEFAULT_CONDENSE_PROMPT
    _variant_id, provider = resolved
    getter = getattr(provider, "get_condense_prompt", None)
    if not callable(getter):
        return DEFAULT_CONDENSE_PROMPT
    prompt = getter(guide_url)
    if prompt and not isinstance(prompt, str):
        logger.warning(f"Ignoring non-string condense prompt ({type(prompt).__name__}) for {guide_url}")
        return DEFAULT_CONDENSE_PROMPT
    return prompt or DEFAULT_CONDENSE_PROMPT
