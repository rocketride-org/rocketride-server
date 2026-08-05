# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Mock for the `landingai_ade` SDK used by the Landing.ai Parse/Extract nodes.

Shadows the real package (via ROCKETRIDE_MOCK on sys.path) so node tests run
without network access or an ADE API key. Returns deterministic response objects
shaped like the real ParseResponse / ExtractResponse (attribute access, not dicts,
because the node reads `.markdown`, `.chunks[].type`, `.extraction`, etc.).
"""

from typing import Any, Dict, Optional


class _Meta:
    """Stub of ParseMetadata / ExtractMetadata."""

    def __init__(self, credit_usage: int = 1, failed_pages: Optional[list] = None, warnings: Optional[list] = None):
        self.credit_usage = credit_usage
        self.failed_pages = failed_pages or []
        self.warnings = warnings or []


class _Chunk:
    """Stub of a parsed chunk."""

    def __init__(self, type: str, markdown: str):
        self.id = f'chunk-{type}'
        self.type = type
        self.markdown = markdown
        self.grounding = None


class _ParseResponse:
    """Stub of landingai_ade ParseResponse."""

    def __init__(self):
        self.markdown = '# Mock Document\n\nHello world.'
        self.chunks = [
            _Chunk('text', 'Hello world.'),
            _Chunk('table', '| a | b |\n| --- | --- |\n| 1 | 2 |'),
        ]
        self.metadata = _Meta(credit_usage=1, failed_pages=[])
        self.splits = []
        self.grounding = None


class _ExtractResponse:
    """Stub of landingai_ade ExtractResponse."""

    def __init__(self):
        self.extraction = {'summary': 'mock-extraction'}
        self.extraction_metadata = {}
        self.metadata = _Meta(credit_usage=1, warnings=[])


class LandingAIADE:
    """Mock ADE client. Records the last call for assertions."""

    last_parse_kwargs: Dict[str, Any] = {}
    last_extract_kwargs: Dict[str, Any] = {}

    def __init__(self, apikey: Optional[str] = None, environment: Optional[str] = None, **kwargs):
        self.apikey = apikey
        self.environment = environment

    def parse(self, document: Any = None, model: Optional[str] = None, **kwargs) -> _ParseResponse:
        LandingAIADE.last_parse_kwargs = {'document': document, 'model': model, **kwargs}
        return _ParseResponse()

    def extract(
        self, markdown: Any = None, schema: Any = None, strict: Optional[bool] = None, **kwargs
    ) -> _ExtractResponse:
        # The real SDK signature is `schema: str` — a dict gets flattened into
        # multipart `schema[...]` keys and the API rejects it with 422. Enforce
        # the contract here so tests catch a regression to passing a dict.
        if not isinstance(schema, str):
            raise TypeError(f'extract(schema=...) must be a JSON string, got {type(schema).__name__}')
        LandingAIADE.last_extract_kwargs = {'markdown': markdown, 'schema': schema, 'strict': strict, **kwargs}
        return _ExtractResponse()


class AsyncLandingAIADE(LandingAIADE):
    """Mock async client (same surface as the sync mock for test purposes)."""

    pass


__all__ = ['LandingAIADE', 'AsyncLandingAIADE']
