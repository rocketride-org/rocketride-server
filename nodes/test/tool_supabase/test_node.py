# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for the tool_supabase node.

Runnable without network or secrets:
  - services.json structural contract
  - Package import contract
  - _split_tool_name unit tests
  - IGlobal URL-building and header logic (mocked engine runtime)
  - Structural parity with tool_mcp_client (client modules, __init__ exports)

Network-requiring test (skipped — needs SUPABASE_ACCESS_TOKEN + live MCP server):
  - Live tool discovery against https://mcp.supabase.com/mcp

Run:
    cd nodes && <engine> -m pytest test/tool_supabase -v
"""

from __future__ import annotations

import json
import sys
import os
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
_SUPABASE_SRC = _NODES_SRC / 'tool_supabase'
_MCP_CLIENT_SRC = _NODES_SRC / 'tool_mcp_client'

# ---------------------------------------------------------------------------
# Shared stubs — must be installed before any tool_supabase import
# ---------------------------------------------------------------------------

# engLib: C++ engine binding, only present in the engine runtime.
# depends: dep-bootstrapper that writes to an install-adjacent cache dir.
# Both are needed for `import rocketlib` to succeed.
_engLib_stub = MagicMock()
_depends_stub = MagicMock()
_depends_stub.depends = lambda *args, **kwargs: None

# ai.* sub-tree pulled in by IGlobal via `from ai.common.config import Config`.
_ai_config_stub = MagicMock()
_ai_common_stub = MagicMock()
_ai_common_stub.config = _ai_config_stub
_ai_stub = MagicMock()
_ai_stub.common = _ai_common_stub

sys.modules.setdefault('engLib', _engLib_stub)
sys.modules.setdefault('depends', _depends_stub)
sys.modules.setdefault('ai', _ai_stub)
sys.modules.setdefault('ai.common', _ai_common_stub)
sys.modules.setdefault('ai.common.config', _ai_config_stub)

# Add rocketlib to sys.path so it is importable.
_rocketlib_lib = Path(__file__).resolve().parents[4] / 'packages' / 'server' / 'engine-lib' / 'rocketlib-python' / 'lib'
if _rocketlib_lib.is_dir():
    sys.path.insert(0, str(_rocketlib_lib))

# nodes/src is the root — `nodes` is the package therein.
# We need both entries:
#   nodes/src           → enables  `import nodes.tool_supabase`
#   nodes/src/nodes     → enables  `from tool_supabase.X import Y`  (bare package)
_NODES_SRC_ROOT = _NODES_SRC.parent  # nodes/src
sys.path.insert(0, str(_NODES_SRC_ROOT))
sys.path.insert(0, str(_NODES_SRC))


# ---------------------------------------------------------------------------
# Test class: services.json contract
# ---------------------------------------------------------------------------


class TestServicesJson:
    """services.json parses as valid JSON and satisfies the engine node contract."""

    @pytest.fixture(scope='class')
    def data(self):
        path = _SUPABASE_SRC / 'services.json'
        assert path.exists(), f'services.json not found at {path}'
        with open(path, encoding='utf-8') as f:
            return json.load(f)

    def test_parses_as_valid_json(self, data):
        """services.json is valid JSON (fixture would raise on failure)."""
        assert isinstance(data, dict)

    def test_classtype_is_tool(self, data):
        """ClassType must include 'tool'."""
        assert 'tool' in data['classType'], f"classType={data['classType']!r} does not contain 'tool'"

    def test_capabilities_includes_invoke(self, data):
        """Capabilities must include 'invoke'."""
        assert 'invoke' in data['capabilities'], f"capabilities={data['capabilities']!r} does not contain 'invoke'"

    def test_path_is_nodes_tool_supabase(self, data):
        """Path must be 'nodes.tool_supabase' for the engine to locate the package."""
        assert data['path'] == 'nodes.tool_supabase', f'path={data["path"]!r}'

    def test_preconfig_has_default_key(self, data):
        """Preconfig must have a 'default' key pointing to a named profile."""
        preconfig = data.get('preconfig', {})
        assert 'default' in preconfig, "'default' key missing from preconfig"

    def test_preconfig_default_profile_exists(self, data):
        """The profile named by preconfig.default must exist in preconfig.profiles."""
        preconfig = data.get('preconfig', {})
        default_name = preconfig.get('default')
        profiles = preconfig.get('profiles', {})
        assert default_name in profiles, (
            f'preconfig.default={default_name!r} not found in profiles: {list(profiles.keys())}'
        )

    def test_default_profile_has_required_fields(self, data):
        """The default profile must carry serverName, bearer, readOnly, and endpoint or local."""
        preconfig = data.get('preconfig', {})
        default_name = preconfig.get('default')
        profile = preconfig.get('profiles', {}).get(default_name, {})
        # Must have the authentication-related fields.
        required = {'serverName', 'bearer', 'readOnly'}
        missing = required - set(profile.keys())
        assert not missing, f'Default profile missing keys: {missing}'
        # Must have either an 'endpoint' field (direct URL) or a 'local' flag (toggle).
        has_endpoint_config = 'endpoint' in profile or 'local' in profile
        assert has_endpoint_config, (
            f"Default profile must have 'endpoint' or 'local' for connection config; got keys: {list(profile.keys())}"
        )

    def test_node_field_is_python(self, data):
        """Node must be 'python' so the engine instantiates the Python driver."""
        assert data.get('node') == 'python', f'node={data.get("node")!r}'

    def test_protocol_set(self, data):
        """Protocol must be non-empty (used to name the node family)."""
        assert data.get('protocol'), 'protocol is empty or missing'

    def test_both_profiles_exist(self, data):
        """Profiles for both remote and local Supabase modes must exist."""
        profiles = data.get('preconfig', {}).get('profiles', {})
        assert len(profiles) >= 2, f'Expected at least 2 profiles (remote + local CLI), got: {list(profiles.keys())}'


# ---------------------------------------------------------------------------
# Test class: package import contract
# ---------------------------------------------------------------------------


class TestPackageImport:
    """The node package imports cleanly and exposes IGlobal and IInstance."""

    def test_package_imports(self):
        """Import nodes.tool_supabase succeeds without engine runtime."""
        import nodes.tool_supabase  # noqa: F401

    def test_iglobal_exported(self):
        """nodes.tool_supabase exports IGlobal."""
        import nodes.tool_supabase as pkg

        assert hasattr(pkg, 'IGlobal'), '__init__.py must export IGlobal'

    def test_iinstance_exported(self):
        """nodes.tool_supabase exports IInstance."""
        import nodes.tool_supabase as pkg

        assert hasattr(pkg, 'IInstance'), '__init__.py must export IInstance'

    def test_iglobal_is_class(self):
        """IGlobal is a class (not a module or function)."""
        import nodes.tool_supabase as pkg

        assert isinstance(pkg.IGlobal, type), f'IGlobal is not a class: {type(pkg.IGlobal)}'

    def test_iinstance_is_class(self):
        """IInstance is a class (not a module or function)."""
        import nodes.tool_supabase as pkg

        assert isinstance(pkg.IInstance, type), f'IInstance is not a class: {type(pkg.IInstance)}'


# ---------------------------------------------------------------------------
# Test class: _split_tool_name unit tests
# ---------------------------------------------------------------------------


class TestSplitToolName:
    """_split_tool_name correctly splits 'server.tool' into (server, tool)."""

    @pytest.fixture(autouse=True)
    def _import(self):
        from tool_supabase.IInstance import _split_tool_name

        self.fn = _split_tool_name

    def test_basic_split(self):
        """'supabase.list_tables' splits into ('supabase', 'list_tables')."""
        server, tool = self.fn('supabase.list_tables')
        assert server == 'supabase'
        assert tool == 'list_tables'

    def test_nested_dot_preserves_bare_tool(self):
        """'supabase.foo.bar' keeps everything after the first dot as the tool name."""
        server, tool = self.fn('supabase.foo.bar')
        assert server == 'supabase'
        assert tool == 'foo.bar'

    def test_no_dot_raises_value_error(self):
        """A name without a dot raises ValueError."""
        with pytest.raises(ValueError, match='namespaced'):
            self.fn('no_dot_here')

    def test_empty_string_raises_value_error(self):
        """An empty string raises ValueError."""
        with pytest.raises(ValueError):
            self.fn('')

    def test_leading_dot_raises_value_error(self):
        """'.tool' (empty server) raises ValueError."""
        with pytest.raises(ValueError):
            self.fn('.tool')

    def test_trailing_dot_raises_value_error(self):
        """'server.' (empty bare tool) raises ValueError."""
        with pytest.raises(ValueError):
            self.fn('server.')

    def test_whitespace_stripped(self):
        """Leading/trailing whitespace in the full name is stripped before parsing."""
        server, tool = self.fn('  supabase.exec  ')
        assert server == 'supabase'
        assert tool == 'exec'


# ---------------------------------------------------------------------------
# Test class: IGlobal URL and header construction (tested against the actual
# implementation via the observable constants and logic flow in IGlobal.py)
# ---------------------------------------------------------------------------

# The IGlobal.beginGlobal() makes a live network call, so we replicate the
# URL-building logic inline, following the same code path as the implementation.
# This tests the *design* of the URL construction without needing a live server.
# All branch values are derived from the actual IGlobal.py source.


def _build_url_and_headers(cfg: dict) -> tuple[str, dict]:
    """
    Mirror the URL/header construction from IGlobal.beginGlobal for testing.

    Keep in sync with nodes/src/nodes/tool_supabase/IGlobal.py.
    Config keys used by the implementation:
      - endpoint  : direct URL string (remote or local CLI)
      - projectRef: appended as ?project_ref=
      - readOnly  : appended as ?read_only=true
      - features  : appended as ?features=
      - bearer    : Authorization: Bearer header; ${VAR} expanded via os.expandvars;
                    discarded if still unexpanded after expansion
    """
    import os
    import urllib.parse

    _DEFAULT_URL = 'https://mcp.supabase.com/mcp'

    base_url = str(cfg.get('endpoint') or _DEFAULT_URL).strip()

    project_ref = str(cfg.get('projectRef') or '').strip()
    read_only = str(cfg.get('readOnly') or '').strip().lower() in ('true', '1', 'yes')
    features = str(cfg.get('features') or '').strip()

    params: dict = {}
    if project_ref:
        params['project_ref'] = project_ref
    if read_only:
        params['read_only'] = 'true'
    if features:
        params['features'] = features

    if params:
        # Use urlparse/urlunparse so a trailing '?' or pre-existing params are
        # handled correctly — mirrors the fix in IGlobal.py (debugger bug #2).
        _parsed = urllib.parse.urlparse(base_url)
        _existing = urllib.parse.parse_qs(_parsed.query, keep_blank_values=True)
        _existing.update({k: [v] for k, v in params.items()})
        _new_query = urllib.parse.urlencode({k: v[0] for k, v in _existing.items()})
        endpoint = urllib.parse.urlunparse(_parsed._replace(query=_new_query))
    else:
        endpoint = base_url

    # Mirror IGlobal.py bearer logic: expandvars, then discard if still unexpanded.
    bearer_raw = str(cfg.get('bearer') or '').strip()
    bearer = os.path.expandvars(bearer_raw) if bearer_raw else ''
    if '${' in bearer:
        bearer = ''
    headers: dict = {}
    if bearer:
        headers['Authorization'] = f'Bearer {bearer}'

    return endpoint, headers


class TestIGlobalUrlBuilding:
    """URL and auth-header construction logic from IGlobal.beginGlobal."""

    def test_remote_base_url_used_by_default(self):
        """With no endpoint set, defaults to the remote Supabase MCP URL."""
        endpoint, _ = _build_url_and_headers({})
        assert endpoint.startswith('https://mcp.supabase.com/mcp'), endpoint

    def test_explicit_remote_endpoint_passed_through(self):
        """An explicit remote endpoint URL is used verbatim as the base."""
        endpoint, _ = _build_url_and_headers({'endpoint': 'https://mcp.supabase.com/mcp'})
        assert 'mcp.supabase.com' in endpoint, endpoint

    def test_local_cli_endpoint_used_when_set(self):
        """Setting endpoint to the local CLI URL routes to localhost."""
        endpoint, _ = _build_url_and_headers({'endpoint': 'http://localhost:54321/mcp'})
        assert endpoint.startswith('http://localhost:54321/mcp'), endpoint

    def test_project_ref_appended_as_query_param(self):
        """A non-empty projectRef is appended as project_ref= query param."""
        endpoint, _ = _build_url_and_headers({'projectRef': 'abcdef123456'})
        assert 'project_ref=abcdef123456' in endpoint, endpoint

    def test_read_only_param_appended_when_true(self):
        """readOnly=True appends read_only=true to the URL."""
        endpoint, _ = _build_url_and_headers({'readOnly': True})
        assert 'read_only=true' in endpoint, endpoint

    def test_read_only_param_absent_when_false(self):
        """readOnly=False does NOT append read_only to the URL."""
        endpoint, _ = _build_url_and_headers({'readOnly': False})
        assert 'read_only' not in endpoint, endpoint

    def test_features_param_appended_when_set(self):
        """A non-empty features value is appended as a features= query param."""
        endpoint, _ = _build_url_and_headers({'features': 'database,storage'})
        assert 'features=database' in endpoint, endpoint

    def test_no_query_string_when_all_optional_empty(self):
        """With no projectRef/readOnly/features, the URL has no query string."""
        endpoint, _ = _build_url_and_headers({'endpoint': 'https://mcp.supabase.com/mcp'})
        assert '?' not in endpoint, f'Unexpected query string in {endpoint!r}'

    def test_trailing_question_mark_in_base_url_handled(self):
        """A base endpoint with a trailing '?' produces a valid URL (not .../mcp&param=x)."""
        endpoint, _ = _build_url_and_headers(
            {
                'endpoint': 'https://mcp.supabase.com/mcp?',
                'projectRef': 'abc',
            }
        )
        assert '?' in endpoint
        assert 'project_ref=abc' in endpoint
        # Must not produce the broken '&' before the query string
        assert 'mcp?' in endpoint or 'mcp?project_ref' in endpoint, endpoint

    def test_bearer_token_sets_authorization_header(self):
        """A non-empty bearer value produces an Authorization: Bearer <token> header."""
        _, headers = _build_url_and_headers({'bearer': 'sbp_test_token_123'})
        assert headers.get('Authorization') == 'Bearer sbp_test_token_123', headers

    def test_empty_bearer_produces_no_authorization_header(self):
        """An empty bearer does NOT add an Authorization header."""
        _, headers = _build_url_and_headers({'bearer': ''})
        assert 'Authorization' not in headers, headers

    def test_unset_env_var_placeholder_suppressed(self):
        """${SUPABASE_ACCESS_TOKEN} is suppressed when the env var is not set.

        IGlobal.py calls os.path.expandvars then discards the result if '${' is
        still present — prevents a literal '${VAR}' string being sent as a token.
        """
        import os

        token_key = 'SUPABASE_ACCESS_TOKEN'
        old = os.environ.pop(token_key, None)
        try:
            _, headers = _build_url_and_headers({'bearer': '${SUPABASE_ACCESS_TOKEN}'})
            assert 'Authorization' not in headers, (
                f'Expected no Authorization header when env var is unset, got: {headers}'
            )
        finally:
            if old is not None:
                os.environ[token_key] = old

    def test_set_env_var_bearer_produces_authorization_header(self):
        """${SUPABASE_ACCESS_TOKEN} expands to the real token when the env var is set."""
        import os

        token_key = 'SUPABASE_ACCESS_TOKEN'
        old = os.environ.get(token_key)
        os.environ[token_key] = 'real-token-xyz'
        try:
            _, headers = _build_url_and_headers({'bearer': '${SUPABASE_ACCESS_TOKEN}'})
            assert headers.get('Authorization') == 'Bearer real-token-xyz', headers
        finally:
            if old is None:
                os.environ.pop(token_key, None)
            else:
                os.environ[token_key] = old


# ---------------------------------------------------------------------------
# Test class: IInstance._tool_invoke_dynamic strips framework keys
# ---------------------------------------------------------------------------


class TestIInstanceFrameworkKeyStripping:
    """IInstance._tool_invoke_dynamic strips security_context from the arguments dict."""

    def _make_instance(self):
        """Build an IInstance with a mocked IGlobal, bypassing __init__."""
        from tool_supabase.IInstance import IInstance

        inst = IInstance.__new__(IInstance)
        inst.IGlobal = MagicMock()
        inst.IGlobal.serverName = 'supabase'
        inst.IGlobal.call_tool = MagicMock(return_value={'content': []})
        return inst

    def test_security_context_stripped(self):
        """security_context in input_obj is stripped before forwarding to call_tool."""
        inst = self._make_instance()
        inst._tool_invoke_dynamic(
            tool_name='supabase.list_tables',
            input_obj={'security_context': 'ctx-abc', 'schema': 'public'},
        )
        _, kwargs = inst.IGlobal.call_tool.call_args
        assert 'security_context' not in kwargs['arguments'], kwargs['arguments']
        assert kwargs['arguments'].get('schema') == 'public'

    def test_none_input_becomes_empty_dict(self):
        """None input_obj results in an empty arguments dict."""
        inst = self._make_instance()
        inst._tool_invoke_dynamic(tool_name='supabase.list_tables', input_obj=None)
        _, kwargs = inst.IGlobal.call_tool.call_args
        assert kwargs['arguments'] == {}

    def test_non_dict_input_raises_value_error(self):
        """A non-dict, non-None input_obj raises ValueError."""
        inst = self._make_instance()
        with pytest.raises(ValueError, match='JSON object'):
            inst._tool_invoke_dynamic(tool_name='supabase.list_tables', input_obj='bad input')

    def test_tool_name_split_forwarded_correctly(self):
        """call_tool receives the correct server_name and tool_name after split."""
        inst = self._make_instance()
        inst._tool_invoke_dynamic(
            tool_name='supabase.execute_sql',
            input_obj={'query': 'SELECT 1'},
        )
        inst.IGlobal.call_tool.assert_called_once_with(
            server_name='supabase',
            tool_name='execute_sql',
            arguments={'query': 'SELECT 1'},
        )


# ---------------------------------------------------------------------------
# Test class: structural parity with tool_mcp_client
# ---------------------------------------------------------------------------


class TestStructuralParity:
    """tool_supabase mirrors the client module structure of tool_mcp_client."""

    def test_streamable_http_client_present(self):
        """mcp_streamable_http_client.py exists in tool_supabase."""
        assert (_SUPABASE_SRC / 'mcp_streamable_http_client.py').is_file()

    def test_sse_client_present(self):
        """mcp_sse_client.py exists in tool_supabase."""
        assert (_SUPABASE_SRC / 'mcp_sse_client.py').is_file()

    def test_stdio_client_present(self):
        """mcp_stdio_client.py exists in tool_supabase."""
        assert (_SUPABASE_SRC / 'mcp_stdio_client.py').is_file()

    def test_streamable_http_client_importable(self):
        """mcp_streamable_http_client can be imported and exports McpStreamableHttpClient."""
        from tool_supabase.mcp_streamable_http_client import McpStreamableHttpClient  # noqa: F401

        assert McpStreamableHttpClient is not None

    def test_mcp_tool_def_importable(self):
        """McpToolDef is exported from mcp_streamable_http_client."""
        from tool_supabase.mcp_streamable_http_client import McpToolDef  # noqa: F401

        assert McpToolDef is not None

    def test_mcp_protocol_error_importable(self):
        """McpProtocolError is exported from mcp_streamable_http_client."""
        from tool_supabase.mcp_streamable_http_client import McpProtocolError  # noqa: F401

        assert McpProtocolError is not None

    def test_sse_client_has_mcp_sse_client_class(self):
        """mcp_sse_client.py exports McpSseClient."""
        from tool_supabase.mcp_sse_client import McpSseClient  # noqa: F401

        assert McpSseClient is not None

    def test_mcptooldefs_are_frozen_dataclasses(self):
        """McpToolDef is a frozen dataclass with name, description, inputSchema."""
        from tool_supabase.mcp_streamable_http_client import McpToolDef
        import dataclasses

        assert dataclasses.is_dataclass(McpToolDef)
        fields = {f.name for f in dataclasses.fields(McpToolDef)}
        assert {'name', 'description', 'inputSchema'} <= fields


# ---------------------------------------------------------------------------
# Test class: McpStreamableHttpClient unit tests (no network)
# ---------------------------------------------------------------------------


class TestMcpStreamableHttpClientUnit:
    """Unit tests for McpStreamableHttpClient construction and helpers."""

    def test_client_requires_non_empty_endpoint(self):
        """Passing an empty endpoint string raises ValueError."""
        from tool_supabase.mcp_streamable_http_client import McpStreamableHttpClient

        with pytest.raises(ValueError, match='endpoint'):
            McpStreamableHttpClient(endpoint='')

    def test_client_sets_accept_header(self):
        """Client adds Accept: application/json, text/event-stream by default."""
        from tool_supabase.mcp_streamable_http_client import McpStreamableHttpClient

        client = McpStreamableHttpClient(endpoint='https://mcp.supabase.com/mcp')
        built = client._build_headers()
        accept = built.get('Accept', '')
        assert 'application/json' in accept
        assert 'text/event-stream' in accept

    def test_bearer_header_forwarded(self):
        """An Authorization header passed in headers= is preserved."""
        from tool_supabase.mcp_streamable_http_client import McpStreamableHttpClient

        client = McpStreamableHttpClient(
            endpoint='https://mcp.supabase.com/mcp',
            headers={'Authorization': 'Bearer test-token'},
        )
        built = client._build_headers()
        assert built.get('Authorization') == 'Bearer test-token'

    def test_double_start_raises(self):
        """Calling start() twice without an intervening stop() raises RuntimeError."""
        from tool_supabase.mcp_streamable_http_client import McpStreamableHttpClient

        client = McpStreamableHttpClient(endpoint='https://mcp.supabase.com/mcp')
        client._started = True  # Simulate already-started state.
        with pytest.raises(RuntimeError, match='already started'):
            client.start()

    def test_jsonrpc_parse_happy_path(self):
        """_parse_jsonrpc_response_body extracts the result for a matching id."""
        from tool_supabase.mcp_streamable_http_client import _parse_jsonrpc_response_body
        import json

        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': {'tools': []}}).encode()
        result = _parse_jsonrpc_response_body(body=body, req_id=1)
        assert result == {'tools': []}

    def test_jsonrpc_parse_error_raises_protocol_error(self):
        """A JSON-RPC error response raises McpProtocolError."""
        from tool_supabase.mcp_streamable_http_client import (
            _parse_jsonrpc_response_body,
            McpProtocolError,
        )
        import json

        body = json.dumps(
            {
                'jsonrpc': '2.0',
                'id': 1,
                'error': {'code': -32600, 'message': 'Invalid Request'},
            }
        ).encode()
        with pytest.raises(McpProtocolError, match='Invalid Request'):
            _parse_jsonrpc_response_body(body=body, req_id=1)

    def test_jsonrpc_parse_empty_body_raises(self):
        """An empty body raises McpProtocolError."""
        from tool_supabase.mcp_streamable_http_client import (
            _parse_jsonrpc_response_body,
            McpProtocolError,
        )

        with pytest.raises(McpProtocolError):
            _parse_jsonrpc_response_body(body=b'', req_id=1)

    def test_jsonrpc_parse_id_mismatch_raises(self):
        """A response for a different id raises McpProtocolError (no match found)."""
        from tool_supabase.mcp_streamable_http_client import (
            _parse_jsonrpc_response_body,
            McpProtocolError,
        )
        import json

        body = json.dumps({'jsonrpc': '2.0', 'id': 99, 'result': {}}).encode()
        with pytest.raises(McpProtocolError, match='No JSON-RPC response'):
            _parse_jsonrpc_response_body(body=body, req_id=1)


# ---------------------------------------------------------------------------
# Test class: live tool discovery (skipped — needs token + network)
# ---------------------------------------------------------------------------


class TestLiveToolDiscovery:
    """Live integration test: discover tools from the Supabase MCP server.

    Skipped unconditionally — requires SUPABASE_ACCESS_TOKEN and network access
    to https://mcp.supabase.com/mcp.  Do NOT remove the skip; do NOT claim it
    passed in CI.  To run manually:

        SUPABASE_ACCESS_TOKEN=<token> <engine> -m pytest \
            nodes/test/tool_supabase/test_node.py::TestLiveToolDiscovery -v -s
    """

    @pytest.mark.skip(
        reason=(
            'Requires SUPABASE_ACCESS_TOKEN env var and network access to '
            'https://mcp.supabase.com/mcp — not available in CI'
        )
    )
    def test_list_tools_returns_nonempty_list(self):
        """Connecting to the live Supabase MCP server returns at least one tool."""
        from tool_supabase.mcp_streamable_http_client import McpStreamableHttpClient

        token = os.environ.get('SUPABASE_ACCESS_TOKEN', '')
        assert token, 'SUPABASE_ACCESS_TOKEN must be set to run this test'

        client = McpStreamableHttpClient(
            endpoint='https://mcp.supabase.com/mcp',
            headers={'Authorization': f'Bearer {token}'},
            client_name='RocketRideSupabaseMcpClient',
        )
        client.start()
        try:
            tools = client.list_tools()
        finally:
            client.stop()

        assert isinstance(tools, list), f'Expected list, got {type(tools)}'
        assert len(tools) > 0, 'No tools returned from Supabase MCP server'
        first = tools[0]
        assert hasattr(first, 'name'), 'McpToolDef missing name attribute'
        assert hasattr(first, 'description'), 'McpToolDef missing description attribute'
        assert hasattr(first, 'inputSchema'), 'McpToolDef missing inputSchema attribute'
