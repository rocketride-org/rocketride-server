# MIT License
# Copyright (c) 2026 Aparavi Software AG
# Tests for rocketride_mcp.server helpers.

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import rocketride_mcp.server as server_mod


def test_format_result_text_basic() -> None:
    from rocketride_mcp.server import _format_result_text

    text = _format_result_text('ToolName', '/path/to/file', {})
    assert 'ToolName' in text
    assert '/path/to/file' in text
    assert 'Sent data to pipeline' in text


def test_format_result_text_with_text_list() -> None:
    from rocketride_mcp.server import _format_result_text

    text = _format_result_text('T', 'f', {'text': ['a', 'b']})
    assert 'a' in text and 'b' in text


def test_format_result_text_with_text_str() -> None:
    from rocketride_mcp.server import _format_result_text

    text = _format_result_text('T', 'f', {'text': 'single'})
    assert 'single' in text


def test_format_result_text_non_dict_result() -> None:
    from rocketride_mcp.server import _format_result_text

    text = _format_result_text('T', 'f', {'text': 123})
    assert 'Sent data to pipeline' in text


async def test_dynamic_tools_raises_when_client_none() -> None:
    from rocketride_mcp.server import _dynamic_tools

    with patch.object(server_mod, '_client', None):
        with pytest.raises(RuntimeError, match='Client is not connected'):
            await _dynamic_tools()


async def test_handle_call_raises_when_client_none() -> None:
    from rocketride_mcp.server import _handle_call

    with patch.object(server_mod, '_client', None):
        with pytest.raises(RuntimeError, match='Client is not connected'):
            await _handle_call('ToolName', {})


async def test_handle_call_success() -> None:
    from rocketride_mcp.server import _handle_call

    mock_client = MagicMock()
    with patch.object(server_mod, '_client', mock_client):
        with patch('rocketride_mcp.server.execute_tool', new_callable=AsyncMock) as run:
            run.return_value = {'status': 200, 'result': {'text': 'ok'}}
            out = await _handle_call('MyTool', {'filepath': '/x/y'})
    assert out.get('isError') is False
    assert out['content'][0]['text']
    assert 'ok' in out['content'][0]['text']


async def test_handle_call_error_status() -> None:
    from rocketride_mcp.server import _handle_call

    mock_client = MagicMock()
    with patch.object(server_mod, '_client', mock_client):
        with patch('rocketride_mcp.server.execute_tool', new_callable=AsyncMock) as run:
            run.return_value = {'status': 404, 'result': None}
            out = await _handle_call('BadTool', {'filepath': '/x'})
    assert out.get('isError') is True
    assert 'Failed to send data' in out['content'][0]['text']
