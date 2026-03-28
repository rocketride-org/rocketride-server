"""
Qdrant tool-provider driver.

Exposes a `qdrant.search` tool that performs full-text keyword search against
the configured Qdrant collection, returning matching documents with their
content and timestamps.
"""

from __future__ import annotations

from typing import Any, Dict, List

from rocketlib import warning

from ai.common.tools import ToolsBase

# ---------------------------------------------------------------------------
# Static tool definition
# ---------------------------------------------------------------------------

SEARCH_TOOL = {
    'name': 'search',
    'description': ('Search for documents in the Qdrant vector store using full-text keyword matching. Returns matching documents with their content, chunk ID, and timestamp.'),
    'inputSchema': {
        'type': 'object',
        'properties': {
            'query': {
                'type': 'string',
                'description': 'Text to search for in the stored documents.',
            },
            'limit': {
                'type': 'integer',
                'description': 'Maximum number of results to return (default: 10).',
                'default': 10,
            },
        },
        'required': ['query'],
    },
    'outputSchema': {
        'type': 'array',
        'items': {
            'type': 'object',
            'properties': {
                'content': {'type': 'string'},
                'chunk_id': {'type': 'integer'},
                'time_stamp': {'type': 'number'},
            },
        },
    },
}

_SERVER_NAME = 'qdrant'


class QdrantDriver(ToolsBase):
    """Tool provider for Qdrant keyword search."""

    def __init__(self, *, instance: Any) -> None:
        """Initialize the driver with a reference to the IInstance."""
        self._instance = instance

    @property
    def _store(self) -> Any:
        return self._instance.IGlobal.store

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[ToolsBase.ToolDescriptor]:
        collection_desc = getattr(self._instance.IGlobal, 'collection_description', '') or ''
        desc_prefix = f'{collection_desc} ' if collection_desc else ''
        tool = {
            **SEARCH_TOOL,
            'name': f'{_SERVER_NAME}.{SEARCH_TOOL["name"]}',
            'description': f'{desc_prefix}{SEARCH_TOOL["description"]}',
        }
        return [tool]

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:
        args = _normalize_input(input_obj)
        if not args.get('query'):
            raise ValueError('qdrant.search requires a non-empty "query" string')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:
        from qdrant_client import models

        args = _normalize_input(input_obj)
        query = str(args.get('query', '')).strip()
        limit = int(args.get('limit', 10))

        if not query:
            raise ValueError('qdrant.search requires a non-empty "query" string')

        store = self._store
        if store is None:
            raise RuntimeError('qdrant.search: store not initialized')

        results, _ = store.client.scroll(
            collection_name=store.collection,
            scroll_filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key='content',
                        match=models.MatchText(text=query),
                    ),
                    models.FieldCondition(
                        key='meta.isDeleted',
                        match=models.MatchValue(value=False),
                    ),
                ]
            ),
            limit=limit,
            with_payload=True,
            with_vectors=False,
        )

        out = []
        for point in results:
            payload = point.payload or {}
            meta = payload.get('meta', {}) or {}
            out.append(
                {
                    'content': payload.get('content', ''),
                    'chunk_id': meta.get('chunkId', 0),
                    'time_stamp': meta.get('time_stamp', 0),
                }
            )
        return out


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalize_input(input_obj: Any) -> Dict[str, Any]:
    """Normalize tool input into a plain dict."""
    if input_obj is None:
        return {}

    if hasattr(input_obj, 'model_dump') and callable(getattr(input_obj, 'model_dump')):
        input_obj = input_obj.model_dump()
    elif hasattr(input_obj, 'dict') and callable(getattr(input_obj, 'dict')):
        input_obj = input_obj.dict()

    if isinstance(input_obj, str):
        try:
            import json as _json

            parsed = _json.loads(input_obj)
            if isinstance(parsed, dict):
                input_obj = parsed
        except Exception:
            pass

    if not isinstance(input_obj, dict):
        warning(f'qdrant.search: unexpected input type {type(input_obj).__name__}: {input_obj!r}')
        return {}

    if 'input' in input_obj and isinstance(input_obj['input'], dict):
        inner = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        input_obj = {**inner, **extras}

    input_obj.pop('security_context', None)
    return input_obj
