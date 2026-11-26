"""
One LLM review call with a single feedback retry when every result was dropped.
"""

import logging
from collections.abc import Callable
from typing import TypeVar

from .base import LLMProvider
from .json_response import UnusableResponseError

logger = logging.getLogger(__name__)

T = TypeVar("T")


async def complete_with_retry(
    provider: LLMProvider,
    model_id: str,
    system_prompt: str,
    user_prompt: str,
    parse: Callable[[str], tuple[list[T], list[str]]],
    retry_note: Callable[[list[str]], str],
    log_prefix: str,
) -> tuple[list[T], list[str]]:
    """
    Call the model and parse the response. If everything it returned was dropped (nothing kept,
    something dropped), call it once more with `retry_note(dropped)` appended to the user prompt.

    Args:
        provider: The LLM provider.
        model_id: The model to use.
        system_prompt: The system prompt.
        user_prompt: The user prompt.
        parse: Turns a response into `(kept, dropped)`; raises UnusableResponseError if the
            response has no usable result at all.
        retry_note: Builds the feedback appended to the user prompt from the dropped items.
        log_prefix: Prefix of the log lines.

    Returns:
        `(kept, dropped)` of the last usable response.

    Raises:
        UnusableResponseError: if the first response is unusable. An unusable retry keeps the
            first result.
    """
    raw_response = await provider.chat_completion(model_id, system_prompt, user_prompt)
    kept, dropped = parse(raw_response)
    if not kept and dropped:
        logger.info(f"{log_prefix}: all {len(dropped)} result(s) dropped, retrying once with feedback")
        retry_response = await provider.chat_completion(model_id, system_prompt, user_prompt + retry_note(dropped))
        try:
            kept, dropped = parse(retry_response)
        except UnusableResponseError:
            logger.warning(f"{log_prefix}: retry returned no usable JSON list, keeping the first attempt's result")
    return kept, dropped
