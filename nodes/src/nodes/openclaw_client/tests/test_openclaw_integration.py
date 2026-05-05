"""
Integration test suite for the openclaw_client node.

Tests against a LIVE OpenClaw gateway running at ws://127.0.0.1:18789.
Start the gateway before running:
    openclaw gateway --port 18789

Run with:
    python -m pytest nodes/src/nodes/openclaw_client/tests/test_openclaw_integration.py -v
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

import pytest

# ---------------------------------------------------------------------------
# Gateway config
# ---------------------------------------------------------------------------
GATEWAY_WS_URL = os.environ.get('OPENCLAW_WS_URL', 'ws://127.0.0.1:18789')
GATEWAY_HTTP_URL = os.environ.get('OPENCLAW_HTTP_URL', 'http://127.0.0.1:18789')
GATEWAY_TOKEN = os.environ.get('OPENCLAW_GATEWAY_TOKEN', 'rocketride-test-token-2026')


def _http_invoke(tool: str, args: dict, session_key: str = 'main') -> dict:
    """Invoke a tool via HTTP POST /tools/invoke."""
    url = f'{GATEWAY_HTTP_URL}/tools/invoke'
    payload = json.dumps(
        {
            'tool': tool,
            'args': args,
            'sessionKey': session_key,
        }
    ).encode('utf-8')
    headers = {
        'Authorization': f'Bearer {GATEWAY_TOKEN}',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }
    req = urllib.request.Request(url, data=payload, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        try:
            return json.loads(body)
        except Exception:
            return {'ok': False, 'error': {'type': 'http_error', 'message': f'HTTP {e.code}: {body[:200]}'}}


def _gateway_healthy() -> bool:
    """Check if the gateway is reachable."""
    try:
        req = urllib.request.Request(f'{GATEWAY_HTTP_URL}/health')
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return data.get('ok', False)
    except Exception:
        return False


# Skip all tests if gateway is not running
pytestmark = pytest.mark.skipif(
    not _gateway_healthy(),
    reason=f'OpenClaw gateway not reachable at {GATEWAY_HTTP_URL}',
)


# ===================================================================
# 1. TRANSPORT LAYER TESTS
# ===================================================================


class TestTransportHTTP:
    """Test HTTP transport (POST /tools/invoke)."""

    def test_health_endpoint(self):
        """Gateway /health returns ok."""
        req = urllib.request.Request(f'{GATEWAY_HTTP_URL}/health')
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        assert data['ok'] is True
        assert data['status'] == 'live'

    def test_auth_required(self):
        """Requests without auth are rejected."""
        url = f'{GATEWAY_HTTP_URL}/tools/invoke'
        payload = json.dumps({'tool': 'sessions_list', 'args': {}}).encode('utf-8')
        req = urllib.request.Request(url, data=payload, headers={'Content-Type': 'application/json'}, method='POST')
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(req, timeout=10)
        assert exc_info.value.code == 401

    def test_bad_token_rejected(self):
        """Requests with wrong token are rejected."""
        url = f'{GATEWAY_HTTP_URL}/tools/invoke'
        payload = json.dumps({'tool': 'sessions_list', 'args': {}}).encode('utf-8')
        headers = {'Authorization': 'Bearer wrong-token', 'Content-Type': 'application/json'}
        req = urllib.request.Request(url, data=payload, headers=headers, method='POST')
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            urllib.request.urlopen(req, timeout=10)
        assert exc_info.value.code == 401

    def test_unknown_tool_returns_404(self):
        """Invoking a non-existent tool returns not_found."""
        result = _http_invoke('nonexistent_tool_xyz', {})
        assert result['ok'] is False
        assert result['error']['type'] == 'not_found'

    def test_valid_tool_returns_ok(self):
        """Invoking a valid tool returns ok response."""
        result = _http_invoke('sessions_list', {'action': 'json'})
        assert result['ok'] is True
        assert 'result' in result


class TestTransportWebSocket:
    """Test WebSocket transport (connect + RPC)."""

    def test_websocket_connect_and_handshake(self):
        """Connect to gateway via WebSocket and complete handshake."""
        from websockets.sync.client import connect

        ws = connect(GATEWAY_WS_URL)
        try:
            # Should receive connect.challenge event
            raw = ws.recv(timeout=10)
            frame = json.loads(raw)
            assert frame['type'] == 'event'
            assert frame['event'] == 'connect.challenge'

            # Send connect request
            ws.send(
                json.dumps(
                    {
                        'type': 'req',
                        'id': 'test-1',
                        'method': 'connect',
                        'params': {
                            'auth': {'token': GATEWAY_TOKEN},
                            'client': {'name': 'pytest', 'version': '1.0'},
                        },
                    }
                )
            )

            # Should receive success response
            raw = ws.recv(timeout=10)
            resp = json.loads(raw)
            assert resp['type'] == 'res'
            assert resp['id'] == 'test-1'
            assert resp['ok'] is True
        finally:
            ws.close()

    def test_tools_catalog_rpc(self):
        """Discover tools via tools.catalog RPC."""
        from websockets.sync.client import connect

        ws = connect(GATEWAY_WS_URL)
        try:
            # Handshake
            ws.recv(timeout=10)  # challenge
            ws.send(
                json.dumps(
                    {
                        'type': 'req',
                        'id': 'h1',
                        'method': 'connect',
                        'params': {'auth': {'token': GATEWAY_TOKEN}, 'client': {'name': 'pytest', 'version': '1.0'}},
                    }
                )
            )
            ws.recv(timeout=10)  # connect response

            # Request tools catalog
            ws.send(
                json.dumps(
                    {
                        'type': 'req',
                        'id': 'tc1',
                        'method': 'tools.catalog',
                        'params': {'includePlugins': True},
                    }
                )
            )
            # Loop until we find the response frame — the gateway may send
            # health or other event frames before the tools.catalog response.
            resp = None
            for _ in range(10):
                raw = ws.recv(timeout=10)
                f = json.loads(raw)
                if f.get('id') == 'tc1':
                    resp = f
                    break
            assert resp is not None, 'Did not receive tools.catalog response'

            assert resp['type'] == 'res'
            assert resp['ok'] is True
            payload = resp['payload']
            assert 'groups' in payload
            groups = payload['groups']
            assert isinstance(groups, list)
            assert len(groups) > 0

            # Verify known groups exist
            group_ids = {g['id'] for g in groups}
            assert 'group:web' in group_ids or 'web' in group_ids
        finally:
            ws.close()


# ===================================================================
# 2. DRIVER TESTS (unit tests with mock data)
# ===================================================================


class TestOpenClawDriver:
    """Test the OpenClawDriver ToolsBase adapter."""

    def _make_driver(self, tools=None, invoke_fn=None):
        # Import from the node package
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
        from openclaw_driver import OpenClawDriver

        if tools is None:
            tools = [
                {'name': 'web_search', 'description': 'Search the web', 'inputSchema': {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query']}},
                {'name': 'browser', 'description': 'Control browser', 'inputSchema': {'type': 'object', 'properties': {'action': {'type': 'string'}}, 'required': ['action']}},
                {'name': 'message', 'description': 'Send message', 'inputSchema': {'type': 'object'}},
            ]
        if invoke_fn is None:

            def invoke_fn(name, args, sk):  # noqa: D103
                return {'mocked': True, 'tool': name, 'args': args}

        return OpenClawDriver(server_name='openclaw', tools=tools, invoke_fn=invoke_fn)

    def test_tool_query_returns_namespaced_tools(self):
        driver = self._make_driver()
        tools = driver._tool_query()
        assert len(tools) == 3
        names = {t['name'] for t in tools}
        assert 'openclaw.web_search' in names
        assert 'openclaw.browser' in names
        assert 'openclaw.message' in names

    def test_tool_query_includes_description_and_schema(self):
        driver = self._make_driver()
        tools = driver._tool_query()
        ws = next(t for t in tools if t['name'] == 'openclaw.web_search')
        assert ws['description'] == 'Search the web'
        assert ws['inputSchema']['required'] == ['query']

    def test_tool_validate_passes_valid_input(self):
        driver = self._make_driver()
        # Should not raise
        driver._tool_validate(tool_name='openclaw.web_search', input_obj={'query': 'test'})

    def test_tool_validate_rejects_missing_required(self):
        driver = self._make_driver()
        with pytest.raises(ValueError, match='missing required'):
            driver._tool_validate(tool_name='openclaw.web_search', input_obj={})

    def test_tool_validate_rejects_unknown_tool(self):
        driver = self._make_driver()
        with pytest.raises(ValueError, match='Unknown tool'):
            driver._tool_validate(tool_name='openclaw.nonexistent', input_obj={})

    def test_tool_validate_rejects_bad_namespace(self):
        driver = self._make_driver()
        with pytest.raises(ValueError, match='namespaced'):
            driver._tool_validate(tool_name='web_search', input_obj={})

    def test_tool_invoke_calls_invoke_fn(self):
        called_with = {}

        def capture_invoke(name, args, sk):
            called_with.update({'name': name, 'args': args, 'sk': sk})
            return {'ok': True}

        driver = self._make_driver(invoke_fn=capture_invoke)
        result = driver._tool_invoke(tool_name='openclaw.web_search', input_obj={'query': 'test'})
        assert result == {'ok': True}
        assert called_with['name'] == 'web_search'
        assert called_with['args'] == {'query': 'test'}

    def test_tool_invoke_strips_framework_keys(self):
        called_with = {}

        def capture_invoke(name, args, sk):
            called_with['args'] = args
            return {'ok': True}

        driver = self._make_driver(invoke_fn=capture_invoke)
        driver._tool_invoke(
            tool_name='openclaw.web_search',
            input_obj={'query': 'test', 'security_context': 'should-be-stripped'},
        )
        assert 'security_context' not in called_with['args']
        assert called_with['args'] == {'query': 'test'}

    def test_empty_tools_list(self):
        driver = self._make_driver(tools=[])
        tools = driver._tool_query()
        assert tools == []

    def test_permissive_schema_for_missing_input_schema(self):
        driver = self._make_driver(
            tools=[
                {'name': 'mytool', 'description': 'No schema'},
            ]
        )
        tools = driver._tool_query()
        assert tools[0]['inputSchema'] == {'type': 'object', 'additionalProperties': True}


# ===================================================================
# 3. GROUP:WEB TOGGLE TESTS
# ===================================================================


class TestGroupWeb:
    """Test web tools (web_search) via live gateway."""

    def test_web_search_returns_results(self):
        """web_search should return search results."""
        result = _http_invoke('web_search', {'query': 'python programming language'})
        assert result['ok'] is True
        content = result['result']['content']
        assert len(content) > 0
        text = content[0].get('text', '')
        assert len(text) > 50  # Should have substantial content

    def test_web_search_returns_structured_results(self):
        """web_search should return results with details."""
        result = _http_invoke('web_search', {'query': 'OpenClaw github'})
        assert result['ok'] is True
        details = result['result'].get('details', {})
        assert 'results' in details
        assert details.get('count', 0) > 0

    def test_web_fetch_works(self):
        """web_fetch should fetch page content (even though it's in our deny list by default)."""
        result = _http_invoke('web_fetch', {'url': 'https://httpbin.org/get', 'format': 'text'})
        assert result['ok'] is True
        text = result['result']['content'][0]['text']
        assert 'httpbin' in text.lower() or 'origin' in text.lower()


# ===================================================================
# 4. GROUP:MESSAGING TOGGLE TESTS
# ===================================================================


class TestGroupMessaging:
    """Test messaging tools via live gateway."""

    def test_message_tool_exists(self):
        """Message tool should be available (even without channels configured)."""
        # Try a safe action that doesn't require channels
        result = _http_invoke('message', {'action': 'search', 'query': 'test'})
        # May fail due to no channels, but should NOT be 'not_found'
        if not result['ok']:
            assert result['error']['type'] != 'not_found', 'message tool should exist even without channels'


# ===================================================================
# 5. GROUP:UI TOGGLE TESTS
# ===================================================================


class TestGroupUi:
    """Test browser/UI tools via live gateway."""

    def test_browser_status(self):
        """Browser tool status action should work."""
        result = _http_invoke('browser', {'action': 'status'})
        assert result['ok'] is True
        text = result['result']['content'][0]['text']
        data = json.loads(text)
        assert 'enabled' in data
        assert 'running' in data

    def test_browser_start_and_stop(self):
        """Browser start/stop lifecycle should work."""
        # Start browser
        result = _http_invoke('browser', {'action': 'start'})
        # May fail if no display, but shouldn't be not_found
        if result['ok']:
            time.sleep(2)
            # Check status
            status = _http_invoke('browser', {'action': 'status'})
            assert status['ok'] is True
            # Stop browser
            stop = _http_invoke('browser', {'action': 'stop'})
            assert stop['ok'] is True


# ===================================================================
# 6. GROUP:SKILLS TOGGLE TESTS
# ===================================================================


class TestGroupSkills:
    """Test skill/plugin-provided tools."""

    def test_agents_list_works(self):
        """agents_list tool should return agent list."""
        result = _http_invoke('agents_list', {})
        assert result['ok'] is True


# ===================================================================
# 7. GROUP:SESSIONS TOGGLE TESTS
# ===================================================================


class TestGroupSessions:
    """Test session tools via live gateway."""

    def test_sessions_list(self):
        """sessions_list should return session data."""
        result = _http_invoke('sessions_list', {'action': 'json'})
        assert result['ok'] is True
        details = result['result'].get('details', {})
        assert 'sessions' in details

    def test_sessions_history(self):
        """sessions_history should work for main session."""
        result = _http_invoke('sessions_history', {'sessionKey': 'agent:main:main', 'action': 'json'})
        # May return empty but should succeed
        assert result['ok'] is True


# ===================================================================
# 8. GATEWAY-DENIED TOOLS TESTS
# ===================================================================


class TestGatewayDeniedTools:
    """Verify tools blocked by gateway HTTP deny list return not_found."""

    @pytest.mark.parametrize(
        'tool_name',
        [
            'exec',
            'read',
            'write',
            'edit',
            'apply_patch',
            'process',
            'cron',
            'gateway',
        ],
    )
    def test_denied_tool_returns_not_found(self, tool_name):
        """Tools on the gateway HTTP deny list should return not_found."""
        result = _http_invoke(tool_name, {})
        assert result['ok'] is False
        assert result['error']['type'] == 'not_found', f'{tool_name} should be blocked by gateway HTTP deny list, got: {result["error"]}'


# ===================================================================
# 9. GROUP:MEMORY TOGGLE TESTS
# ===================================================================


class TestGroupMemory:
    """Test memory tools via live gateway."""

    def test_memory_search(self):
        """memory_search should work (may return empty)."""
        result = _http_invoke('memory_search', {'query': 'test query'})
        assert result['ok'] is True

    def test_memory_get_handles_missing(self):
        """memory_get for non-existent path should handle gracefully."""
        result = _http_invoke('memory_get', {'path': 'nonexistent/path.md'})
        # Should either succeed with empty or fail gracefully
        assert isinstance(result, dict)


# ===================================================================
# 10. OVERLAP FILTERING + DENY LIST TESTS (unit tests)
# ===================================================================


class TestOverlapFiltering:
    """Test the IGlobal._filter_tools static method with mock catalog data."""

    def _get_filter_fn(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
        from IGlobal import IGlobal

        return IGlobal._filter_tools

    def _mock_catalog(self):
        """Return a mock tools.catalog response."""
        return [
            {
                'id': 'group:web',
                'label': 'Web',
                'tools': [
                    {'id': 'web_search', 'label': 'Search the web'},
                    {'id': 'web_fetch', 'label': 'Fetch web content'},
                ],
            },
            {
                'id': 'group:fs',
                'label': 'Files',
                'tools': [
                    {'id': 'read', 'label': 'Read file'},
                    {'id': 'write', 'label': 'Write file'},
                    {'id': 'edit', 'label': 'Edit file'},
                    {'id': 'apply_patch', 'label': 'Patch files'},
                ],
            },
            {
                'id': 'group:runtime',
                'label': 'Runtime',
                'tools': [
                    {'id': 'exec', 'label': 'Run shell commands'},
                    {'id': 'process', 'label': 'Manage processes'},
                ],
            },
            {
                'id': 'group:ui',
                'label': 'UI',
                'tools': [
                    {'id': 'browser', 'label': 'Control browser'},
                    {'id': 'canvas', 'label': 'Control canvas'},
                ],
            },
            {
                'id': 'group:messaging',
                'label': 'Messaging',
                'tools': [
                    {'id': 'message', 'label': 'Send messages'},
                ],
            },
            {
                'id': 'group:memory',
                'label': 'Memory',
                'tools': [
                    {'id': 'memory_search', 'label': 'Search memory'},
                    {'id': 'memory_get', 'label': 'Get memory'},
                ],
            },
            {
                'id': 'group:sessions',
                'label': 'Sessions',
                'tools': [
                    {'id': 'sessions_list', 'label': 'List sessions'},
                    {'id': 'sessions_history', 'label': 'Session history'},
                    {'id': 'sessions_send', 'label': 'Send to session'},
                    {'id': 'sessions_spawn', 'label': 'Spawn sub-agent'},
                ],
            },
            {
                'id': 'group:automation',
                'label': 'Automation',
                'tools': [
                    {'id': 'cron', 'label': 'Schedule tasks'},
                    {'id': 'gateway', 'label': 'Gateway control'},
                ],
            },
            {
                'id': 'group:nodes',
                'label': 'Nodes',
                'tools': [
                    {'id': 'nodes', 'label': 'Nodes and devices'},
                ],
            },
            {
                'id': 'skill:github',
                'label': 'GitHub',
                'tools': [
                    {'id': 'github_pr', 'label': 'Manage PRs'},
                    {'id': 'github_issues', 'label': 'Manage issues'},
                ],
            },
            {
                'id': 'plugin:firecrawl',
                'label': 'Firecrawl',
                'tools': [
                    {'id': 'firecrawl_scrape', 'label': 'Scrape web page'},
                    {'id': 'firecrawl_search', 'label': 'Search web via Firecrawl'},
                ],
            },
        ]

    def test_default_config_filters_correctly(self):
        """With default config: web+messaging+ui+skills ON, others OFF."""
        filter_tools = self._get_filter_fn()
        enabled = {
            'group:web': True,
            'group:fs': False,
            'group:runtime': False,
            'group:ui': True,
            'group:messaging': True,
            'group:memory': False,
            'group:automation': False,
            'group:sessions': False,
            'group:nodes': False,
            '__skills__': True,
        }
        # Default deny list from services.json
        deny = {'web_fetch', 'firecrawl_scrape', 'firecrawl_search'}

        tools = filter_tools(self._mock_catalog(), enabled, deny)
        names = {t['name'] for t in tools}

        # Should include
        assert 'web_search' in names, 'web_search should be included'
        assert 'browser' in names, 'browser should be included'
        assert 'canvas' in names, 'canvas should be included'
        assert 'message' in names, 'message should be included'
        assert 'github_pr' in names, 'skill tools should be included'
        assert 'github_issues' in names, 'skill tools should be included'

        # Should NOT include (denied by deny list)
        assert 'web_fetch' not in names, 'web_fetch should be denied (overlaps with Firecrawl)'
        assert 'firecrawl_scrape' not in names, 'firecrawl_scrape should be denied (overlaps with tool_firecrawl)'
        assert 'firecrawl_search' not in names, 'firecrawl_search should be denied (overlaps with tool_firecrawl)'

        # Should NOT include (gateway HTTP denied)
        assert 'exec' not in names, 'exec should be filtered (gateway denied + group off)'
        assert 'read' not in names, 'read should be filtered (gateway denied + group off)'
        assert 'cron' not in names, 'cron should be filtered (gateway denied + group off)'

        # Should NOT include (group disabled)
        assert 'memory_search' not in names, 'memory tools should be excluded (group off)'
        assert 'sessions_list' not in names, 'session tools should be excluded (group off)'
        assert 'nodes' not in names, 'nodes should be excluded (group off)'

    def test_all_groups_enabled_with_gateway_deny(self):
        """Even with all groups ON, gateway-denied tools are filtered out."""
        filter_tools = self._get_filter_fn()
        enabled = {
            'group:web': True,
            'group:fs': True,
            'group:runtime': True,
            'group:ui': True,
            'group:messaging': True,
            'group:memory': True,
            'group:automation': True,
            'group:sessions': True,
            'group:nodes': True,
            '__skills__': True,
        }
        deny = set()  # No user deny list

        tools = filter_tools(self._mock_catalog(), enabled, deny)
        names = {t['name'] for t in tools}

        # Gateway-denied should still be filtered
        assert 'exec' not in names
        assert 'read' not in names
        assert 'write' not in names
        assert 'cron' not in names
        assert 'gateway' not in names
        assert 'sessions_spawn' not in names
        assert 'sessions_send' not in names

        # Non-denied should pass through
        assert 'web_search' in names
        assert 'web_fetch' in names  # No user deny, group enabled
        assert 'browser' in names
        assert 'message' in names
        assert 'memory_search' in names
        assert 'sessions_list' in names  # Not in gateway deny list
        assert 'sessions_history' in names
        assert 'nodes' in names

    def test_deny_list_blocks_specific_tools(self):
        """User deny list removes specific tools."""
        filter_tools = self._get_filter_fn()
        enabled = {
            'group:web': True,
            'group:messaging': True,
            'group:fs': False,
            'group:runtime': False,
            'group:ui': False,
            'group:memory': False,
            'group:automation': False,
            'group:sessions': False,
            'group:nodes': False,
            '__skills__': True,
        }
        deny = {'web_search', 'github_pr'}

        tools = filter_tools(self._mock_catalog(), enabled, deny)
        names = {t['name'] for t in tools}

        assert 'web_search' not in names, 'Denied by user'
        assert 'github_pr' not in names, 'Denied by user'
        assert 'web_fetch' in names, 'Not denied, group enabled'
        assert 'github_issues' in names, 'Not denied, skills enabled'

    def test_skills_off_hides_plugin_tools(self):
        """With skills toggle OFF, plugin/skill groups are hidden."""
        filter_tools = self._get_filter_fn()
        enabled = {
            'group:web': True,
            'group:messaging': True,
            'group:fs': False,
            'group:runtime': False,
            'group:ui': False,
            'group:memory': False,
            'group:automation': False,
            'group:sessions': False,
            'group:nodes': False,
            '__skills__': False,
        }
        deny = set()

        tools = filter_tools(self._mock_catalog(), enabled, deny)
        names = {t['name'] for t in tools}

        assert 'github_pr' not in names, 'Skills OFF should hide skill tools'
        assert 'firecrawl_scrape' not in names, 'Skills OFF should hide plugin tools'
        assert 'web_search' in names, 'Core groups still work'

    def test_empty_catalog_returns_empty(self):
        """Empty catalog returns no tools."""
        filter_tools = self._get_filter_fn()
        enabled = {'group:web': True, '__skills__': True}
        tools = filter_tools([], enabled, set())
        assert tools == []


# ===================================================================
# 11. OPENCLAW CLIENT TRANSPORT TESTS (live)
# ===================================================================


class TestOpenClawClientLive:
    """Test the OpenClawClient class against live gateway."""

    def _make_client(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
        from openclaw_client import OpenClawClient

        return OpenClawClient(
            ws_url=GATEWAY_WS_URL,
            http_url=GATEWAY_HTTP_URL,
            token=GATEWAY_TOKEN,
        )

    def test_client_connect_and_disconnect(self):
        """Client can connect and disconnect cleanly."""
        client = self._make_client()
        client.start()
        assert client._connected is True
        client.stop()
        assert client._connected is False

    def test_client_discover_tools(self):
        """Client can discover tools via tools.catalog."""
        client = self._make_client()
        try:
            client.start()
            groups = client.discover_tools()
            assert isinstance(groups, list)
            assert len(groups) > 0
            # Each group should have id, label, tools
            for g in groups:
                assert 'id' in g
                assert 'tools' in g
        finally:
            client.stop()

    def test_client_invoke_tool_http(self):
        """Client can invoke tools via HTTP."""
        client = self._make_client()
        try:
            client.start()
            result = client.invoke_tool('sessions_list', {'action': 'json'})
            assert isinstance(result, dict)
            assert 'content' in result
        finally:
            client.stop()

    def test_client_invoke_nonexistent_tool(self):
        """Client raises on non-existent tool invocation."""
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
        from openclaw_client import OpenClawProtocolError

        client = self._make_client()
        try:
            client.start()
            with pytest.raises((OpenClawProtocolError, Exception)):
                client.invoke_tool('definitely_not_a_real_tool', {})
        finally:
            client.stop()


# ===================================================================
# 12. END-TO-END: FULL PIPELINE SIMULATION
# ===================================================================


class TestEndToEnd:
    """Simulate the full node pipeline: discover → filter → invoke."""

    def test_full_pipeline_web_search(self):
        """Simulate: connect → discover → filter → invoke web_search."""
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
        from openclaw_client import OpenClawClient
        from openclaw_driver import OpenClawDriver
        from IGlobal import IGlobal

        client = OpenClawClient(
            ws_url=GATEWAY_WS_URL,
            http_url=GATEWAY_HTTP_URL,
            token=GATEWAY_TOKEN,
        )
        try:
            client.start()

            # Discover
            catalog = client.discover_tools()
            assert len(catalog) > 0

            # Filter (default config)
            enabled = {
                'group:web': True,
                'group:fs': False,
                'group:runtime': False,
                'group:ui': True,
                'group:messaging': True,
                'group:memory': False,
                'group:automation': False,
                'group:sessions': False,
                'group:nodes': False,
                '__skills__': True,
            }
            deny = {'web_fetch', 'firecrawl_scrape', 'firecrawl_search'}
            filtered = IGlobal._filter_tools(catalog, enabled, deny)
            assert len(filtered) > 0

            # Check web_search made it through
            web_search = next((t for t in filtered if t['name'] == 'web_search'), None)
            assert web_search is not None, 'web_search should survive filtering'

            # Create driver
            driver = OpenClawDriver(
                server_name='openclaw',
                tools=filtered,
                invoke_fn=client.invoke_tool,
            )

            # Query tools
            tool_descriptors = driver._tool_query()
            assert any(t['name'] == 'openclaw.web_search' for t in tool_descriptors)

            # Invoke web_search
            result = driver._tool_invoke(
                tool_name='openclaw.web_search',
                input_obj={'query': 'pytest testing framework'},
            )
            assert isinstance(result, dict)
            assert 'content' in result

        finally:
            client.stop()

    def test_full_pipeline_browser_status(self):
        """Simulate: connect → discover → filter → invoke browser status."""
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
        from openclaw_client import OpenClawClient
        from openclaw_driver import OpenClawDriver
        from IGlobal import IGlobal

        client = OpenClawClient(
            ws_url=GATEWAY_WS_URL,
            http_url=GATEWAY_HTTP_URL,
            token=GATEWAY_TOKEN,
        )
        try:
            client.start()
            catalog = client.discover_tools()
            enabled = {
                'group:web': True,
                'group:ui': True,
                'group:messaging': True,
                'group:fs': False,
                'group:runtime': False,
                'group:memory': False,
                'group:automation': False,
                'group:sessions': False,
                'group:nodes': False,
                '__skills__': True,
            }
            filtered = IGlobal._filter_tools(catalog, enabled, set())

            driver = OpenClawDriver(
                server_name='openclaw',
                tools=filtered,
                invoke_fn=client.invoke_tool,
            )

            # Invoke browser status
            result = driver._tool_invoke(
                tool_name='openclaw.browser',
                input_obj={'action': 'status'},
            )
            assert isinstance(result, dict)
            text = result['content'][0]['text']
            data = json.loads(text)
            assert 'enabled' in data
        finally:
            client.stop()
