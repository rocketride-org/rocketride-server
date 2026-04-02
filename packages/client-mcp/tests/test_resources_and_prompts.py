# MIT License
# Copyright (c) 2026 Aparavi Software AG
# Tests for rocketride_mcp.resources and rocketride_mcp.prompts.

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import mcp.types as types

from rocketride_mcp import resources as resources_mod
from rocketride_mcp import prompts as prompts_mod
from rocketride_mcp.resources import URI_PIPELINES, URI_STATUS, URI_NODES


# =============================================================================
# Resources -- list_resources
# =============================================================================


async def test_list_resources_returns_three_entries() -> None:
    result = await resources_mod.list_resources(None)
    assert len(result) == 3


async def test_list_resources_returns_resource_types() -> None:
    result = await resources_mod.list_resources(None)
    for r in result:
        assert isinstance(r, types.Resource)


async def test_list_resources_contains_pipelines_uri() -> None:
    result = await resources_mod.list_resources(None)
    uris = [str(r.uri) for r in result]
    assert URI_PIPELINES in uris


async def test_list_resources_contains_status_uri() -> None:
    result = await resources_mod.list_resources(None)
    uris = [str(r.uri) for r in result]
    assert URI_STATUS in uris


async def test_list_resources_contains_nodes_uri() -> None:
    result = await resources_mod.list_resources(None)
    uris = [str(r.uri) for r in result]
    assert URI_NODES in uris


async def test_list_resources_all_have_json_mimetype() -> None:
    result = await resources_mod.list_resources(None)
    for r in result:
        assert r.mimeType == 'application/json'


async def test_list_resources_all_have_name_and_description() -> None:
    result = await resources_mod.list_resources(None)
    for r in result:
        assert r.name
        assert r.description


async def test_list_resources_accepts_client(mock_rocketride_client: MagicMock) -> None:
    """list_resources works with a real client object (forward-compat)."""
    result = await resources_mod.list_resources(mock_rocketride_client)
    assert len(result) == 3


# =============================================================================
# Resources -- read_resource (pipelines)
# =============================================================================


async def test_read_pipelines_when_client_none() -> None:
    raw = await resources_mod.read_resource(None, URI_PIPELINES)
    data = json.loads(raw)
    assert data['pipelines'] == []
    assert 'error' in data


async def test_read_pipelines_with_connected_client(mock_rocketride_client: MagicMock) -> None:
    raw = await resources_mod.read_resource(mock_rocketride_client, URI_PIPELINES)
    data = json.loads(raw)
    assert len(data['pipelines']) == 2
    assert data['pipelines'][0]['name'] == 'Task1'
    assert data['pipelines'][1]['name'] == 'Task2'


async def test_read_pipelines_returns_valid_json(mock_rocketride_client: MagicMock) -> None:
    raw = await resources_mod.read_resource(mock_rocketride_client, URI_PIPELINES)
    data = json.loads(raw)
    assert isinstance(data, dict)
    assert 'pipelines' in data


async def test_read_pipelines_handles_exception() -> None:
    client = MagicMock()
    client.build_request = MagicMock(return_value={'command': 'rrext_get_tasks'})
    client.request = AsyncMock(side_effect=RuntimeError('connection lost'))
    raw = await resources_mod.read_resource(client, URI_PIPELINES)
    data = json.loads(raw)
    assert data['pipelines'] == []
    assert 'connection lost' in data['error']


# =============================================================================
# Resources -- read_resource (status)
# =============================================================================


async def test_read_status_when_client_none() -> None:
    raw = await resources_mod.read_resource(None, URI_STATUS)
    data = json.loads(raw)
    assert data['connected'] is False
    assert 'error' in data


async def test_read_status_with_connected_client(mock_rocketride_client: MagicMock) -> None:
    raw = await resources_mod.read_resource(mock_rocketride_client, URI_STATUS)
    data = json.loads(raw)
    assert data['connected'] is True
    assert data['pipeline_count'] == 2
    assert 'Task1' in data['pipelines']
    assert 'Task2' in data['pipelines']


async def test_read_status_handles_exception() -> None:
    client = MagicMock()
    client.build_request = MagicMock(return_value={'command': 'rrext_get_tasks'})
    client.request = AsyncMock(side_effect=RuntimeError('timeout'))
    raw = await resources_mod.read_resource(client, URI_STATUS)
    data = json.loads(raw)
    assert data['connected'] is False
    assert 'timeout' in data['error']


# =============================================================================
# Resources -- read_resource (nodes)
# =============================================================================


async def test_read_nodes_when_client_none() -> None:
    raw = await resources_mod.read_resource(None, URI_NODES)
    data = json.loads(raw)
    assert data['nodes'] == []
    assert 'error' in data


