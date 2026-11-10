"""Tests for ``tools/list`` pagination in the MCP client transports.

Covers:
- ``fetch_all_tool_entries`` (pure): cursor handling, limits, malformed pages and
  transport failures.
- All three transports against a scripted ``_request``: every page is converted,
  single-page traffic is unchanged, and refusals use the transport's own error type.
- The real stdio transport against the stub server in paged mode.
"""

import json
import os
import sys

import pytest

_NODE_SRC = os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'nodes', 'tool_mcp_client')
sys.path.insert(0, _NODE_SRC)

import mcp_sse_client  # noqa: E402
import mcp_stdio_client  # noqa: E402
import mcp_streamable_http_client  # noqa: E402
import mcp_tools_list  # noqa: E402
from mcp_schema import NOOP_ARG_NAME  # noqa: E402
from mcp_tools_list import (  # noqa: E402
    MAX_TOOLS_LIST_ENTRIES,
    MAX_TOOLS_LIST_PAGES,
    MAX_TOOLS_LIST_SECONDS,
    fetch_all_tool_entries,
)

STUB_SERVER = os.path.join(os.path.dirname(__file__), 'stub_mcp_server.py')


class _Scripted:
    """A ``request`` callable answering tools/list from a cursor -> page map and recording calls."""

    def __init__(self, pages):
        self.pages = pages  # {None: first page, 'c1': ..., '': ...}
        self.calls = []

    def __call__(self, method, params):
        self.calls.append((method, dict(params)))
        return self.pages[params.get('cursor')]


class _Endless:
    """A ``request`` callable that always offers another page behind a new cursor."""

    def __init__(self):
        self.calls = []

    def __call__(self, method, params):
        self.calls.append((method, dict(params)))
        return {'tools': [], 'nextCursor': f'c{len(self.calls)}'}


class _TransportFailure(Exception):
    """Stands in for a transport error with a keyword-only constructor and attributes (like McpHttpStatusError)."""

    def __init__(self, *, status):
        super().__init__(f'HTTP status={status}')
        self.status = status


class _Clock:
    """The helper's time-budget clock, advanced by hand."""

    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock(monkeypatch):
    c = _Clock()
    monkeypatch.setattr(mcp_tools_list, '_monotonic', c)
    return c


def _transports():
    return [
        pytest.param(mcp_stdio_client, lambda: mcp_stdio_client.McpStdioClient(command='unused', args=[]), id='stdio'),
        pytest.param(
            mcp_sse_client, lambda: mcp_sse_client.McpSseClient(sse_endpoint='http://127.0.0.1:1/sse'), id='sse'
        ),
        pytest.param(
            mcp_streamable_http_client,
            lambda: mcp_streamable_http_client.McpStreamableHttpClient(endpoint='http://127.0.0.1:1/mcp'),
            id='streamable-http',
        ),
    ]


