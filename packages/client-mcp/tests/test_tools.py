# MIT License
# Copyright (c) 2026 RocketRide, Inc.
# Tests for rocketride_mcp.tools.

from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from rocketride_mcp import tools as tools_mod


def test_format_tools_empty() -> None:
    result = tools_mod.format_tools([])
    assert isinstance(result, list)
    names = [t['name'] for t in result]
    assert 'RocketRide_Document_Processor' in names
    for t in result:
        assert 'name' in t
        assert 'description' in t
        assert t.get('inputSchema', {}).get('properties', {}).get('filepath') is not None


def test_format_tools_from_tasks() -> None:
    tasks = [
        {'name': 'MyTask', 'description': 'My task description'},
    ]
    result = tools_mod.format_tools(tasks)
    by_name = {t['name']: t for t in result}
    assert 'MyTask' in by_name
    assert by_name['MyTask']['description'] == 'My task description'
    assert by_name['MyTask']['inputSchema']['required'] == ['filepath']


async def test_get_tools_empty_response(mock_rocketride_client: MagicMock) -> None:
    mock_rocketride_client.request = AsyncMock(return_value={})
    result = await tools_mod.get_tools(mock_rocketride_client)
    assert result == []


async def test_get_tools_body_empty(mock_rocketride_client: MagicMock) -> None:
    mock_rocketride_client.request = AsyncMock(return_value={'body': {}})
    result = await tools_mod.get_tools(mock_rocketride_client)
    assert result == []


async def test_get_tools_non_list_tasks(mock_rocketride_client: MagicMock) -> None:
    mock_rocketride_client.request = AsyncMock(return_value={'body': {'tasks': 'not-a-list'}})
    result = await tools_mod.get_tools(mock_rocketride_client)
    assert result == []


async def test_get_tools_success(mock_rocketride_client: MagicMock) -> None:
    result = await tools_mod.get_tools(mock_rocketride_client)
    assert len(result) == 2
    assert result[0]['name'] == 'Task1'
    assert result[1]['name'] == 'Task2'


async def test_get_tools_filters_non_dicts(mock_rocketride_client: MagicMock) -> None:
    mock_rocketride_client.request = AsyncMock(return_value={
        'body': {'tasks': [{'name': 'A'}, None, 'string', {'name': 'B'}]},
    })
    result = await tools_mod.get_tools(mock_rocketride_client)
    assert len(result) == 2
    assert result[0]['name'] == 'A'
    assert result[1]['name'] == 'B'


async def test_execute_tool_missing_filepath(mock_rocketride_client: MagicMock) -> None:
    result = await tools_mod.execute_tool(
        client=mock_rocketride_client,
        filepath=None,
        name='SomeTool',
    )
    assert result.get('status') == 400
    assert 'filepath' in (result.get('error') or '').lower()


async def test_execute_tool_blank_filepath(mock_rocketride_client: MagicMock) -> None:
    result = await tools_mod.execute_tool(
        client=mock_rocketride_client,
        filepath='   ',
        name='SomeTool',
    )
    assert result.get('status') == 400


async def test_execute_tool_invalid_filepath(mock_rocketride_client: MagicMock) -> None:
    result = await tools_mod.execute_tool(
        client=mock_rocketride_client,
        filepath='/nonexistent/path/12345/file.txt',
        name='SomeTool',
    )
    assert result.get('status') == 400
    assert 'Invalid' in (result.get('error') or '')


async def test_execute_tool_path_not_file(
    mock_rocketride_client: MagicMock,
    tmp_path: Path,
) -> None:
    # tmp_path is a directory
    result = await tools_mod.execute_tool(
        client=mock_rocketride_client,
        filepath=str(tmp_path),
        name='SomeTool',
    )
    assert result.get('status') == 400
    assert 'file' in (result.get('error') or '').lower()


async def test_execute_tool_tool_not_found(
    mock_rocketride_client: MagicMock,
    tmp_path: Path,
) -> None:
    mock_rocketride_client.request = AsyncMock(return_value={'body': {'tasks': []}})
    (tmp_path / 'doc.txt').write_text('hello')
    result = await tools_mod.execute_tool(
        client=mock_rocketride_client,
        filepath=str(tmp_path / 'doc.txt'),
        name='NonExistentTool',
    )
    assert result.get('status') == 404
    assert 'not found' in (result.get('error') or '').lower()


def test_load_pipeline_json_found() -> None:
    out = tools_mod._load_pipeline_json('simpleparser.json')
    assert out is not None
    assert isinstance(out, dict)
    assert 'pipeline' in out or 'source' in str(out)


def test_load_pipeline_json_not_found() -> None:
    out = tools_mod._load_pipeline_json('does_not_exist_12345.json')
    assert out is None


def test_load_convenience_pipeline_unknown_tool() -> None:
    assert tools_mod._load_convenience_pipeline(None) is None
    assert tools_mod._load_convenience_pipeline('Unknown_Tool') is None


def test_load_convenience_pipeline_known_tool() -> None:
    out = tools_mod._load_convenience_pipeline('RocketRide_Document_Processor')
    assert out is not None
    assert isinstance(out, dict)


# -----------------------------------------------------------------------------
# Integration tests (run when server is available; use real RocketRideClient)
# -----------------------------------------------------------------------------

@pytest.mark.requires_server
async def test_get_tools_live_client(client: Any) -> None:
    """When server is available, get_tools returns task list; format_tools shapes them."""
    tasks = await tools_mod.get_tools(client)
    formatted = tools_mod.format_tools(tasks)
    assert isinstance(formatted, list)
    for entry in formatted:
        assert 'name' in entry
        assert 'inputSchema' in entry
        assert entry['inputSchema'].get('properties', {}).get('filepath') is not None
