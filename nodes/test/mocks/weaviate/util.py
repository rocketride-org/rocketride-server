"""
Mock Weaviate utility functions.
"""

import hashlib


def generate_uuid5(identifier: str) -> str:
    """Generate a deterministic UUID from an identifier."""
    return hashlib.md5(identifier.encode()).hexdigest()

