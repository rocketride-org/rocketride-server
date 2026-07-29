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
Instance-level state for the HydraDB database node.

Exposes agent-callable tools (store_memory, recall_memory, query_graph, get_schema)
that call HydraDB's v2 REST API. Retrieval is HydraDB's native server-side search -
no embeddings, no query language, no LLM translation - so this node consumes no LLM.
"""

from __future__ import annotations

from rocketlib import IInstanceBase, tool_function

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """HydraDB-specific instance state."""

    IGlobal: IGlobal

    def _require_client(self):
        """Return the configured HydraDB client, or raise if the node isn't configured."""
        if self.IGlobal.client is None:
            raise RuntimeError('HydraDB client is not configured')
        return self.IGlobal.client

    # ------------------------------------------------------------------
    # Tool methods
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['text'],
            'properties': {
                'text': {
                    'type': 'string',
                    'description': (
                        'The text to store as a memory. HydraDB automatically extracts entities and '
                        'relationships into its knowledge graph.'
                    ),
                },
                'metadata': {
                    'type': 'object',
                    'description': 'Optional metadata to attach to the stored memory.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'status': {'type': 'string', 'description': 'ok when the memory was accepted for ingestion.'},
                'result': {'type': 'object', 'description': 'Raw HydraDB ingest response.'},
            },
        },
        description=(
            'Store text into HydraDB as a memory. HydraDB automatically extracts entities and '
            'relationships into its knowledge graph. Use recall_memory to retrieve stored context later.'
        ),
    )
    def store_memory(self, args):
        """Ingest text as a HydraDB memory."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')

        text = args.get('text')
        if not text or not isinstance(text, str) or not text.strip():
            raise ValueError('"text" is required and must be a non-empty string')

        metadata = args.get('metadata')
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError('"metadata" must be an object if provided')

        client = self._require_client()
        result = client.store_memory(text.strip(), metadata=metadata)
        return {'status': 'ok', 'result': result}

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {
                    'type': 'string',
                    'description': 'Natural-language query to recall relevant context.',
                },
                'max_results': {
                    'type': 'integer',
                    'description': 'Maximum number of results (defaults to the node config, max 100).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'results': {
                    'type': 'array',
                    'items': {'type': 'object'},
                    'description': 'Ranked, graph-enriched results from HydraDB.',
                },
                'result': {'type': 'object', 'description': 'Raw HydraDB query response.'},
            },
        },
        description=(
            'Recall graph-enriched context from HydraDB by natural-language query. Searches both '
            'knowledge and memories and returns ranked results with knowledge-graph context. This is '
            'HydraDB-native search - no embedding step is required.'
        ),
    )
    def recall_memory(self, args):
        """Recall graph-enriched context from HydraDB."""
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')

        query = args.get('query')
        if not query or not isinstance(query, str) or not query.strip():
            raise ValueError('"query" is required and must be a non-empty string')

        max_results = args.get('max_results')
        if max_results is None:
            max_results = self.IGlobal.max_results
        elif isinstance(max_results, bool) or not isinstance(max_results, int):
            raise ValueError('"max_results" must be an integer')
        else:
            max_results = max(1, min(100, max_results))

        client = self._require_client()
        result = client.query(query.strip(), type='all', max_results=max_results)
        results = client.extract_results(result)
        return {'results': results, 'result': result}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'source_id': {
                    'type': 'string',
                    'description': (
                        'Optional id of a specific ingested source to inspect. Omit to return all '
                        'relations in the collection.'
                    ),
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'relations': {
                    'type': 'object',
                    'description': 'Entities and relationship triplets from the knowledge graph.',
                },
                'result': {'type': 'object', 'description': 'Raw HydraDB relations response.'},
            },
        },
        description=(
            'Inspect the knowledge-graph relations HydraDB extracted from ingested content: entities '
            'and their relationship triplets. Optionally scope to a single source_id. This is '
            'relationship inspection, not a free-form graph query language.'
        ),
    )
    def query_graph(self, args):
        """Inspect knowledge-graph relations."""
        if args is None:
            args = {}
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')

        source_id = args.get('source_id')
        if source_id is not None and (not isinstance(source_id, str) or not source_id.strip()):
            raise ValueError('"source_id" must be a non-empty string if provided')

        client = self._require_client()
        result = client.relations(source_id=source_id.strip() if source_id else None)
        return {'relations': client.unwrap(result), 'result': result}

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        output_schema={
            'type': 'object',
            'properties': {
                'database': {'type': 'string'},
                'collections': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Collection ids in the database.',
                },
                'infra': {'type': 'object', 'description': 'Infrastructure readiness flags.'},
                'result': {'type': 'object', 'description': 'Raw HydraDB collections + status responses.'},
            },
        },
        description=(
            "Return the HydraDB database's shape: its collections and infrastructure readiness "
            '(whether the knowledge/memory vector stores and graph layer are provisioned). Use this '
            'to discover available collections or confirm the database is ready.'
        ),
    )
    def get_schema(self, args):
        """Return the database's collections + infrastructure readiness."""
        if args is not None and not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object or empty')

        client = self._require_client()
        collections = client.collections()
        status = client.status()
        col_data = client.unwrap(collections)
        status_data = client.unwrap(status)
        return {
            'database': self.IGlobal.database,
            'collections': (col_data.get('collections') if isinstance(col_data, dict) else None) or [],
            'infra': (status_data.get('infra') if isinstance(status_data, dict) else None) or {},
            'result': {'collections': collections, 'status': status},
        }
