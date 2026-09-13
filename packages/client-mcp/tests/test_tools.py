# MIT License
# Copyright (c) 2026 Aparavi Software AG
# Tests for rocketride_mcp.tools.

from pathlib import Path
from typing import Any, AsyncIterator, Optional, Sequence
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from rocketride_mcp import tools as tools_mod


# -----------------------------------------------------------------------------
# Helpers for the content/url input branches
# -----------------------------------------------------------------------------


def _client_with_task(name: str = 'MyTask') -> MagicMock:
    """Mock client whose task list contains a running pipeline named `name`."""
    client = MagicMock()
    client.build_request = MagicMock(return_value={'command': 'rrext_get_tasks'})
    client.request = AsyncMock(
        return_value={
            'body': {'tasks': [{'name': name, 'token': 'tok-1', 'pipeline': {'id': 'p1'}}]},
        }
    )
    client.send = AsyncMock(return_value={'text': 'ok'})
    return client


class _MockStream:
    """Stand-in for the async context manager returned by httpx.AsyncClient.stream()."""

    def __init__(
        self,
        chunks: Sequence[bytes] = (b'',),
        headers: Optional[dict] = None,
        status_error: Optional[Exception] = None,
    ) -> None:
        self._chunks = chunks
        self.headers = headers or {}
        self._status_error = status_error

    async def __aenter__(self) -> '_MockStream':
        return self

    async def __aexit__(self, *exc_info: Any) -> bool:
        return False

    def raise_for_status(self) -> None:
        if self._status_error:
            raise self._status_error

    async def aiter_bytes(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk


class _MockAsyncClient:
    """Stand-in for httpx.AsyncClient; yields `stream_obj` from stream()."""

    def __init__(self, stream_obj: Any, stream_error: Optional[Exception] = None) -> None:
        self._stream_obj = stream_obj
        self._stream_error = stream_error
        self.requested: list[tuple[str, str]] = []

    async def __aenter__(self) -> '_MockAsyncClient':
        return self

    async def __aexit__(self, *exc_info: Any) -> bool:
        return False

    def stream(self, method: str, url: str) -> Any:
        self.requested.append((method, url))
        if self._stream_error:
            raise self._stream_error
        return self._stream_obj


def _patch_httpx(stream_obj: Any = None, stream_error: Optional[Exception] = None) -> Any:
    """Patch httpx.AsyncClient in tools with a mock; no real network is used."""

    def factory(*_args: Any, **_kwargs: Any) -> _MockAsyncClient:
        return _MockAsyncClient(stream_obj, stream_error)

    return patch.object(tools_mod.httpx, 'AsyncClient', factory)


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
    schema = by_name['MyTask']['inputSchema']
    # Exactly-one-of is validated server-side, so nothing is schema-required.
    assert schema['required'] == []
    assert set(schema['properties']) == {'filepath', 'content', 'url', 'filename'}
    for key in ('filepath', 'content', 'url'):
        assert 'exactly one of filepath, content, or url' in schema['properties'][key]['description'].lower()
    # oneOf/anyOf break many MCP clients; the schema must stay flat.
    assert 'oneOf' not in schema and 'anyOf' not in schema


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
    mock_rocketride_client.request = AsyncMock(
        return_value={
            'body': {'tasks': [{'name': 'A'}, None, 'string', {'name': 'B'}]},
        }
    )
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


async def test_execute_tool_content_happy_path() -> None:
    client = _client_with_task()
    result = await tools_mod.execute_tool(client=client, name='MyTask', content='hello wörld')
    assert result.get('status') == 200
    assert result.get('filename') == 'content.txt'
    assert 'filepath' not in result
    token, binary_data = client.send.call_args.args
    assert token == 'tok-1'
    assert binary_data == 'hello wörld'.encode('utf-8')
    objinfo = client.send.call_args.kwargs['objinfo']
    assert objinfo == {'name': 'content.txt'}


async def test_execute_tool_content_custom_filename_and_no_strip() -> None:
    client = _client_with_task()
    result = await tools_mod.execute_tool(
        client=client,
        name='MyTask',
        content='  padded  ',
        filename='note.md',
    )
    assert result.get('status') == 200
    assert result.get('filename') == 'note.md'
    # The content itself is sent verbatim, not stripped.
    assert client.send.call_args.args[1] == b'  padded  '
    assert client.send.call_args.kwargs['objinfo'] == {'name': 'note.md'}


async def test_execute_tool_url_happy_path() -> None:
    client = _client_with_task()
    stream = _MockStream(chunks=[b'down', b'loaded'], headers={'content-length': '10'})
    with _patch_httpx(stream):
        result = await tools_mod.execute_tool(
            client=client,
            name='MyTask',
            url='https://example.com/docs/report.pdf?v=2',
        )
    assert result.get('status') == 200
    assert result.get('url') == 'https://example.com/docs/report.pdf?v=2'
    assert result.get('filename') == 'report.pdf'
    assert 'filepath' not in result
    assert client.send.call_args.args[1] == b'downloaded'
    # The engine parses an objinfo 'url' field as a pipe source, so the URL
    # must stay out of objinfo and appear only in the tool response.
    assert client.send.call_args.kwargs['objinfo'] == {'name': 'report.pdf'}


async def test_execute_tool_url_filename_fallback() -> None:
    client = _client_with_task()
    with _patch_httpx(_MockStream(chunks=[b'x'])):
        result = await tools_mod.execute_tool(client=client, name='MyTask', url='https://example.com/')
    assert result.get('status') == 200
    assert result.get('filename') == 'download'


async def test_execute_tool_url_rejects_non_http_scheme(mock_rocketride_client: MagicMock) -> None:
    result = await tools_mod.execute_tool(
        client=mock_rocketride_client,
        name='MyTask',
        url='ftp://example.com/file.txt',
    )
    assert result.get('status') == 400
    assert result.get('error') == 'URL must be http or https'


async def test_execute_tool_url_connect_error() -> None:
    client = _client_with_task()
    with _patch_httpx(stream_error=httpx.ConnectError('connection refused')):
        result = await tools_mod.execute_tool(client=client, name='MyTask', url='https://example.com/a.txt')
    assert result.get('status') == 502
    assert (result.get('error') or '').startswith('Failed to fetch URL:')
    client.send.assert_not_called()


async def test_execute_tool_url_http_error() -> None:
    client = _client_with_task()
    request = httpx.Request('GET', 'https://example.com/a.txt')
    response = httpx.Response(404, request=request)
    status_error = httpx.HTTPStatusError('not found', request=request, response=response)
    with _patch_httpx(_MockStream(status_error=status_error)):
        result = await tools_mod.execute_tool(client=client, name='MyTask', url='https://example.com/a.txt')
    assert result.get('status') == 502
    assert 'Failed to fetch URL: HTTP 404' in (result.get('error') or '')


async def test_execute_tool_url_rejects_oversized_content_length() -> None:
    client = _client_with_task()
    oversized = str(tools_mod._MAX_URL_BYTES + 1)
    with _patch_httpx(_MockStream(chunks=[b'x'], headers={'content-length': oversized})):
        result = await tools_mod.execute_tool(client=client, name='MyTask', url='https://example.com/big.bin')
    assert result.get('status') == 400
    assert result.get('error') == 'URL content exceeds 50 MB limit'
    client.send.assert_not_called()


async def test_execute_tool_url_rejects_oversized_stream() -> None:
    # Shrink the cap instead of downloading 50 MB; exercises the streamed-body check
    # for servers that send no Content-Length.
    client = _client_with_task()
    with patch.object(tools_mod, '_MAX_URL_BYTES', 4):
        with _patch_httpx(_MockStream(chunks=[b'abc', b'def'])):
            result = await tools_mod.execute_tool(client=client, name='MyTask', url='https://example.com/big.bin')
    assert result.get('status') == 400
    assert result.get('error') == 'URL content exceeds 50 MB limit'
    client.send.assert_not_called()


async def test_execute_tool_requires_one_input(mock_rocketride_client: MagicMock) -> None:
    result = await tools_mod.execute_tool(client=mock_rocketride_client, name='MyTask')
    assert result.get('status') == 400
    assert result.get('error') == 'Provide exactly one of filepath, content, or url'


async def test_execute_tool_rejects_two_inputs(
    mock_rocketride_client: MagicMock,
    tmp_path: Path,
) -> None:
    doc = tmp_path / 'doc.txt'
    doc.write_text('hello')
    result = await tools_mod.execute_tool(
        client=mock_rocketride_client,
        name='MyTask',
        filepath=str(doc),
        content='inline',
    )
    assert result.get('status') == 400
    assert result.get('error') == 'Provide exactly one of filepath, content, or url'


async def test_execute_tool_filepath_still_sends_file_bytes(tmp_path: Path) -> None:
    client = _client_with_task()
    doc = tmp_path / 'doc.txt'
    doc.write_bytes(b'file bytes')
    result = await tools_mod.execute_tool(client=client, name='MyTask', filepath=str(doc))
    assert result.get('status') == 200
    assert result.get('filepath') == str(doc.resolve())
    assert result.get('filename') == 'doc.txt'
    assert 'url' not in result
    assert client.send.call_args.args[1] == b'file bytes'
    assert client.send.call_args.kwargs['objinfo'] == {
        'name': 'doc.txt',
        'filepath': str(doc.resolve()),
    }


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
