"""
Minimal semantic version parsing and npm-style range matching.

Supported range syntax (as in npm's ``engines``): comparators ``>=1.2.3``, ``>``, ``<=``, ``<``, ``=``;
caret ``^1.2.3`` and tilde ``~1.2.3``; partial versions and x-ranges (``1``, ``1.2``, ``1.x``, ``*``);
hyphen ranges ``1.2.3 - 2.0.0``; space-separated comparators (AND) and ``||`` (OR).

Pre-release and build parts of a version are ignored when matching: ``0.75.0-devel.3`` is treated as ``0.75.0``.
"""

import re

Version = tuple[int, int, int]

_VERSION_RE = re.compile(r"^v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
_WILDCARDS = {"x", "X", "*"}


class SemverError(ValueError):
    """A version or range string is not valid."""


def parse_version(text: str) -> Version:
    """
    Parse a complete version like ``1.2.3`` or ``v1.2.3-beta.1+build`` (pre-release and build are dropped).

    Raises:
        SemverError: If the text is not a complete semantic version
    """
    parts = _parse_partial(text.strip())
    if None in parts:
        raise SemverError(f"Not a complete version: '{text}'")
    return parts[0] or 0, parts[1] or 0, parts[2] or 0


def _parse_partial(text: str) -> tuple[int | None, int | None, int | None]:
    """Parse ``1``, ``1.2``, ``1.2.3``, ``1.x`` or ``*`` into a tuple where wildcard/missing parts are None."""
    if text in ("", "*", "x", "X"):
        return None, None, None
    match = _VERSION_RE.match(text)
    if not match:
        raise SemverError(f"Invalid version: '{text}'")
    parts = [None if g is None or g in _WILDCARDS else int(g) for g in match.groups()]
    # a wildcard makes everything after it a wildcard
    for i, part in enumerate(parts):
        if part is None:
            parts[i:] = [None] * (3 - i)
            break
    return parts[0], parts[1], parts[2]


Comparator = tuple[str, Version]


def _desugar(op: str, text: str) -> list[Comparator]:
    """Turn ``op`` + a (possibly partial) version into primitive comparators."""
    major, minor, patch = _parse_partial(text)
    if major is None:
        return [(">=", (0, 0, 0))] if op in ("", "=", ">=", "^", "~") else [("<", (0, 0, 0))]
    low: Version = (major, minor or 0, patch or 0)
    if op == "^":
        if major > 0 or minor is None:
            high = (major + 1, 0, 0)
        elif minor > 0 or patch is None:
            high = (0, minor + 1, 0)
        else:
            high = (0, 0, (patch or 0) + 1)
        return [(">=", low), ("<", high)]
    if op == "~":
        high = (major + 1, 0, 0) if minor is None else (major, minor + 1, 0)
        return [(">=", low), ("<", high)]
    if op in ("", "="):
        if minor is None:
            return [(">=", low), ("<", (major + 1, 0, 0))]
        if patch is None:
            return [(">=", low), ("<", (major, minor + 1, 0))]
        return [("=", low)]
    if op == ">":
        if minor is None:
            return [(">=", (major + 1, 0, 0))]
        if patch is None:
            return [(">=", (major, minor + 1, 0))]
        return [(">", low)]
    if op == "<=":
        if minor is None:
            return [("<", (major + 1, 0, 0))]
        if patch is None:
            return [("<", (major, minor + 1, 0))]
        return [("<=", low)]
    return [(op, low)]  # >= and <


_COMPARATOR_RE = re.compile(r"^(>=|<=|>|<|=|\^|~)?\s*(\S+)$")


def _parse_set(text: str) -> list[Comparator]:
    """Parse a set of space-separated comparators (all must match) or a hyphen range."""
    text = re.sub(r"(>=|<=|>|<|=|\^|~)\s+", r"\1", text.strip())
    hyphen = re.match(r"^(\S+)\s+-\s+(\S+)$", text)
    if hyphen:
        low = _parse_partial(hyphen.group(1))
        comparators = _desugar(">=", hyphen.group(1)) if low[0] is not None else []
        return comparators + _desugar("<=", hyphen.group(2))
    comparators: list[Comparator] = []
    for token in text.split():
        match = _COMPARATOR_RE.match(token)
        if not match:
            raise SemverError(f"Invalid comparator: '{token}'")
        comparators += _desugar(match.group(1) or "", match.group(2))
    return comparators or [(">=", (0, 0, 0))]


def validate_range(range_text: str) -> None:
    """
    Check that a range string can be parsed.

    Raises:
        SemverError: If the range is invalid
    """
    for part in range_text.split("||"):
        _parse_set(part)


def satisfies(version: str | Version, range_text: str) -> bool:
    """
    Whether a version satisfies an npm-style range.

    Args:
        version: Version string or (major, minor, patch)
        range_text: Range such as ``>=0.75.0 <1.0.0``, ``^0.75``, ``1.x || 2.x``

    Raises:
        SemverError: If the version or the range is invalid
    """
    v = parse_version(version) if isinstance(version, str) else version
    for part in range_text.split("||"):
        if all(_compare(v, op, ref) for op, ref in _parse_set(part)):
            return True
    return False


def _compare(v: Version, op: str, ref: Version) -> bool:
    return {
        "=": v == ref, ">=": v >= ref, ">": v > ref, "<=": v <= ref, "<": v < ref,
    }[op]