async def test_read_nodes_with_connected_client() -> None:
    client = MagicMock()
    client.build_request = MagicMock(return_value={'command': 'rrext_get_nodes'})
    client.request = AsyncMock(
        return_value={
            'body': {
                'nodes': [
                    {'name': 'llm-openai', 'type': 'processor'},
                    {'name': 'vector-write', 'type': 'sink'},
                ]
            }
        }
    )
    raw = await resources_mod.read_resource(client, URI_NODES)
    data = json.loads(raw)
    assert len(data['nodes']) == 2
    assert data['nodes'][0]['name'] == 'llm-openai'


async def test_read_nodes_non_list_response() -> None:
    client = MagicMock()
    client.build_request = MagicMock(return_value={'command': 'rrext_get_nodes'})
    client.request = AsyncMock(return_value={'body': {'nodes': 'not-a-list'}})
    raw = await resources_mod.read_resource(client, URI_NODES)
    data = json.loads(raw)
    assert data['nodes'] == []


async def test_read_nodes_handles_exception() -> None:
    client = MagicMock()
    client.build_request = MagicMock(return_value={'command': 'rrext_get_nodes'})
    client.request = AsyncMock(side_effect=RuntimeError('boom'))
    raw = await resources_mod.read_resource(client, URI_NODES)
    data = json.loads(raw)
    assert data['nodes'] == []
    assert 'boom' in data['error']


# =============================================================================
# Resources -- read_resource (unknown URI)
# =============================================================================


async def test_read_resource_unknown_uri_raises() -> None:
    with pytest.raises(ValueError, match='Unknown resource URI'):
        await resources_mod.read_resource(None, 'rocketride://unknown')


async def test_read_resource_arbitrary_string_raises() -> None:
    with pytest.raises(ValueError, match='Unknown resource URI'):
        await resources_mod.read_resource(None, 'https://example.com')


# =============================================================================
# Prompts -- list_prompts
# =============================================================================


def test_list_prompts_returns_three_prompts() -> None:
    result = prompts_mod.list_prompts()
    assert len(result) == 3


def test_list_prompts_returns_prompt_types() -> None:
    result = prompts_mod.list_prompts()
    for p in result:
        assert isinstance(p, types.Prompt)


def test_list_prompts_names() -> None:
    result = prompts_mod.list_prompts()
    names = [p.name for p in result]
    assert 'analyze-document' in names
    assert 'chat-with-data' in names
    assert 'evaluate-pipeline' in names


def test_list_prompts_all_have_descriptions() -> None:
    result = prompts_mod.list_prompts()
    for p in result:
        assert p.description


def test_list_prompts_arguments_are_prompt_argument_types() -> None:
    result = prompts_mod.list_prompts()
    for p in result:
        assert p.arguments is not None
        for arg in p.arguments:
            assert isinstance(arg, types.PromptArgument)


def test_analyze_document_has_required_args() -> None:
    result = prompts_mod.list_prompts()
    prompt = next(p for p in result if p.name == 'analyze-document')
    arg_names = [a.name for a in (prompt.arguments or [])]
    assert 'pipeline' in arg_names
    assert 'query' in arg_names
    for a in prompt.arguments or []:
        assert a.required is True


def test_evaluate_pipeline_has_optional_expected_output() -> None:
    result = prompts_mod.list_prompts()
    prompt = next(p for p in result if p.name == 'evaluate-pipeline')
    expected_arg = next(a for a in (prompt.arguments or []) if a.name == 'expected_output')
    assert expected_arg.required is False


# =============================================================================
# Prompts -- get_prompt
# =============================================================================


def test_get_prompt_analyze_document() -> None:
    result = prompts_mod.get_prompt('analyze-document', {'pipeline': 'my-pipe', 'query': 'summarize'})
    assert isinstance(result, types.GetPromptResult)
    assert len(result.messages) == 1
    assert result.messages[0].role == 'user'
    text = result.messages[0].content.text
    assert 'my-pipe' in text
    assert 'summarize' in text


def test_get_prompt_chat_with_data() -> None:
    result = prompts_mod.get_prompt('chat-with-data', {'pipeline': 'rag-pipe', 'question': 'what is the revenue?'})
    text = result.messages[0].content.text
    assert 'rag-pipe' in text
    assert 'what is the revenue?' in text


def test_get_prompt_evaluate_pipeline_without_expected() -> None:
    result = prompts_mod.get_prompt('evaluate-pipeline', {'pipeline': 'eval-pipe', 'test_input': 'hello world'})
    text = result.messages[0].content.text
    assert 'eval-pipe' in text
    assert 'hello world' in text


