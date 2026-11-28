"""
One LLM review call with a single feedback retry when every result was dropped.
"""

import logging
from collections.abc import Callable
from typing import TypeVar

from .base import LLMImage, LLMProvider
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
    images: list[LLMImage] | None = None,
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
        images: Images attached to the user prompt of both calls (see
            LLMProvider.chat_completion_with_images()); None or empty: text only.

    Returns:
        `(kept, dropped)` of the last usable response.

    Raises:
        UnusableResponseError: if the first response is unusable. An unusable retry keeps the
            first result.
    """
    async def complete(prompt: str) -> str:
        if images:
            return await provider.chat_completion_with_images(model_id, system_prompt, prompt, images)
        return await provider.chat_completion(model_id, system_prompt, prompt)

    raw_response = await complete(user_prompt)
    kept, dropped = parse(raw_response)
    if not kept and dropped:
        logger.info(f"{log_prefix}: all {len(dropped)} result(s) dropped, retrying once with feedback")
        retry_response = await complete(user_prompt + retry_note(dropped))
        try:
            kept, dropped = parse(retry_response)
        except UnusableResponseError:
            logger.warning(f"{log_prefix}: retry returned no usable JSON list, keeping the first attempt's result")
    return kept, dropped
