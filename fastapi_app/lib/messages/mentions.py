"""
`@`-mentions in comment texts, with the same token rule as `app/src/modules/mentions.js`.

A token counts as a mention only if its id is a person of the document's `respStmt` (or the
document owner) and a user account; other tokens, such as e-mail addresses or `@type`, are text.
"""

import re

MENTION_PATTERN = r"(?<![\w.@])@([A-Za-z0-9_](?:[\w.-]*\w)?)"

# ASCII, so that `\w` means the same as in JavaScript
_MENTION_RE = re.compile(MENTION_PATTERN, re.ASCII)


def find_mentions(text: str, known: set[str] | None = None) -> list[str]:
    """
    Ids of the mention tokens in a text, in order of first occurrence.

    Args:
        text: Comment text
        known: If given, only these ids count as mentions

    Returns:
        The mentioned ids, without duplicates
    """
    ids: list[str] = []
    for match in _MENTION_RE.finditer(text):
        mention_id = match.group(1)
        if (known is None or mention_id in known) and mention_id not in ids:
            ids.append(mention_id)
    return ids


def mentionable_ids(resp_person_ids: set[str], owner: str | None, usernames: set[str]) -> set[str]:
    """
    Ids that can be mentioned in a document: its respStmt persons and its owner, if they are users.

    Args:
        resp_person_ids: Ids of the document's respStmt persons
        owner: The document owner (`created_by`), if any
        usernames: All user names

    Returns:
        The mentionable user names
    """
    candidates = set(resp_person_ids)
    if owner:
        candidates.add(owner)
    return candidates & usernames
