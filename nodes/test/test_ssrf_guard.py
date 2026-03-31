# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Tests for SSRF protection across the codebase.

Tests cover:
- validate_url() directly: private IPs, loopback, link-local, cloud metadata, scheme rejection
- Integration: MCP streamable HTTP, MCP SSE, weaviate, remote/client all call validate_url

Usage:
    python3 -m pytest nodes/test/test_ssrf_guard.py -v
"""

import importlib.util
import socket
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------

NODES_SRC = Path(__file__).parent.parent / 'src'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))

# Engine-internal modules that nodes package __init__ files try to import.
# Mock them before any `import nodes.*` so the package tree is importable.
_ENGINE_STUBS = ('depends', 'engLib', 'rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.transform', 'ai.common.schema', 'ai.common.tools')
for _mod_name in _ENGINE_STUBS:
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = MagicMock()

from nodes.library.internet.ssrf_guard import validate_url  # noqa: E402


# Provide real base classes so that `class IGlobal(IGlobalTransform)` etc. create real classes
class _StubBase:
    pass


sys.modules['ai.common.transform'].IGlobalTransform = _StubBase
sys.modules['rocketlib'].IGlobalBase = _StubBase
sys.modules['rocketlib'].configureLogger = lambda *a, **kw: None
sys.modules['rocketlib'].monitorStatus = lambda *a, **kw: None
sys.modules['rocketlib'].IJson = MagicMock()
sys.modules['rocketlib'].Lvl = MagicMock()


# ---------------------------------------------------------------------------
# Utility: load a single .py file as a module, bypassing package __init__.py
# ---------------------------------------------------------------------------

_load_counter = 0


def _load_file_as_module(filepath: Path) -> ModuleType:
    """Load a single .py file as a standalone module, skipping __init__.py chains."""
    global _load_counter
    _load_counter += 1
    name = f'_ssrf_test_mod_{_load_counter}'
    spec = importlib.util.spec_from_file_location(name, filepath)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


# =============================================================================
# 1. Unit tests for validate_url
# =============================================================================

PATCH_GETADDRINFO = 'nodes.library.internet.ssrf_guard.socket.getaddrinfo'


class TestValidateUrlPrivateIPs:
    """Private RFC-1918 addresses must be rejected."""

    @pytest.mark.parametrize(
        'ip',
        ['10.0.0.1', '10.255.255.255', '192.168.0.1', '192.168.1.100', '172.16.0.1', '172.31.255.255'],
    )
    def test_private_ip_rejected(self, ip):
        with patch(PATCH_GETADDRINFO, return_value=[(socket.AF_INET, 0, 0, '', (ip, 0))]):
            with pytest.raises(ValueError, match='private/internal'):
                validate_url(f'https://{ip}/v1/meta')


class TestValidateUrlLoopback:
    """Loopback addresses must be rejected."""

    @pytest.mark.parametrize('ip', ['127.0.0.1', '127.0.0.2', '::1'])
    def test_loopback_rejected(self, ip):
        family = socket.AF_INET6 if ':' in ip else socket.AF_INET
        with patch(PATCH_GETADDRINFO, return_value=[(family, 0, 0, '', (ip, 0))]):
            with pytest.raises(ValueError, match='private/internal'):
                validate_url('https://loopback.test/path')


class TestValidateUrlLinkLocal:
    """Link-local addresses (169.254.x.x) must be rejected."""

    @pytest.mark.parametrize('ip', ['169.254.0.1', '169.254.169.254', '169.254.255.255'])
    def test_link_local_rejected(self, ip):
        with patch(PATCH_GETADDRINFO, return_value=[(socket.AF_INET, 0, 0, '', (ip, 0))]):
            with pytest.raises(ValueError, match='private/internal'):
                validate_url('http://link-local.test/something')


class TestValidateUrlCloudMetadata:
    """Known cloud metadata hostnames must be rejected."""

    @pytest.mark.parametrize(
        'host',
        [
            'metadata.google.internal',
            'metadata.goog',
            'metadata.azure.com',
            'management.azure.com',
            'instance-data.ec2.internal',
        ],
    )
    def test_cloud_metadata_rejected(self, host):
        with pytest.raises(ValueError, match='metadata'):
            validate_url(f'http://{host}/latest/meta-data/')

    def test_aws_metadata_ip_rejected(self):
        with patch(PATCH_GETADDRINFO, return_value=[(socket.AF_INET, 0, 0, '', ('169.254.169.254', 0))]):
            with pytest.raises(ValueError, match='private/internal'):
                validate_url('http://169.254.169.254/latest/meta-data/')


class TestValidateUrlScheme:
    """Unsupported URL schemes must be rejected."""

    @pytest.mark.parametrize('scheme', ['ftp', 'file', 'gopher', 'dict', 'ldap'])
    def test_unsupported_scheme_rejected(self, scheme):
        with pytest.raises(ValueError, match='Unsupported URL scheme'):
            validate_url(f'{scheme}://example.com/path')


class TestValidateUrlPass:
    """Valid public URLs must pass."""

    def test_valid_https_url_passes(self):
        with patch(PATCH_GETADDRINFO, return_value=[(socket.AF_INET, 0, 0, '', ('8.8.8.8', 0))]):
            validate_url('https://weaviate-cloud.example.com/v1/meta')

    def test_valid_http_url_passes(self):
        with patch(PATCH_GETADDRINFO, return_value=[(socket.AF_INET, 0, 0, '', ('93.184.216.34', 0))]):
            validate_url('http://example.com/api')


# =============================================================================
# 2. Integration: MCP Streamable HTTP client
# =============================================================================

MCP_HTTP_FILE = NODES_SRC / 'nodes' / 'mcp_client' / 'mcp_streamable_http_client.py'
MCP_SSE_FILE = NODES_SRC / 'nodes' / 'mcp_client' / 'mcp_sse_client.py'


class TestMcpStreamableHttpSSRF:
    """Verify McpStreamableHttpClient constructor calls validate_url."""

    def test_ssrf_blocks_private_endpoint(self):
        mod = _load_file_as_module(MCP_HTTP_FILE)
        with patch.object(mod, 'validate_url', side_effect=ValueError('Blocked')):
            with pytest.raises(ValueError, match='Blocked'):
                mod.McpStreamableHttpClient(endpoint='http://10.0.0.1:8080/mcp')

    def test_ssrf_allows_public_endpoint(self):
        mod = _load_file_as_module(MCP_HTTP_FILE)
        with patch.object(mod, 'validate_url'):
            client = mod.McpStreamableHttpClient(endpoint='https://mcp.example.com/v1')
            assert client._endpoint == 'https://mcp.example.com/v1'


# =============================================================================
# 3. Integration: MCP SSE client
# =============================================================================


class TestMcpSseSSRF:
    """Verify McpSseClient constructor and _handle_sse_event call validate_url."""

    def test_ssrf_blocks_private_sse_endpoint(self):
        mod = _load_file_as_module(MCP_SSE_FILE)
        with patch.object(mod, 'validate_url', side_effect=ValueError('Blocked')):
            with pytest.raises(ValueError, match='Blocked'):
                mod.McpSseClient(sse_endpoint='http://192.168.1.1:8080/sse')

    def test_ssrf_allows_public_sse_endpoint(self):
        mod = _load_file_as_module(MCP_SSE_FILE)
        with patch.object(mod, 'validate_url'):
            client = mod.McpSseClient(sse_endpoint='https://mcp.example.com/sse')
            assert client._sse_endpoint == 'https://mcp.example.com/sse'

    def test_ssrf_blocks_server_supplied_endpoint(self):
        mod = _load_file_as_module(MCP_SSE_FILE)
        with patch.object(mod, 'validate_url') as mock_validate:
            client = mod.McpSseClient(sse_endpoint='https://mcp.example.com/sse')

            # Second call (server-supplied endpoint) fails SSRF check
            mock_validate.side_effect = ValueError('Blocked request to private/internal address')
            with pytest.raises(mod.McpProtocolError, match='SSRF check'):
                client._handle_sse_event(event='endpoint', data='/internal/messages?session=abc')


# =============================================================================
# 4. Integration: weaviate/IGlobal.py calls validate_url before httpx.get
# =============================================================================

WEAVIATE_IGLOBAL_FILE = NODES_SRC / 'nodes' / 'weaviate' / 'IGlobal.py'


class TestWeaviateSSRF:
    """Verify weaviate IGlobal.validateConfig calls validate_url on cloud URLs."""

    def test_ssrf_blocks_private_ip_in_cloud_mode(self):
        """A cloud host resolving to a private IP should trigger SSRF guard and surface warning."""
        mock_config_cls = MagicMock()
        mock_config_cls.getNodeConfig.return_value = {
            'host': 'evil.attacker.com',
            'port': '8080',
            'grpc_port': '50051',
            'apikey': 'test-key',
            'collection': 'TestCollection',
        }
        sys.modules['ai.common.config'].Config = mock_config_cls

        with patch.dict(sys.modules, {'httpx': MagicMock()}):
            mod = _load_file_as_module(WEAVIATE_IGLOBAL_FILE)

        obj = mod.IGlobal()
        obj.glb = MagicMock()
        obj.glb.logicalType = 'weaviate'
        obj.glb.connConfig = {}

        # httpx mock needs real exception types for isinstance() checks in _format_error
        mock_httpx = MagicMock()
        mock_httpx.HTTPStatusError = type('HTTPStatusError', (Exception,), {})
        mock_httpx.RequestError = type('RequestError', (Exception,), {})

        with (
            patch.dict(sys.modules, {'weaviate': MagicMock(), 'weaviate.classes.init': MagicMock(), 'httpx': mock_httpx}),
            patch.object(mod, 'validate_url', side_effect=ValueError('Blocked request to private/internal address')),
            patch.object(mod, 'warning') as mock_warning,
        ):
            obj.validateConfig()
            mock_warning.assert_called_once()
            assert 'private/internal' in str(mock_warning.call_args)


# =============================================================================
# 5. Integration: remote/client/IGlobal.py calls validate_url
# =============================================================================

REMOTE_IGLOBAL_FILE = NODES_SRC / 'nodes' / 'remote' / 'client' / 'IGlobal.py'


class TestRemoteClientSSRF:
    """Verify remote/client IGlobal.beginGlobal calls validate_url."""

    def test_ssrf_blocks_private_ip(self):
        """A remote host resolving to a private IP should raise via validate_url."""
        mock_config_cls = MagicMock()
        mock_config_cls.getNodeConfig.return_value = {
            'remote': {
                'remote': {
                    'remote': {
                        'host': '10.0.0.5',
                        'port': '5565',
                        'apikey': 'test-key',
                    }
                }
            },
            'pipeline': 'test-pipe',
            'input': ['tags'],
            'output': ['documents'],
        }
        sys.modules['ai.common.config'].Config = mock_config_cls

        with patch.dict(sys.modules, {'requests': MagicMock()}):
            mod = _load_file_as_module(REMOTE_IGLOBAL_FILE)

        obj = mod.IGlobal()
        obj.glb = MagicMock()
        obj.glb.logicalType = 'remote'
        obj.glb.connConfig = {}
        obj.IEndpoint = MagicMock()
        obj.IEndpoint.endpoint.jobConfig = {'taskId': 'test-task-id'}

        with patch.object(mod, 'validate_url', side_effect=ValueError('Blocked')):
            with pytest.raises(ValueError, match='Blocked'):
                obj.beginGlobal()

    def test_requests_called_with_allow_redirects_false(self):
        """All requests.post and requests.delete calls must set allow_redirects=False."""
        mock_config_cls = MagicMock()
        mock_config_cls.getNodeConfig.return_value = {
            'remote': {
                'remote': {
                    'remote': {
                        'host': 'remote.example.com',
                        'port': '5565',
                        'apikey': 'test-key',
                    }
                }
            },
            'pipeline': 'test-pipe',
            'input': ['tags'],
            'output': ['documents'],
        }
        sys.modules['ai.common.config'].Config = mock_config_cls

        mock_requests = MagicMock()
        mock_requests.post.return_value = MagicMock(status_code=200)
        mock_requests.delete.return_value = MagicMock(status_code=200)

        with patch.dict(sys.modules, {'requests': mock_requests}):
            mod = _load_file_as_module(REMOTE_IGLOBAL_FILE)

        obj = mod.IGlobal()
        obj.glb = MagicMock()
        obj.glb.logicalType = 'remote'
        obj.glb.connConfig = {}
        obj.IEndpoint = MagicMock()
        obj.IEndpoint.endpoint.jobConfig = {'taskId': 'test-task-id'}

        with patch.object(mod, 'validate_url'):
            obj.beginGlobal()

        # Verify all POST calls used allow_redirects=False
        for call in mock_requests.post.call_args_list:
            assert call.kwargs.get('allow_redirects') is False, f'requests.post call missing allow_redirects=False: {call}'

        # Now test endGlobal for DELETE
        obj.endGlobal()
        for call in mock_requests.delete.call_args_list:
            assert call.kwargs.get('allow_redirects') is False, f'requests.delete call missing allow_redirects=False: {call}'


# =============================================================================
# 6. Redirect blocking: MCP clients reject HTTP redirects
# =============================================================================


class TestMcpRedirectBlocking:
    """Verify that MCP clients block HTTP redirects (SSRF bypass prevention)."""

    def test_sse_client_has_no_redirect_opener(self):
        """McpSseClient module must define _no_redirect_opener."""
        mod = _load_file_as_module(MCP_SSE_FILE)
        assert hasattr(mod, '_no_redirect_opener'), 'mcp_sse_client.py must define _no_redirect_opener'
        assert hasattr(mod, '_NoRedirectHandler'), 'mcp_sse_client.py must define _NoRedirectHandler'

    def test_streamable_http_client_has_no_redirect_opener(self):
        """McpStreamableHttpClient module must define _no_redirect_opener."""
        mod = _load_file_as_module(MCP_HTTP_FILE)
        assert hasattr(mod, '_no_redirect_opener'), 'mcp_streamable_http_client.py must define _no_redirect_opener'
        assert hasattr(mod, '_NoRedirectHandler'), 'mcp_streamable_http_client.py must define _NoRedirectHandler'

    def test_no_redirect_handler_raises_on_redirect(self):
        """_NoRedirectHandler.redirect_request must raise HTTPError."""
        mod = _load_file_as_module(MCP_SSE_FILE)
        handler = mod._NoRedirectHandler()
        import urllib.error

        with pytest.raises(urllib.error.HTTPError, match='SSRF protection'):
            handler.redirect_request(None, None, 302, 'Found', {}, 'http://169.254.169.254/meta')
