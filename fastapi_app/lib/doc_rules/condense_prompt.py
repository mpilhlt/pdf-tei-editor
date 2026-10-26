"""
Prompt used to condense a human annotation guide section into its machine
layer. Extractor plugins may override it per guide through the optional
DocumentRulesProvider.get_condense_prompt() hook.
"""

from fastapi_app.lib.doc_rules.rules_providers import get_document_rules_provider_for_document

DEFAULT_CONDENSE_PROMPT = "You maintain a condensed version of annotation guidelines for language models. Write terse rules and tables; no rationale, no links, few and short examples. Keep every rule, element and attribute value. Write attribute values out one by one (`@type` is one of `court`, `legislature`), never as `type=\"a|b\"`, which a model may copy literally. Keep the section heading exactly as it is."


def resolve_condense_prompt(xml_string: str, guide_url: str) -> str:
    """
    The condensing prompt for a guide: the prompt the document's extractor
    provider returns for guide_url, else DEFAULT_CONDENSE_PROMPT. Providers
    without get_condense_prompt (older plugins) get the default.
    """
    resolved = get_document_rules_provider_for_document(xml_string)
    if resolved is not None:
        _variant_id, provider = resolved
        getter = getattr(provider, "get_condense_prompt", None)
        if getter is not None:
            prompt = getter(guide_url)
            if prompt:
                return prompt
    return DEFAULT_CONDENSE_PROMPT