class TestFetchAllToolEntries:
    def test_single_page_sends_one_request_with_empty_params(self):
        request = _Scripted({None: {'tools': [{'name': 'a'}]}})

        assert fetch_all_tool_entries(request) == [{'name': 'a'}]
        assert request.calls == [('tools/list', {})]

    def test_follows_next_cursor_and_keeps_server_order(self):
        request = _Scripted(
            {
                None: {'tools': ['a'], 'nextCursor': 'c1'},
                'c1': {'tools': ['b'], 'nextCursor': 'c2'},
                'c2': {'tools': ['c']},
            }
        )

        assert fetch_all_tool_entries(request) == ['a', 'b', 'c']
        assert request.calls == [
            ('tools/list', {}),
            ('tools/list', {'cursor': 'c1'}),
            ('tools/list', {'cursor': 'c2'}),
        ]

    @pytest.mark.parametrize('cursor', ['eyJwYWdlIjogM30=', ' spaced cursor ', 'κέρσορας/é'])
    def test_cursor_is_forwarded_verbatim(self, cursor):
        request = _Scripted({None: {'tools': ['a'], 'nextCursor': cursor}, cursor: {'tools': ['b']}})

        assert fetch_all_tool_entries(request) == ['a', 'b']
        assert request.calls[1] == ('tools/list', {'cursor': cursor})

    def test_empty_string_next_cursor_ends_traversal(self):
        request = _Scripted(
            {
                None: {'tools': ['a'], 'nextCursor': 'c1'},
                'c1': {'tools': ['b'], 'nextCursor': ''},
                '': {'tools': ['a'], 'nextCursor': ''},
            }
        )

        assert fetch_all_tool_entries(request) == ['a', 'b']
        assert request.calls == [('tools/list', {}), ('tools/list', {'cursor': 'c1'})]

    def test_empty_page_with_cursor_continues(self):
        request = _Scripted(
            {
                None: {'tools': ['a'], 'nextCursor': 'c1'},
                'c1': {'tools': [], 'nextCursor': 'c2'},
                'c2': {'tools': ['b']},
            }
        )

        assert fetch_all_tool_entries(request) == ['a', 'b']
        assert len(request.calls) == 3

    def test_missing_next_cursor_ends_traversal(self):
        request = _Scripted({None: {'tools': ['a']}})

        assert fetch_all_tool_entries(request) == ['a']
        assert len(request.calls) == 1

    def test_null_next_cursor_ends_traversal(self):
        request = _Scripted({None: {'tools': ['a'], 'nextCursor': None}})

        assert fetch_all_tool_entries(request) == ['a']
        assert len(request.calls) == 1

    @pytest.mark.parametrize(
        'pages, served',
        [
            pytest.param(
                {None: {'tools': [], 'nextCursor': 'c1'}, 'c1': {'tools': [], 'nextCursor': 'c1'}},
                2,
                id='same-cursor-twice',
            ),
            pytest.param(
                {
                    None: {'tools': [], 'nextCursor': 'c1'},
                    'c1': {'tools': [], 'nextCursor': 'c2'},
                    'c2': {'tools': [], 'nextCursor': 'c1'},
                },
                3,
                id='cycle',
            ),
        ],
    )
    def test_repeated_cursor_raises(self, pages, served):
        request = _Scripted(pages)

        with pytest.raises(ValueError, match='repeated'):
            fetch_all_tool_entries(request, error_cls=ValueError)
        assert len(request.calls) == served

    def test_page_limit_raises_and_stops_requesting(self):
        request = _Endless()

        with pytest.raises(ValueError, match='3 pages'):
            fetch_all_tool_entries(request, error_cls=ValueError, max_pages=3)
        assert len(request.calls) == 3

    def test_completes_exactly_at_page_limit(self):
        request = _Scripted(
            {
                None: {'tools': ['a'], 'nextCursor': 'c1'},
                'c1': {'tools': ['b'], 'nextCursor': 'c2'},
                'c2': {'tools': ['c']},
            }
        )

        assert fetch_all_tool_entries(request, max_pages=3) == ['a', 'b', 'c']
        assert len(request.calls) == 3

    def test_entry_limit_counts_raw_entries(self):
        request = _Scripted({None: {'tools': [7, 8, 9]}})

        with pytest.raises(ValueError, match='more than 2'):
            fetch_all_tool_entries(request, error_cls=ValueError, max_entries=2)

    def test_completes_exactly_at_entry_limit(self):
        request = _Scripted({None: {'tools': ['a', 'b'], 'nextCursor': 'c1'}, 'c1': {'tools': ['c']}})
        assert fetch_all_tool_entries(request, max_entries=3) == ['a', 'b', 'c']

        over = _Scripted({None: {'tools': ['a', 'b', 'c', 'd']}})
        with pytest.raises(ValueError, match='more than 3'):
            fetch_all_tool_entries(over, error_cls=ValueError, max_entries=3)

    def test_default_limits_are_the_module_constants(self):
        assert MAX_TOOLS_LIST_PAGES == 100
        assert MAX_TOOLS_LIST_ENTRIES == 5000
        assert MAX_TOOLS_LIST_SECONDS == 60.0

    def test_entry_limit_is_checked_before_the_page_is_kept(self):
        request = _Scripted(
            {None: {'tools': [{'name': 'a'}], 'nextCursor': 'c1'}, 'c1': {'tools': [{'name': 'a'}, 'x']}}
        )

        with pytest.raises(ValueError, match='more than 2 tool entries by page 2'):
            fetch_all_tool_entries(request, error_cls=ValueError, max_entries=2)

    def test_time_budget_stops_before_the_next_page(self, clock):
        calls = []

        def request(method, params):
            calls.append(dict(params))
            clock.now += 25
            return {'tools': [], 'nextCursor': f'c{len(calls)}'}

        with pytest.raises(ValueError, match='60 s budget before page 4'):
            fetch_all_tool_entries(request, error_cls=ValueError, max_seconds=60)
        assert len(calls) == 3

    def test_last_page_arriving_after_the_budget_is_kept(self, clock):
        pages = _Scripted({None: {'tools': ['a'], 'nextCursor': 'c1'}, 'c1': {'tools': ['b']}})

        def request(method, params):
            clock.now += 50
            return pages(method, params)

        assert fetch_all_tool_entries(request, max_seconds=60) == ['a', 'b']

    def test_zero_budget_still_reads_the_first_page(self, clock):
        assert fetch_all_tool_entries(_Scripted({None: {'tools': ['a']}}), max_seconds=0) == ['a']

        two_pages = _Scripted({None: {'tools': ['a'], 'nextCursor': 'c1'}, 'c1': {'tools': ['b']}})
        with pytest.raises(ValueError, match='budget before page 2'):
            fetch_all_tool_entries(two_pages, error_cls=ValueError, max_seconds=0)
        assert len(two_pages.calls) == 1

    def test_tool_name_listed_again_on_a_later_page_raises(self):
        request = _Scripted(
            {
                None: {'tools': [{'name': 'search'}, {'name': 'b'}], 'nextCursor': 'c1'},
                'c1': {'tools': [{'name': 'c'}, {'name': 'search', 'description': 'other'}]},
            }
        )

        with pytest.raises(ValueError, match="page 2 lists tool 'search' again"):
            fetch_all_tool_entries(request, error_cls=ValueError)
        assert len(request.calls) == 2

    def test_tool_name_repeated_within_one_page_is_left_to_the_caller(self):
        entries = [{'name': 'a', 'description': 'one'}, {'name': 'a', 'description': 'two'}]

        assert fetch_all_tool_entries(_Scripted({None: {'tools': entries}})) == entries

    def test_non_object_result_raises(self):
        request = _Scripted({None: {'tools': [], 'nextCursor': 'c1'}, 'c1': 'not an object'})

        with pytest.raises(ValueError, match='page 2'):
            fetch_all_tool_entries(request, error_cls=ValueError)

    def test_tools_not_a_list_raises(self):
        request = _Scripted({None: {'tools': [], 'nextCursor': 'c1'}, 'c1': {'tools': 'nope'}})

        with pytest.raises(ValueError, match='page 2'):
            fetch_all_tool_entries(request, error_cls=ValueError)

    def test_non_string_cursor_raises(self):
        request = _Scripted({None: {'tools': [], 'nextCursor': 5}})

        with pytest.raises(ValueError, match='page 1'):
            fetch_all_tool_entries(request, error_cls=ValueError)

    def test_request_error_on_a_later_page_propagates_unchanged(self):
        calls = []

        def request(method, params):
            calls.append(dict(params))
            if 'cursor' in params:
                raise _TransportFailure(status=502)
            return {'tools': ['a'], 'nextCursor': 'c1'}

        with pytest.raises(_TransportFailure) as exc:
            fetch_all_tool_entries(request, error_cls=ValueError)
        assert str(exc.value) == 'HTTP status=502'
        assert exc.value.status == 502
        assert len(calls) == 2

    def test_error_cls_is_used(self):
        with pytest.raises(ValueError):
            fetch_all_tool_entries(_Scripted({None: 'not an object'}), error_cls=ValueError)


