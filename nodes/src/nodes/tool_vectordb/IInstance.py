# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Vector DB tool node instance.

Exposes ``search``, ``upsert``, and ``delete`` tools for vector database
operations via the ``@tool_function`` decorator.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

from rocketlib import IInstanceBase, tool_function, warning

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText

from .IGlobal import IGlobal

_MAX_TOP_K = 100


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
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
                    'description': 'Optional metadata filter. Keys are metadata field names, values are the required values. Example: {"nodeId": "my-node", "parent": "/docs"}',
                    'additionalProperties': True,
                },
            },
        },
        output_schema={
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
        description='Search for documents in the vector database using semantic similarity. Returns matching documents ranked by relevance with their content, metadata, and similarity scores.',
    )
    def search(self, args):
        """Search for documents in the vector database."""
        args = _normalize_input(args)
        store = self.IGlobal.store
        if store is None:
            raise RuntimeError('tool_vectordb: store not initialized')

        query_text = str(args.get('query', '')).strip()
        if not query_text:
            raise ValueError('search requires a non-empty "query" string')

        try:
            top_k = int(args.get('top_k', self.IGlobal.default_top_k))
        except (TypeError, ValueError):
            top_k = self.IGlobal.default_top_k
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

        question = QuestionText(text=query_text)
        doc_filter.limit = top_k

        try:
            docs: List[Doc] = store.searchSemantic(question, doc_filter)
        except Exception as e:
            warning(f'tool_vectordb: semantic search failed ({e}), trying keyword search')
            try:
                docs = store.searchKeyword(question, doc_filter)
            except Exception as e2:
                raise RuntimeError(f'tool_vectordb: search failed: {e2}') from e2

        results = []
        for doc in docs:
            score = getattr(doc, 'score', 0.0) or 0.0
            if self.IGlobal.score_threshold > 0 and score < self.IGlobal.score_threshold:
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

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['documents'],
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
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'count': {'type': 'integer'},
            },
        },
        description='Add or update documents in the vector database. Each document requires content text and an object ID for deduplication. Note: documents are stored as text chunks without embeddings; the backend must be configured to compute embeddings on ingest, or an upstream embedding node must be present in the pipeline.',
    )
    def upsert(self, args):
        """Add or update documents in the vector database."""
        args = _normalize_input(args)
        store = self.IGlobal.store
        if store is None:
            raise RuntimeError('tool_vectordb: store not initialized')

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

        if any(not getattr(doc, 'embedding', None) for doc in docs):
            warning('tool_vectordb: upserting documents without pre-computed embeddings. Ensure the backend is configured to generate embeddings on ingest, or results may not be searchable via semantic search.')

        store.addChunks(docs)
        return {'success': True, 'count': len(docs)}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['object_ids'],
            'properties': {
                'object_ids': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'List of object IDs to delete.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'success': {'type': 'boolean'},
                'deleted_count': {'type': 'integer'},
            },
        },
        description='Delete documents from the vector database by their object IDs.',
    )
    def delete(self, args):
        """Delete documents from the vector database by object IDs."""
        args = _normalize_input(args)
        store = self.IGlobal.store
        if store is None:
            raise RuntimeError('tool_vectordb: store not initialized')

        object_ids = args.get('object_ids', [])
        if not isinstance(object_ids, list) or not object_ids:
            raise ValueError('delete requires a non-empty "object_ids" array')

        clean_ids = [str(oid).strip() for oid in object_ids if str(oid).strip()]
        if not clean_ids:
            raise ValueError('delete: no valid object IDs provided')

        store.remove(clean_ids)
        return {'success': True, 'deleted_count': len(clean_ids)}


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
            parsed = json.loads(input_obj)
            if isinstance(parsed, dict):
                input_obj = parsed
        except (json.JSONDecodeError, ValueError) as exc:
            warning(f'tool_vectordb: malformed JSON input, returning empty dict: {exc}')
            return {}

    if not isinstance(input_obj, dict):
        warning(f'tool_vectordb: unexpected input type {type(input_obj).__name__}')
        return {}

    if 'input' in input_obj and isinstance(input_obj['input'], dict):
        inner = input_obj['input']
        extras = {k: v for k, v in input_obj.items() if k != 'input'}
        input_obj = {**inner, **extras}

    input_obj.pop('security_context', None)

    return input_obj
