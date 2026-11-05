# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Mock astrapy.exceptions Module
==============================

The exceptions the Astra DB driver handles.
"""


class DataAPIException(Exception):
    """Base of the Data API errors (``astrapy.exceptions.DataAPIException``)."""


class TooManyDocumentsToCountException(DataAPIException):
    """``count_documents`` matched more documents than its ``upper_bound`` (or the server's cap)."""

    def __init__(self, text: str, *, server_max_count_exceeded: bool) -> None:
        super().__init__(text)
        self.text = text
        self.server_max_count_exceeded = server_max_count_exceeded


class DataAPIResponseException(DataAPIException):
    """The Data API answered a command with an error (``error_code`` names it)."""

    def __init__(self, text: str, *, error_code: str) -> None:
        super().__init__(text)
        self.text = text
        self.error_code = error_code


__all__ = ['DataAPIException', 'DataAPIResponseException', 'TooManyDocumentsToCountException']
