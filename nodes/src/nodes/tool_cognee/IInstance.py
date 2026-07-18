# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Thin RocketRide tool adapters for Cognee persistent semantic memory."""

from __future__ import annotations

from typing import Any, Dict

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input

from . import cognee_client
from .IGlobal import IGlobal, MAX_TOP_K, SEARCH_TYPES


class IInstance(IInstanceBase):
    """Expose Cognee's shared memory workflow as three agent tools."""

    IGlobal: IGlobal

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['text'],
            'properties': {
                'text': {
                    'type': 'string',
                    'description': 'Plain text to store and process as persistent semantic memory.',
                },
                'dataset': {
                    'type': 'string',
                    'description': 'Operator-configured dataset to remember this text in. A different dataset requires the node override setting.',
                },
                'run_in_background': {
                    'type': 'boolean',
                    'description': 'Queue processing and return immediately when true. Defaults to false.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'status': {'type': 'string'},
                'dataset_name': {'type': 'string'},
                'dataset_id': {'type': 'string'},
                'pipeline_run_id': {'type': 'string'},
            },
        },
        description=(
            'Store plain text in persistent Cognee memory and build its semantic knowledge graph in '
            'one operation. Use memory_status after a background call, then recall to retrieve '
            'memory results. The graph captures semantic relationships; it is not an AST, import '
            'graph, or call graph, and this tool does not ingest repository URLs.'
        ),
    )
    def remember(self, args: Any) -> Dict[str, Any]:
        """Store plain text in the configured Cognee dataset."""
        args = normalize_tool_input(args, tool_name='remember')
        cfg = self.IGlobal
        text = _required_string(args, 'text', tool_name='remember')
        dataset = _dataset(args, cfg, tool_name='remember')
        run_in_background = args.get('run_in_background', False)
        if not isinstance(run_in_background, bool):
            raise ValueError('cognee.remember: "run_in_background" must be a boolean')

        return cognee_client.remember(
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
            'required': ['query'],
            'properties': {
                'query': {
                    'type': 'string',
                    'description': 'Natural-language question to answer from persistent memory.',
                },
                'dataset': {
                    'type': 'string',
                    'description': 'Operator-configured dataset to recall from. A different dataset requires the node override setting.',
                },
                'search_type': {
                    'type': 'string',
                    'description': 'Cognee retrieval strategy. Defaults to graph completion decomposition.',
                },
                'top_k': {
                    'type': 'integer',
                    'description': 'Maximum results to retrieve, from 1 through 100.',
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
            'Recall results from persistent Cognee memory while always requesting source references. '
            'Use after remember has completed. Graph retrieval follows semantic '
            'relationships; it does not inspect an AST, import graph, or call graph.'
        ),
    )
    def recall(self, args: Any) -> Dict[str, Any]:
        """Recall memory results while requesting references from Cognee."""
        args = normalize_tool_input(args, tool_name='recall')
        cfg = self.IGlobal
        query = _required_string(args, 'query', tool_name='recall')
        dataset = _dataset(args, cfg, tool_name='recall')

        search_type = args.get('search_type', cfg.search_type)
        if not isinstance(search_type, str) or not search_type.strip():
            raise ValueError('cognee.recall: "search_type" must be a non-empty string')
        search_type = search_type.strip().upper()
        if search_type not in SEARCH_TYPES:
            raise ValueError(f'cognee.recall: unsupported search_type "{search_type}"')

        top_k = args.get('top_k', cfg.top_k)
        if isinstance(top_k, bool) or not isinstance(top_k, int):
            raise ValueError('cognee.recall: "top_k" must be an integer')
        top_k = max(1, min(MAX_TOP_K, top_k))

        results = cognee_client.recall(
            cfg.base_url,
            cfg.api_key,
            query=query,
            dataset=dataset,
            search_type=search_type,
            top_k=top_k,
            include_references=True,
            timeout=cfg.request_timeout,
        )
        return {'results': results, 'count': len(results)}

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'dataset': {
                    'type': 'string',
                    'description': 'Operator-configured dataset whose remember pipeline should be checked. A different dataset requires the node override setting.',
                },
            },
        },
        output_schema={
            'type': 'object',
            'properties': {
                'dataset': {'type': 'string'},
                'dataset_id': {'type': 'string'},
                'status': {
                    'type': 'string',
                    'enum': ['pending', 'running', 'completed', 'failed'],
                },
            },
        },
        description=(
            'Check whether background Cognee memory processing is pending, running, completed, or '
            'failed before calling recall. The resulting graph is semantic, '
            'not an AST, import graph, or call graph.'
        ),
    )
    def memory_status(self, args: Any) -> Dict[str, Any]:
        """Return the normalized processing status for a Cognee dataset."""
        args = normalize_tool_input(args, tool_name='memory_status')
        cfg = self.IGlobal
        dataset = _dataset(args, cfg, tool_name='memory_status')
        dataset_id = self._resolve_dataset_id(dataset)
        status = cognee_client.get_dataset_status(
            cfg.base_url,
            cfg.api_key,
            dataset_id=dataset_id,
            timeout=cfg.request_timeout,
        )
        return {'dataset': dataset, 'dataset_id': dataset_id, 'status': status}

    def _resolve_dataset_id(self, dataset: str) -> str:
        """Resolve an exact dataset name to the UUID required by memory status."""
        cfg = self.IGlobal
        datasets = cognee_client.list_datasets(
            cfg.base_url,
            cfg.api_key,
            timeout=cfg.request_timeout,
        )
        for row in datasets:
            if str(row.get('name') or '') == dataset:
                dataset_id = str(row.get('id') or '').strip()
                if dataset_id:
                    return dataset_id
        raise ValueError(f'cognee: dataset "{dataset}" was not found')


def _required_string(args: Dict[str, Any], field: str, *, tool_name: str) -> str:
    """Return a required trimmed string or raise a tool-scoped input error."""
    value = args.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'cognee.{tool_name}: "{field}" is required and must be a non-empty string')
    return value.strip()


def _dataset(args: Dict[str, Any], cfg: IGlobal, *, tool_name: str) -> str:
    """Resolve the operator dataset and allow alternate scopes only when enabled."""
    if 'dataset' not in args:
        return cfg.dataset
    value = args['dataset']
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'cognee.{tool_name}: "dataset" must be a non-empty string')
    dataset = value.strip()
    if dataset != cfg.dataset and not cfg.allow_dataset_override:
        raise ValueError(f'cognee.{tool_name}: "dataset" must match the configured dataset')
    return dataset
