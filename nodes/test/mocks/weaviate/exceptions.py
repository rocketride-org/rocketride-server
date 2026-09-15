# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Mock of weaviate.exceptions for testing.

Mirrors the real hierarchy, not just the classes: every weaviate error derives
from WeaviateBaseError, so a handler that catches the base has to catch the
connection and timeout errors here too.
"""


class WeaviateBaseError(Exception):
    """Mirrors weaviate.exceptions.WeaviateBaseError."""


class UnexpectedStatusCodeError(WeaviateBaseError):
    """Mirrors weaviate.exceptions.UnexpectedStatusCodeError."""

    def __init__(self, message: str = '', response=None):
        super().__init__(message)
        self.status_code = getattr(response, 'status_code', None)


class WeaviateConnectionError(WeaviateBaseError):
    """Mirrors weaviate.exceptions.WeaviateConnectionError."""


class WeaviateTimeoutError(WeaviateBaseError):
    """Mirrors weaviate.exceptions.WeaviateTimeoutError."""
