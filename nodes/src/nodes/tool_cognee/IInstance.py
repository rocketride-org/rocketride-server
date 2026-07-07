# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Cognee node instance.

Exposes cognee as agent tools backed by its REST API. The typical flow is
``add`` (ingest content) then ``cognify`` (build the knowledge graph) then
``search`` (ask questions over it); ``reset`` clears a dataset. This class is a
thin adapter over ``cognee_client`` — input normalization and validation here,
HTTP there. Tool methods raise (``ValueError`` for bad input, ``RuntimeError``
for API failures) rather than returning error dicts.
"""

from __future__ import annotations

from typing import Any, Dict

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input

from . import cognee_client
from .IGlobal import IGlobal, _SEARCH_TYPES, _MAX_TOP_K


class IInstance(IInstanceBase):
    """Node instance exposing cognee as agent tools."""

    IGlobal: IGlobal

    # ------------------------------------------------------------------
    # Tools
    # ------------------------------------------------------------------

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['text'],
            'properties': {
                'text': {
                    'type': 'string',
                    'description': 'The content to remember. Raw text, or a URL / public repo URL for cognee to fetch and ingest.',
                },
                'dataset': {
                    'type': 'string',
                    'description': 'Dataset to add this content to. Defaults to the node config value.',
                },
                'run_in_background': {
                    'type': 'boolean',
                    'description': 'When true, queue ingestion and return immediately. Default false (wait for it to be stored).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'dataset': {'type': 'string'},
                'status': {'type': 'string'},
                'pipeline_run_id': {'type': 'string'},
            },
        },
        description=(
            'Ingest content into cognee memory. This only stores the raw content — call cognify '
            'afterwards to build the knowledge graph before it can be searched. Returns the dataset '
            'and a pipeline run id.'
        ),
    )
    def add(self, args: Any) -> Dict[str, Any]:
        """Ingest content into a cognee dataset."""
        args = normalize_tool_input(args, tool_name='add')
        cfg = self.IGlobal

        text = str(args.get('text') or '').strip()
        if not text:
            raise ValueError('cognee.add: "text" is required and must be a non-empty string')

        dataset = str(args.get('dataset') or cfg.dataset).strip() or cfg.dataset
        run_in_background = bool(args.get('run_in_background', False))

        return cognee_client.add(
            cfg.base_url,
            cfg.api_key,
            text=text,
            dataset=dataset,
            run_in_background=run_in_background,
            timeout=cfg.request_timeout,
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'dataset': {
                    'type': 'string',
                    'description': 'Dataset to build the graph for. Defaults to the node config value.',
                },
                'run_in_background': {
                    'type': 'boolean',
                    'description': 'When true, start the build and return immediately with a run id. Default false (wait for completion).',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'dataset': {'type': 'string'},
                'status': {'type': 'string'},
                'pipeline_run_id': {'type': 'string'},
            },
        },
        description=(
            'Build the knowledge graph and embeddings from content already added to a dataset. Run '
            'this after add and before search. Synchronous by default and can take a while on large '
            'datasets; set run_in_background to return immediately with a run id.'
        ),
    )
    def cognify(self, args: Any) -> Dict[str, Any]:
        """Build the cognee knowledge graph for a dataset."""
        args = normalize_tool_input(args, tool_name='cognify')
        cfg = self.IGlobal

        dataset = str(args.get('dataset') or cfg.dataset).strip() or cfg.dataset
        run_in_background = bool(args.get('run_in_background', False))

        return cognee_client.cognify(
            cfg.base_url,
            cfg.api_key,
            dataset=dataset,
            run_in_background=run_in_background,
            timeout=cfg.request_timeout,
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['query'],
            'properties': {
                'query': {
                    'type': 'string',
                    'description': 'Natural-language question to answer from cognee memory.',
                },
                'search_type': {
                    'type': 'string',
                    'description': 'How to retrieve: GRAPH_COMPLETION (graph answer, default), RAG_COMPLETION, CHUNKS, SUMMARIES, TEMPORAL, or FEELING_LUCKY. Defaults to the node config value.',
                },
                'dataset': {
                    'type': 'string',
                    'description': 'Dataset to search. Defaults to the node config value.',
                },
                'top_k': {
                    'type': 'integer',
                    'description': 'Maximum number of results to retrieve. Defaults to the node config value.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'results': {'type': 'array', 'items': {'type': 'object'}},
                'count': {'type': 'integer'},
            },
        },
        description=(
            'Search cognee memory and return relevant results. Requires content to have been added '
            'and cognified first. Returns a list of results (a graph/RAG answer for completion '
            'search types, or raw passages for CHUNKS/SUMMARIES) and their count.'
        ),
    )
    def search(self, args: Any) -> Dict[str, Any]:
        """Query cognee memory and return relevant results."""
        args = normalize_tool_input(args, tool_name='search')
        cfg = self.IGlobal

        query = str(args.get('query') or '').strip()
        if not query:
            raise ValueError('cognee.search: "query" is required and must be a non-empty string')

        search_type = str(args.get('search_type') or cfg.search_type).strip().upper()
        if search_type not in _SEARCH_TYPES:
            search_type = cfg.search_type

        dataset = str(args.get('dataset') or cfg.dataset).strip() or cfg.dataset

        raw_top_k = args.get('top_k', cfg.top_k)
        if isinstance(raw_top_k, bool) or not isinstance(raw_top_k, int):
            raw_top_k = cfg.top_k
        top_k = max(1, min(_MAX_TOP_K, raw_top_k))

        results = cognee_client.search(
            cfg.base_url,
            cfg.api_key,
            query=query,
            search_type=search_type,
            dataset=dataset,
            top_k=top_k,
            timeout=cfg.request_timeout,
        )
        return {'results': results, 'count': len(results)}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'dataset': {
                    'type': 'string',
                    'description': 'Dataset to clear. Defaults to the node config value.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'dataset': {'type': 'string'},
                'status': {'type': 'string', 'description': 'reset | not_found'},
                'deleted': {'type': 'boolean'},
            },
        },
        description=(
            'Permanently clear a cognee dataset: deletes its knowledge graph, ingested data, and the '
            'dataset record. Use to start a dataset over. This cannot be undone. Reports not_found if '
            'the dataset does not exist (nothing to clear).'
        ),
    )
    def reset(self, args: Any) -> Dict[str, Any]:
        """Clear a cognee dataset."""
        args = normalize_tool_input(args, tool_name='reset')
        cfg = self.IGlobal

        dataset = str(args.get('dataset') or cfg.dataset).strip() or cfg.dataset

        return cognee_client.reset(
            cfg.base_url,
            cfg.api_key,
            dataset=dataset,
            timeout=cfg.request_timeout,
        )
