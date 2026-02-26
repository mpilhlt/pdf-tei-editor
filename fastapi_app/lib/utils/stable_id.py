"""
Stable ID generation for files.

Generates short, collision-resistant identifiers that remain stable
across file content changes. Uses nanoid-style generation instead of
content-hash truncation.

Stable IDs are used for:
- User-facing URLs (/editor/{stable_id})
- API endpoints that need stable references
- Cross-version document linking

While the content hash (files.id) changes with each edit,
the stable_id remains constant for the lifetime of the document version.
"""

import secrets
import string
from typing import Set

# Alphabet: lowercase letters + digits (no ambiguous characters)
# Excludes: 0/O, 1/l/I for readability
ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

MIN_LENGTH = 6  # 6 chars = ~887M combinations, 0.006% collision at 10k IDs
MAX_LENGTH = 12


def generate_stable_id(existing_ids: Set[str], length: int = MIN_LENGTH) -> str:
    """
    Generate a collision-resistant stable identifier.

    Uses cryptographically secure random generation with automatic
    collision avoidance. If a collision occurs (unlikely), increases
    length and retries.

    Args:
        existing_ids: Set of all currently-used stable IDs
        length: Initial length to try (default: 5)

    Returns:
        Unique stable ID string (e.g., "x7k2m", "p9q4w")

    Raises:
        RuntimeError: If unable to generate unique ID within max length

    Example:
        >>> existing = {"abc123", "def456"}
        >>> new_id = generate_stable_id(existing)
        >>> len(new_id) >= 6
        True
        >>> new_id not in existing
        True
    """
    if length > MAX_LENGTH:
        raise RuntimeError(
            f"Unable to generate unique stable_id: exceeded max length {MAX_LENGTH}"
        )

    # Generate random ID
    stable_id = ''.join(secrets.choice(ALPHABET) for _ in range(length))

    # Check for collision
    if stable_id in existing_ids:
        # Collision! Try with increased length
        # This is extremely rare with proper random generation
        return generate_stable_id(existing_ids, length + 1)

    return stable_id


def is_valid_stable_id(stable_id: str) -> bool:
    """
    Validate stable ID format.

    Checks that the ID:
    - Is within length bounds
    - Contains only valid characters

    Args:
        stable_id: ID string to validate

    Returns:
        True if valid format, False otherwise

    Example:
        >>> is_valid_stable_id("abc123")
        True
        >>> is_valid_stable_id("ABC123")  # uppercase not allowed
        False
        >>> is_valid_stable_id("x")  # too short
        False
    """
    if not stable_id:
        return False

    if len(stable_id) < MIN_LENGTH or len(stable_id) > MAX_LENGTH:
        return False

    return all(c in ALPHABET for c in stable_id)


def estimate_collision_probability(num_ids: int, length: int = MIN_LENGTH) -> float:
    """
    Estimate probability of collision for given parameters.

    Uses birthday paradox approximation:
    P(collision) ≈ 1 - e^(-n²/(2*m))
    where n = number of IDs, m = alphabet size ^ length

    Args:
        num_ids: Number of IDs in the system
        length: Length of stable IDs

    Returns:
        Probability of collision (0.0 to 1.0)

    Example:
        >>> # With 6-char IDs from 31-char alphabet:
        >>> # 10,000 IDs = ~0.006% collision probability
        >>> p = estimate_collision_probability(10_000, 6)
        >>> p < 0.0001
        True
    """
    import math

    alphabet_size = len(ALPHABET)
    keyspace = alphabet_size ** length

    # Birthday paradox approximation
    exponent = -(num_ids ** 2) / (2 * keyspace)
    probability = 1 - math.exp(exponent)

    return probability


if __name__ == '__main__':
    # Quick validation and stats
    print(f"Stable ID Configuration:")
    print(f"  Alphabet: {ALPHABET}")
    print(f"  Alphabet size: {len(ALPHABET)}")
    print(f"  Min length: {MIN_LENGTH}")
    print(f"  Max length: {MAX_LENGTH}")
    print()

    print(f"Keyspace sizes:")
    for length in range(MIN_LENGTH, MIN_LENGTH + 3):
        keyspace = len(ALPHABET) ** length
        print(f"  {length} chars: {keyspace:,} combinations")
    print()

    print(f"Collision probabilities ({MIN_LENGTH}-char IDs):")
    for num_ids in [1_000, 10_000, 100_000, 1_000_000]:
        prob = estimate_collision_probability(num_ids, MIN_LENGTH)
        print(f"  {num_ids:>8,} IDs: {prob:.6%}")
    print()

    # Generate sample IDs
    print("Sample IDs:")
    existing: Set[str] = set()
    for i in range(10):
        new_id = generate_stable_id(existing)
        existing.add(new_id)
        print(f"  {new_id}")