def test_get_prompt_evaluate_pipeline_with_expected() -> None:
    result = prompts_mod.get_prompt(
        'evaluate-pipeline',
        {'pipeline': 'eval-pipe', 'test_input': 'hello world', 'expected_output': 'greeting'},
    )
    text = result.messages[0].content.text
    assert 'greeting' in text


def test_get_prompt_unknown_name_raises() -> None:
    with pytest.raises(ValueError, match='Unknown prompt'):
        prompts_mod.get_prompt('nonexistent', {})


def test_get_prompt_missing_required_arg_raises() -> None:
    with pytest.raises(ValueError, match='Missing required argument: pipeline'):
        prompts_mod.get_prompt('analyze-document', {'query': 'test'})


def test_get_prompt_missing_all_required_args_raises() -> None:
    with pytest.raises(ValueError, match='Missing required argument'):
        prompts_mod.get_prompt('analyze-document', {})


def test_get_prompt_none_arguments_raises_for_required() -> None:
    with pytest.raises(ValueError, match='Missing required argument'):
        prompts_mod.get_prompt('chat-with-data', None)


def test_get_prompt_result_has_description() -> None:
    result = prompts_mod.get_prompt('analyze-document', {'pipeline': 'p', 'query': 'q'})
    assert result.description is not None
    assert 'Analyze' in result.description


# =============================================================================
# Server handler registration (smoke tests)
# =============================================================================


async def test_server_registers_list_resources_handler(env_rocketride: None) -> None:
    """Verify list_resources handler is registered on the server."""
    import rocketride_mcp.server as server_mod

    mock_client = MagicMock()
    mock_client.connect = AsyncMock()
    mock_client.disconnect = AsyncMock()

    with patch('rocketride_mcp.server.RocketRideClient', return_value=mock_client):
        with patch('rocketride_mcp.server.mcp.server.stdio.stdio_server') as mock_stdio:
            # Make the context manager raise to short-circuit after registration
            mock_stdio.side_effect = RuntimeError('stop')
            try:
                await server_mod.run_server()
            except RuntimeError as e:
                if 'stop' not in str(e):
                    raise

    # Reaching the stdio_server call means all handler registrations
    # (list_tools, call_tool, list_resources, read_resource) completed
    # without error.  If any decorator failed, we'd never reach this point.
    assert mock_stdio.called, 'stdio_server was never called — handler registration failed'


async def test_server_registers_list_prompts_handler(env_rocketride: None) -> None:
    """Verify list_prompts handler is registered on the server."""
    import rocketride_mcp.server as server_mod

    mock_client = MagicMock()
    mock_client.connect = AsyncMock()
    mock_client.disconnect = AsyncMock()

    with patch('rocketride_mcp.server.RocketRideClient', return_value=mock_client):
        with patch('rocketride_mcp.server.mcp.server.stdio.stdio_server') as mock_stdio:
            mock_stdio.side_effect = RuntimeError('stop')
            try:
                await server_mod.run_server()
            except RuntimeError as e:
                if 'stop' not in str(e):
                    raise

    # Same reasoning: reaching stdio_server means all handler registrations
    # (including list_prompts, get_prompt) completed without error.
    assert mock_stdio.called, 'stdio_server was never called — handler registration failed'


# =============================================================================
# Edge cases and JSON serialization
# =============================================================================


async def test_read_resource_output_is_json_serializable(mock_rocketride_client: MagicMock) -> None:
    """All resource read outputs must be valid JSON strings."""
    for uri in [URI_PIPELINES, URI_STATUS, URI_NODES]:
        if uri == URI_NODES:
            # nodes uses rrext_get_nodes, need separate mock
            mock_rocketride_client.request = AsyncMock(return_value={'body': {'nodes': []}})
        raw = await resources_mod.read_resource(mock_rocketride_client, uri)
        data = json.loads(raw)  # Must not raise
        assert isinstance(data, dict)


async def test_resource_uris_use_rocketride_scheme() -> None:
    """All resource URIs must use the rocketride:// scheme."""
    result = await resources_mod.list_resources(None)
    for r in result:
        assert str(r.uri).startswith('rocketride://')


def test_prompt_templates_constant_is_list() -> None:
    assert isinstance(prompts_mod.PROMPT_TEMPLATES, list)
    assert len(prompts_mod.PROMPT_TEMPLATES) >= 3


def test_find_template_returns_none_for_unknown() -> None:
    assert prompts_mod._find_template('does-not-exist') is None


def test_find_template_returns_dict_for_known() -> None:
    result = prompts_mod._find_template('analyze-document')
    assert isinstance(result, dict)
    assert result['name'] == 'analyze-document'
