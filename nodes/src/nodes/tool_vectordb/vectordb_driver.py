"""
Vector DB tool-provider driver.

Provides a unified tool interface for vector database operations that agents
can invoke. Supports search, upsert, and delete across multiple backends
(Pinecone, ChromaDB, Qdrant) through the common DocumentStoreBase interface.

Tools exposed:
  - <server>.search  — semantic or keyword search over the vector store
  - <server>.upsert  — add or update documents in the store
  - <server>.delete  — remove documents by object ID
"""

from __future__ import annotations

import json
from typing import Any, Dict, List
from rocketlib import warning

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText
from ai.common.store import DocumentStoreBase
from ai.common.tools import ToolsBase

# ---------------------------------------------------------------------------
# Static tool definitions
# ---------------------------------------------------------------------------

SEARCH_TOOL: Dict[str, Any] = {
    'name': 'search',
    'description': ('Search for documents in the vector database using semantic similarity. Returns matching documents ranked by relevance with their content, metadata, and similarity scores.'),
    'inputSchema': {
        'type': 'object',
        'properties': {
            'query': {
                'type': 'string',
                'description': 'The search query text. Will be matched against stored documents using semantic similarity.',
            },
            'top_k': {
                'type': 'integer',
                'description': 'Maximum number of results to return (default: 10).',
                'default': 10,
            },
            'filter': {
                'type': 'object',
                'description': ('Optional metadata filter. Keys are metadata field names, values are the required values. Example: {"nodeId": "my-node", "parent": "/docs"}'),
                'additionalProperties': True,
            },
        },
        'required': ['query'],
    },
    'outputSchema': {
        'type': 'object',
        'properties': {
            'results': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'properties': {
                        'content': {'type': 'string'},
                        'score': {'type': 'number'},
                        'metadata': {'type': 'object'},
                    },
                },
            },
            'total': {'type': 'integer'},
        },
    },
}

UPSERT_TOOL: Dict[str, Any] = {
    'name': 'upsert',
    'description': ('Add or update documents in the vector database. Each document requires content text and an object ID for deduplication.'),
    'inputSchema': {
        'type': 'object',
        'properties': {
            'documents': {
                'type': 'array',
                'description': 'Array of documents to upsert.',
                'items': {
                    'type': 'object',
                    'properties': {
                        'content': {
                            'type': 'string',
                            'description': 'The text content of the document.',
                        },
                        'object_id': {
                            'type': 'string',
                            'description': 'Unique identifier for the document. Used for deduplication.',
                        },
                        'metadata': {
                            'type': 'object',
                            'description': 'Optional metadata key-value pairs to store with the document.',
                            'additionalProperties': True,
                        },
                    },
                    'required': ['content', 'object_id'],
                },
            },
        },
        'required': ['documents'],
    },
    'outputSchema': {
        'type': 'object',
        'properties': {
            'success': {'type': 'boolean'},
            'count': {'type': 'integer'},
        },
    },
}

DELETE_TOOL: Dict[str, Any] = {
    'name': 'delete',
    'description': ('Delete documents from the vector database by their object IDs.'),
    'inputSchema': {
        'type': 'object',
        'properties': {
            'object_ids': {
                'type': 'array',
                'items': {'type': 'string'},
                'description': 'List of object IDs to delete.',
            },
        },
        'required': ['object_ids'],
    },
    'outputSchema': {
        'type': 'object',
        'properties': {
            'success': {'type': 'boolean'},
            'deleted_count': {'type': 'integer'},
        },
    },
}

_ALL_TOOLS: Dict[str, Dict[str, Any]] = {
    'search': SEARCH_TOOL,
    'upsert': UPSERT_TOOL,
    'delete': DELETE_TOOL,
}

_DEFAULT_TOP_K = 10
_MAX_TOP_K = 100