@pytest.mark.parametrize('module, make_client', _transports())
class TestTransportsFollowPagination:
    def test_list_tools_returns_tools_from_every_page(self, module, make_client, monkeypatch):
        client = make_client()
        request = _Scripted(
            {
                None: {
                    'tools': [
                        {'name': 'first', 'inputSchema': {'type': 'object', 'properties': {'x': {'type': 'string'}}}}
                    ],
                    'nextCursor': 'c1',
                },
                'c1': {'tools': [{'name': 'second', 'inputSchema': {'type': 'object'}}, 'junk', {'description': 'x'}]},
            }
        )
        monkeypatch.setattr(client, '_request', request)

        tools = client.list_tools()

        assert [t.name for t in tools] == ['first', 'second']
        assert NOOP_ARG_NAME in tools[1].inputSchema['properties']
        assert tools[1].has_synthesized_noop_arg is True
        assert tools[0].has_synthesized_noop_arg is False

    def test_bad_later_page_raises_the_transport_protocol_error(self, module, make_client, monkeypatch):
        client = make_client()
        request = _Scripted({None: {'tools': [{'name': 'first'}], 'nextCursor': 'c1'}, 'c1': 'not an object'})
        monkeypatch.setattr(client, '_request', request)

        with pytest.raises(module.McpProtocolError, match='page 2'):
            client.list_tools()


@pytest.fixture
def paged_stub_client(tmp_path, monkeypatch):
    tools = [{'name': f'tool_{i}', 'description': f'tool {i}', 'inputSchema': {'type': 'object'}} for i in range(3)]
    path = tmp_path / 'tools.json'
    path.write_text(json.dumps(tools))
    monkeypatch.setenv('STUB_MCP_TOOLS_FILE', str(path))
    monkeypatch.setenv('STUB_MCP_PAGE_SIZE', '1')
    c = mcp_stdio_client.McpStdioClient(command=sys.executable, args=[STUB_SERVER], timeout_s=10.0)
    c.start()
    try:
        yield c
    finally:
        c.stop()


class TestStdioStubPagination:
    def test_all_pages_are_discovered_over_stdio(self, paged_stub_client):
        assert {t.name for t in paged_stub_client.list_tools()} == {'tool_0', 'tool_1', 'tool_2'}

    def test_tool_on_the_last_page_is_callable(self, paged_stub_client):
        result = paged_stub_client.call_tool(name='tool_2', arguments={})
        assert result['content'][0]['text'] == 'called tool_2'

    def test_tool_listed_again_on_a_later_page_is_refused_over_stdio(self, tmp_path, monkeypatch):
        tools = [{'name': name, 'inputSchema': {'type': 'object'}} for name in ('tool_0', 'tool_1', 'tool_0')]
        path = tmp_path / 'tools.json'
        path.write_text(json.dumps(tools))
        monkeypatch.setenv('STUB_MCP_TOOLS_FILE', str(path))
        monkeypatch.setenv('STUB_MCP_PAGE_SIZE', '1')
        client = mcp_stdio_client.McpStdioClient(command=sys.executable, args=[STUB_SERVER], timeout_s=10.0)
        client.start()
        try:
            with pytest.raises(mcp_stdio_client.McpProtocolError, match="page 3 lists tool 'tool_0' again"):
                client.list_tools()
        finally:
            client.stop()
