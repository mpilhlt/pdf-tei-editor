"""
Extraction of a JSON list of objects from an LLM response.

LLMs wrap JSON in markdown fences or prose, put unescaped quotes into strings that contain XML,
and get cut off at their output token limit. `extract_json_list` copes with all of these.
"""

import json
import logging
import re

logger = logging.getLogger(__name__)


class UnusableResponseError(Exception):
    """The LLM's response contained no JSON list of objects (empty, prose only, wrong shape)."""


def _salvage_truncated_list(raw_response: str) -> list[object]:
    """
    Recover the complete objects from a JSON array that was cut off mid-way (an LLM hitting its
    output token limit). Returns [] if the response has no array start or no complete object.
    """
    decoder = json.JSONDecoder(strict=False)
    for match in re.finditer(r"\[", raw_response):
        objects: list[object] = []
        index = match.end()
        while True:
            while index < len(raw_response) and raw_response[index] in " \t\r\n,":
                index += 1
            try:
                value, index = decoder.raw_decode(raw_response, index)
            except json.JSONDecodeError:
                break
            if not isinstance(value, dict):
                objects = []
                break
            objects.append(value)
        if objects:
            return objects
    return []


def _find_json_list(text: str) -> list[object] | None:
    """
    Try every "[" in text as the start of a JSON value and return the first one that decodes to
    a list of objects (or an empty list), or None. Raw control characters in strings (a literal
    newline) are accepted.
    """
    decoder = json.JSONDecoder(strict=False)
    for match in re.finditer(r"\[", text):
        try:
            value, _ = decoder.raw_decode(text, match.start())
        except json.JSONDecodeError:
            continue
        if isinstance(value, list) and all(isinstance(item, dict) for item in value):
            return value
    return None


def _quote_closes_string(text: str, index: int) -> bool:
    """
    Whether a '"' inside a JSON string, followed by text[index:], plausibly ends the string: it
    is followed by ":", "}", "]", the end of the text, or a "," that starts the next key or
    object. Anything else (`unit="issue">`, `the "supra" note`) is an unescaped quote that
    belongs to the string's content.
    """
    length = len(text)
    while index < length and text[index] in " \t\r\n":
        index += 1
    if index == length or text[index] in ":}]":
        return True
    if text[index] != ",":
        return False
    index += 1
    while index < length and text[index] in " \t\r\n":
        index += 1
    return index == length or text[index] in '"{]}'


def _repair_json_strings(text: str) -> str:
    """
    Repair the string-level JSON mistakes LLMs make when the content is XML: unescaped double
    quotes inside a string (`"old": "<biblScope unit="issue">"`) and invalid backslash escapes
    (`\\'`, `\\<`). Only the part from the first array of objects on is repaired, so quotes in
    prose before it cannot shift the string boundaries.
    """
    start_match = re.search(r"\[\s*\{", text)
    if start_match is None:
        return text
    start = start_match.start()
    out: list[str] = [text[:start]]
    in_string = False
    index = start
    length = len(text)
    while index < length:
        char = text[index]
        if not in_string:
            out.append(char)
            in_string = char == '"'
            index += 1
            continue
        if char == "\\":
            escaped = text[index + 1:index + 2]
            if escaped == "u" and re.fullmatch(r"[0-9a-fA-F]{4}", text[index + 2:index + 6]):
                out.append(text[index:index + 6])
                index += 6
            elif escaped and escaped in '"\\/bfnrt':
                out.append(char + escaped)
                index += 2
            else:
                out.append("\\\\")
                index += 1
            continue
        if char == '"':
            if _quote_closes_string(text, index + 1):
                in_string = False
                out.append(char)
            else:
                out.append('\\"')
            index += 1
            continue
        out.append(char)
        index += 1
    return "".join(out)


def extract_json_list(raw_response: str, log_prefix: str) -> list[object]:
    """
    Find the JSON array of objects in an LLM response. Models often wrap the array in a
    markdown fence or surround it with prose despite being told not to, so every "[" is tried
    as the start of a JSON value and the first one that decodes to a list of objects (or an
    empty list) wins. If none does, the response is retried after _repair_json_strings()
    (unescaped quotes in XML attribute values), and finally the complete objects of a
    truncated list are salvaged.

    Args:
        raw_response: The text returned by the model.
        log_prefix: Prefix of the log lines, e.g. the plugin id.

    Raises:
        UnusableResponseError: if the response contains no such array. The start of the
            response is logged, since it is the only way to tell why.
    """
    found = _find_json_list(raw_response)
    if found is not None:
        return found
    repaired = _repair_json_strings(raw_response)
    if repaired != raw_response:
        found = _find_json_list(repaired)
        if found is not None:
            logger.info(f"{log_prefix}: repaired unescaped quotes or invalid escapes in the LLM response")
            return found
    salvaged = _salvage_truncated_list(raw_response) or _salvage_truncated_list(repaired)
    if salvaged:
        logger.warning(
            f"{log_prefix}: LLM response looks truncated (length {len(raw_response)}, probably hit the "
            f"output token limit); using its {len(salvaged)} complete item(s)"
        )
        return salvaged
    snippet = raw_response.strip()[:300]
    logger.warning(
        f"{log_prefix}: no JSON list in LLM response "
        f"(length {len(raw_response)}), starts with: {snippet!r}"
    )
    raise UnusableResponseError(
        f"The model did not return a valid JSON list, and it could not be repaired (response starts with: {snippet[:120]!r})"
        if snippet else "The model returned an empty response"
    )
