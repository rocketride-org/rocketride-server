# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Count-limit error exposed by the Astra SDK, for protocol-mocked tests."""


class TooManyDocumentsToCountException(Exception):
    """The count exceeded the caller's bound or the server's counting limit."""

    def __init__(self, text: str, *, server_max_count_exceeded: bool) -> None:
        super().__init__(text)
        self.text = text
        self.server_max_count_exceeded = server_max_count_exceeded
