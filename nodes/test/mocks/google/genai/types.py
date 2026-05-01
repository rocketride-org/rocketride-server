# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Mock google.genai.types for accessibility_describe node testing.
=================================================================

Provides stub implementations of Part and Content used to build
multimodal requests (image + text) without calling the real API.

API surface mocked:
    Part.from_bytes(data=..., mime_type=...)  ->  Part
    Part.from_text(text=...)                  ->  Part
    Content(role=..., parts=[...])            ->  Content
"""


class Part:
    """
    Mock google.genai.types.Part.

    Represents a single part of a multimodal message (image bytes or text).
    The real Part serialises content for the API wire format; the mock
    just holds the values so the node code can construct it without errors.
    """

    def __init__(self, data=None, mime_type=None, text=None):
        """
        Initialize the mock Part.

        Args:
            data: Raw bytes (e.g. an image) (ignored)
            mime_type: MIME type of the data (ignored)
            text: Plain text string (ignored)
        """
        self.data = data
        self.mime_type = mime_type
        self.text = text

    @classmethod
    def from_bytes(cls, data: bytes, mime_type: str) -> 'Part':
        """Create a Part from raw bytes (e.g. an image)."""
        return cls(data=data, mime_type=mime_type)

    @classmethod
    def from_text(cls, text: str) -> 'Part':
        """Create a Part from a plain text string."""
        return cls(text=text)


class Content:
    """
    Mock google.genai.types.Content.

    Represents a single turn in a conversation (role + list of Parts).
    """

    def __init__(self, role: str = None, parts=None):
        """
        Initialize the mock Content.

        Args:
            role: The role of the content (ignored)
            parts: List of Parts (ignored)
        """
        self.role = role
        self.parts = parts or []