class VectorDBDriver(ToolsBase):
    """Tool provider for vector database operations."""

    def __init__(
        self,
        *,
        server_name: str,
        backend: str,
        store: DocumentStoreBase,
        collection_description: str = '',
        enable_search: bool = True,
        enable_upsert: bool = False,
        enable_delete: bool = False,
        default_top_k: int = _DEFAULT_TOP_K,
        score_threshold: float = 0.0,
    ) -> None:
        """Initialize the driver with backend store and tool configuration."""
        self._server_name = (server_name or '').strip() or 'vectordb'
        self._backend = backend
        self._store = store
        self._collection_description = collection_description
        self._enable_search = enable_search
        self._enable_upsert = enable_upsert
        self._enable_delete = enable_delete
        self._default_top_k = max(1, min(default_top_k, _MAX_TOP_K))
        self._score_threshold = max(0.0, min(score_threshold, 1.0))

        # Build the set of enabled tool bare names
        self._enabled_tools: Dict[str, Dict[str, Any]] = {}
        if enable_search:
            self._enabled_tools['search'] = SEARCH_TOOL
        if enable_upsert:
            self._enabled_tools['upsert'] = UPSERT_TOOL
        if enable_delete:
            self._enabled_tools['delete'] = DELETE_TOOL

    def _bare_name(self, tool_name: str) -> str:
        """Strip server prefix, accepting both bare and namespaced tool names."""
        prefix = f'{self._server_name}.'
        return tool_name[len(prefix) :] if tool_name.startswith(prefix) else tool_name

    # ------------------------------------------------------------------
    # ToolsBase hooks
    # ------------------------------------------------------------------

    def _tool_query(self) -> List[ToolsBase.ToolDescriptor]:
        desc_prefix = f'{self._collection_description} ' if self._collection_description else ''
        tools = []
        for tool_def in self._enabled_tools.values():
            namespaced = {
                **tool_def,
                'name': f'{self._server_name}.{tool_def["name"]}',
                'description': f'{desc_prefix}{tool_def["description"]}',
            }
            tools.append(namespaced)
        return tools

    def _tool_validate(self, *, tool_name: str, input_obj: Any) -> None:  # noqa: ANN401
        bare = self._bare_name(tool_name)
        tool_def = self._enabled_tools.get(bare)
        if tool_def is None:
            raise ValueError(f'Unknown or disabled tool {tool_name!r}')

        args = _normalize_input(input_obj)
        schema = tool_def.get('inputSchema', {})
        required = schema.get('required', [])
        if required and not isinstance(args, dict):
            raise ValueError(f'Tool input must be an object; required fields={required}')
        missing = [k for k in required if k not in args]
        if missing:
            raise ValueError(f'Tool input missing required fields: {missing}')

    def _tool_invoke(self, *, tool_name: str, input_obj: Any) -> Any:  # noqa: ANN401
        args = _normalize_input(input_obj)
        bare = self._bare_name(tool_name)

        if bare == 'search':
            return self._invoke_search(args)
        elif bare == 'upsert':
            return self._invoke_upsert(args)
        elif bare == 'delete':
            return self._invoke_delete(args)
        else:
            raise ValueError(f'Unknown tool {tool_name!r}')

    # ------------------------------------------------------------------
    # Tool implementations
    # ------------------------------------------------------------------

    def _invoke_search(self, args: Dict[str, Any]) -> Dict[str, Any]:
        query_text = str(args.get('query', '')).strip()
        if not query_text:
            raise ValueError('search requires a non-empty "query" string')

        try:
            top_k = int(args.get('top_k', self._default_top_k))
        except (TypeError, ValueError):
            top_k = self._default_top_k
        top_k = max(1, min(top_k, _MAX_TOP_K))

        # Build filter from optional metadata filter
        raw_filter = args.get('filter') or {}
        doc_filter = DocFilter()
        if isinstance(raw_filter, dict):
            object_id = raw_filter.get('objectId')
            if object_id:
                doc_filter.objectId = [object_id] if isinstance(object_id, str) else object_id
            node_id = raw_filter.get('nodeId')
            if node_id:
                doc_filter.nodeId = node_id
            parent = raw_filter.get('parent')
            if parent:
                doc_filter.parent = parent

        # Build the question for the store's search interface
        question = QuestionText(
            text=query_text,
            topK=top_k,
        )

        # Use semantic search (the primary use case for vector DBs)
        try:
            docs: List[Doc] = self._store.searchSemantic(question, doc_filter)
        except Exception as e:
            # Fall back to keyword search if semantic is not available
            # (e.g., no embeddings configured)
            warning(f'tool_vectordb: semantic search failed ({e}), trying keyword search')
            try:
                docs = self._store.searchKeyword(question, doc_filter)
            except Exception as e2:
                raise RuntimeError(f'tool_vectordb: search failed: {e2}') from e2

        # Format results
        results = []
        for doc in docs:
            score = getattr(doc, 'score', 0.0) or 0.0
            if self._score_threshold > 0 and score < self._score_threshold:
                continue
            meta = {}
            if doc.metadata:
                meta = {
                    'objectId': doc.metadata.objectId,
                    'nodeId': doc.metadata.nodeId,
                    'parent': doc.metadata.parent,
                    'chunkId': doc.metadata.chunkId,
                }
            results.append(
                {
                    'content': doc.page_content or '',
                    'score': score,
                    'metadata': meta,
                }
            )

        return {
            'results': results[:top_k],
            'total': len(results),
        }

    def _invoke_upsert(self, args: Dict[str, Any]) -> Dict[str, Any]:
        raw_docs = args.get('documents', [])
        if not isinstance(raw_docs, list) or not raw_docs:
            raise ValueError('upsert requires a non-empty "documents" array')

        docs: List[Doc] = []
        for raw in raw_docs:
            if not isinstance(raw, dict):
                continue
            content = str(raw.get('content', '')).strip()
            object_id = str(raw.get('object_id', '')).strip()
            if not content or not object_id:
                continue

            extra_meta = raw.get('metadata') or {}
            metadata = DocMetadata(
                objectId=object_id,
                nodeId=extra_meta.get('nodeId', 'tool_vectordb'),
                parent=extra_meta.get('parent', '/'),
                chunkId=extra_meta.get('chunkId', 0),
                isDeleted=False,
            )
            doc = Doc(
                page_content=content,
                metadata=metadata,
            )
            docs.append(doc)

        if not docs:
            raise ValueError('upsert: no valid documents provided')

        self._store.addChunks(docs)
        return {'success': True, 'count': len(docs)}

    def _invoke_delete(self, args: Dict[str, Any]) -> Dict[str, Any]:
        object_ids = args.get('object_ids', [])
        if not isinstance(object_ids, list) or not object_ids:
            raise ValueError('delete requires a non-empty "object_ids" array')

        # Sanitize
        clean_ids = [str(oid).strip() for oid in object_ids if str(oid).strip()]
        if not clean_ids:
            raise ValueError('delete: no valid object IDs provided')

        self._store.remove(clean_ids)
        return {'success': True, 'deleted_count': len(clean_ids)}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalize_input(input_obj: Any) -> Dict[str, Any]:
    """Normalize tool input into a plain dict."""
    if input_obj is None:
        return {}

    # Pydantic model -> dict
    if hasattr(input_obj, 'model_dump') and callable(getattr(input_obj, 'model_dump')):
        input_obj = input_obj.model_dump()
    elif hasattr(input_obj, 'dict') and callable(getattr(input_obj, 'dict')):
        input_obj = input_obj.dict()

    # JSON string -> dict
    if isinstance(input_obj, str):
        try:
            parsed = json.loads(input_obj)
            if isinstance(parsed, dict):
                input_obj = parsed
        except (json.JSONDecodeError, ValueError) as exc:
            warning(f'tool_vectordb: malformed JSON input, returning empty dict: {exc}')
            return {}

    if not isinstance(input_obj, dict):
        warning(f'tool_vectordb: unexpected input type {type(input_obj).__name__}')
        return {}

    # Unwrap {"input": {...}} wrappers that some framework paths leave behind
    if 'input' in input_obj and isinstance(input_obj['input'], dict):
        inner = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        input_obj = {**inner, **extras}

    # Drop framework-injected keys that are not tool args
    input_obj.pop('security_context', None)

    return input_obj
