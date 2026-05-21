# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""
Mock tiktoken for context_optimizer node tests.

When ROCKETRIDE_MOCK is set (or when the real tiktoken package is not installed
in the test environment), this module shadows the real tiktoken so token
counting runs without the native encoder download. ``cl100k_base`` is
approximated by whitespace splitting, which is deterministic and good enough
for the budget/truncation assertions the suite makes.
"""

from typing import List


class Encoding:
    """Approximates a tiktoken Encoding by splitting on whitespace."""

    def __init__(self, name: str = 'cl100k_base') -> None:
        self.name = name

    def encode(self, text: str) -> List[str]:
        if not text:
            return []
        return text.split()

    def decode(self, tokens: List[str]) -> str:
        return ' '.join(tokens)


def get_encoding(name: str = 'cl100k_base') -> Encoding:
    """Return a mock Encoding instance for the requested encoding name."""
    return Encoding(name)
