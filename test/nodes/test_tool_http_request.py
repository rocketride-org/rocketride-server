# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Tests for the HTTP Request tool pipeline node (tool_http_request).

Covers HttpDriver validation (method guardrails, URL whitelist, auth/body
validation), shortcut normalization, tool query/descriptor, IGlobal lifecycle
(beginGlobal, validateConfig, endGlobal, _build_guardrails), and IInstance.invoke.
"""

import sys
import re
import types
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Mock http_client.execute_request (avoids real HTTP calls).
# Originals are saved so they can be restored after the test module runs.
# ---------------------------------------------------------------------------

_SDK_MODULES = ['nodes.tool_http_request.http_client']
_saved_sdk_modules = {name: sys.modules[name] for name in _SDK_MODULES if name in sys.modules}

_mock_http_client = types.ModuleType('nodes.tool_http_request.http_client')
_mock_http_client.execute_request = MagicMock(return_value={'status': 200, 'body': 'ok'})
sys.modules['nodes.tool_http_request.http_client'] = _mock_http_client


@pytest.fixture(autouse=True, scope='module')
def _restore_http_sdk_modules():
    """Restore original SDK modules after all tests in this module run."""
    yield
    for name in _SDK_MODULES:
        if name in _saved_sdk_modules:
            sys.modules[name] = _saved_sdk_modules[name]
        elif name in sys.modules:
            del sys.modules[name]


# ---------------------------------------------------------------------------
# Import the node under test (path setup handled by conftest.py)
# ---------------------------------------------------------------------------

from nodes.tool_http_request.http_driver import HttpDriver, VALID_METHODS, VALID_AUTH_TYPES  # noqa: E402
from nodes.tool_http_request.IGlobal import IGlobal  # noqa: E402
from nodes.tool_http_request.IInstance import IInstance  # noqa: E402


# ===================================================================
# HttpDriver — tool query
# ===================================================================


class TestHttpDriverToolQuery:
    """Test tool descriptor returned by _tool_query."""

    def _make_driver(self, server_name='http', methods=None, patterns=None):
        return HttpDriver(
            server_name=server_name,
            enabled_methods=methods or {'GET', 'POST'},
            url_patterns=patterns or [],
        )

    def test_tool_query_returns_descriptor(self):
        """_tool_query should return a list with one tool descriptor."""
        driver = self._make_driver()
        result = driver._tool_query()
        assert len(result) == 1
        assert result[0]['name'] == 'http.http_request'
        assert 'inputSchema' in result[0]
        assert 'description' in result[0]

    def test_tool_query_custom_server_name(self):
        """Tool name should reflect the configured server_name."""
        driver = self._make_driver(server_name='my-api')
        result = driver._tool_query()
        assert result[0]['name'] == 'my-api.http_request'


# ===================================================================
# HttpDriver — method validation
# ===================================================================


class TestHttpDriverMethodValidation:
    """Test method guardrail enforcement."""

    def _make_driver(self, methods):
        return HttpDriver(server_name='http', enabled_methods=methods, url_patterns=[])

    def test_allowed_method_passes(self):
        """An allowed method should not raise."""
        driver = self._make_driver({'GET', 'POST'})
        # Should not raise
        driver._tool_validate(tool_name='http_request', input_obj={'url': 'http://example.com', 'method': 'GET'})

    def test_disallowed_method_raises(self):
        """A disallowed method should raise ValueError."""
        driver = self._make_driver({'GET'})
        with pytest.raises(ValueError, match='not allowed'):
            driver._tool_validate(tool_name='http_request', input_obj={'url': 'http://example.com', 'method': 'DELETE'})

    def test_invalid_method_raises(self):
        """An invalid HTTP method should raise ValueError."""
        driver = self._make_driver({'GET'})
        with pytest.raises(ValueError, match='must be one of'):
            driver._tool_validate(tool_name='http_request', input_obj={'url': 'http://example.com', 'method': 'INVALID'})

    def test_missing_method_raises(self):
        """Missing method should raise ValueError."""
        driver = self._make_driver({'GET'})
        with pytest.raises(ValueError, match='method is required'):
            driver._tool_validate(tool_name='http_request', input_obj={'url': 'http://example.com'})

    @pytest.mark.parametrize('method', sorted(VALID_METHODS))
    def test_all_valid_methods_accepted_when_enabled(self, method):
        """Every valid HTTP method should be accepted when enabled."""
        driver = self._make_driver(VALID_METHODS)
        # Should not raise
        driver._tool_validate(tool_name='http_request', input_obj={'url': 'http://example.com', 'method': method})


# ===================================================================
# HttpDriver — URL whitelist
# ===================================================================


class TestHttpDriverURLWhitelist:
    """Test URL whitelist enforcement."""

    def test_no_whitelist_allows_all(self):
        """Empty whitelist should allow all URLs."""
        driver = HttpDriver(server_name='http', enabled_methods={'GET'}, url_patterns=[])
        # Should not raise
        driver._tool_validate(tool_name='http_request', input_obj={'url': 'http://anything.com/path', 'method': 'GET'})

    def test_matching_pattern_allows(self):
        """URL matching a whitelist pattern should be allowed."""
        pattern = re.compile(r'https://api\.example\.com/.*')
        driver = HttpDriver(server_name='http', enabled_methods={'GET'}, url_patterns=[pattern])
        driver._tool_validate(tool_name='http_request', input_obj={'url': 'https://api.example.com/users', 'method': 'GET'})

    def test_non_matching_pattern_rejects(self):
        """URL not matching any whitelist pattern should be rejected."""
        pattern = re.compile(r'https://api\.example\.com/.*')
        driver = HttpDriver(server_name='http', enabled_methods={'GET'}, url_patterns=[pattern])
        with pytest.raises(ValueError, match='does not match'):
            driver._tool_validate(tool_name='http_request', input_obj={'url': 'https://evil.com/hack', 'method': 'GET'})

    def test_multiple_patterns_any_match(self):
        """URL should be allowed if it matches ANY whitelist pattern."""
        patterns = [
            re.compile(r'https://api\.example\.com/.*'),
            re.compile(r'https://cdn\.example\.com/.*'),
        ]
        driver = HttpDriver(server_name='http', enabled_methods={'GET'}, url_patterns=patterns)
        driver._tool_validate(tool_name='http_request', input_obj={'url': 'https://cdn.example.com/assets', 'method': 'GET'})

    def test_missing_url_raises(self):
        """Missing URL should raise ValueError."""
        driver = HttpDriver(server_name='http', enabled_methods={'GET'}, url_patterns=[])
        with pytest.raises(ValueError, match='url is required'):
            driver._tool_validate(tool_name='http_request', input_obj={'method': 'GET'})


# ===================================================================
# HttpDriver — auth/body validation
# ===================================================================


class TestHttpDriverAuthBodyValidation:
    """Test auth and body field validation."""

    def _make_driver(self):
        return HttpDriver(server_name='http', enabled_methods=VALID_METHODS, url_patterns=[])

    def test_invalid_auth_type_raises(self):
        """Invalid auth.type should raise ValueError."""
        driver = self._make_driver()
        with pytest.raises(ValueError, match='auth.type'):
            driver._tool_validate(
                tool_name='http_request',
                input_obj={'url': 'http://example.com', 'method': 'GET', 'auth': {'type': 'oauth2'}},
            )

    @pytest.mark.parametrize('auth_type', sorted(VALID_AUTH_TYPES))
    def test_valid_auth_types_accepted(self, auth_type):
        """All valid auth types should be accepted."""
        driver = self._make_driver()
        driver._tool_validate(
            tool_name='http_request',
            input_obj={'url': 'http://example.com', 'method': 'GET', 'auth': {'type': auth_type}},
        )

    def test_invalid_body_type_raises(self):
        """Invalid body.type should raise ValueError."""
        driver = self._make_driver()
        with pytest.raises(ValueError, match='body.type'):
            driver._tool_validate(
                tool_name='http_request',
                input_obj={'url': 'http://example.com', 'method': 'POST', 'body': {'type': 'graphql'}},
            )

    def test_invalid_raw_content_type_raises(self):
        """Invalid body.raw.content_type should raise ValueError."""
        driver = self._make_driver()
        with pytest.raises(ValueError, match='content_type'):
            driver._tool_validate(
                tool_name='http_request',
                input_obj={
                    'url': 'http://example.com',
                    'method': 'POST',
                    'body': {'type': 'raw', 'raw': {'content': 'data', 'content_type': 'application/protobuf'}},
                },
            )

    def test_wrong_tool_name_raises(self):
        """Wrong tool name should raise ValueError."""
        driver = self._make_driver()
        with pytest.raises(ValueError, match='Unknown tool'):
            driver._tool_validate(tool_name='wrong_tool', input_obj={'url': 'http://example.com', 'method': 'GET'})

    def test_non_dict_input_raises(self):
        """Non-dict input should raise ValueError."""
        driver = self._make_driver()
        with pytest.raises(ValueError, match='JSON object'):
            driver._tool_validate(tool_name='http_request', input_obj='not a dict')


# ===================================================================
# HttpDriver — shortcut normalization
# ===================================================================


class TestHttpDriverShortcutNormalization:
    """Test _normalize_shortcuts for body_json, bearer_token, basic_auth."""

    def test_body_json_dict_normalized(self):
        """body_json dict should be normalized to body.raw with JSON content."""
        input_obj = {'url': 'http://example.com', 'method': 'POST', 'body_json': {'name': 'test'}}
        result = HttpDriver._normalize_shortcuts(input_obj)
        assert 'body_json' not in result
        assert result['body']['type'] == 'raw'
        assert result['body']['raw']['content_type'] == 'application/json'
        assert '"name"' in result['body']['raw']['content']

    def test_body_json_list_normalized(self):
        """body_json list should be normalized to body.raw with JSON content."""
        input_obj = {'url': 'http://example.com', 'method': 'POST', 'body_json': [1, 2, 3]}
        result = HttpDriver._normalize_shortcuts(input_obj)
        assert result['body']['raw']['content'] == '[1, 2, 3]'

    def test_bearer_token_normalized(self):
        """bearer_token should be normalized to auth.bearer."""
        input_obj = {'url': 'http://example.com', 'method': 'GET', 'bearer_token': 'my-token'}
        result = HttpDriver._normalize_shortcuts(input_obj)
        assert 'bearer_token' not in result
        assert result['auth']['type'] == 'bearer'
        assert result['auth']['bearer']['token'] == 'my-token'

    def test_basic_auth_normalized(self):
        """basic_auth should be normalized to auth.basic."""
        input_obj = {'url': 'http://example.com', 'method': 'GET', 'basic_auth': {'username': 'user', 'password': 'pass'}}
        result = HttpDriver._normalize_shortcuts(input_obj)
        assert 'basic_auth' not in result
        assert result['auth']['type'] == 'basic'
        assert result['auth']['basic']['username'] == 'user'

    def test_existing_body_not_overwritten(self):
        """If body is already present, body_json should not overwrite it."""
        input_obj = {
            'url': 'http://example.com',
            'method': 'POST',
            'body_json': {'ignored': True},
            'body': {'type': 'raw', 'raw': {'content': 'original', 'content_type': 'text/plain'}},
        }
        result = HttpDriver._normalize_shortcuts(input_obj)
        assert result['body']['raw']['content'] == 'original'

    def test_existing_auth_not_overwritten(self):
        """If auth is already present, bearer_token should not overwrite it."""
        input_obj = {
            'url': 'http://example.com',
            'method': 'GET',
            'bearer_token': 'ignored',
            'auth': {'type': 'api_key', 'api_key': {'key': 'X-API-Key', 'value': 'secret', 'add_to': 'header'}},
        }
        result = HttpDriver._normalize_shortcuts(input_obj)
        assert result['auth']['type'] == 'api_key'


# ===================================================================
# HttpDriver — _tool_invoke
# ===================================================================


class TestHttpDriverToolInvoke:
    """Test _tool_invoke delegates to execute_request."""

    def test_invoke_calls_execute_request(self):
        """_tool_invoke should call execute_request with the right parameters."""
        driver = HttpDriver(server_name='http', enabled_methods={'GET'}, url_patterns=[])

        _mock_http_client.execute_request.reset_mock()
        _mock_http_client.execute_request.return_value = {'status': 200, 'body': '{"result": "ok"}'}

        driver._tool_invoke(
            tool_name='http_request',
            input_obj={'url': 'http://api.example.com/data', 'method': 'GET'},
        )

        _mock_http_client.execute_request.assert_called_once()
        call_kwargs = _mock_http_client.execute_request.call_args.kwargs
        assert call_kwargs['url'] == 'http://api.example.com/data'
        assert call_kwargs['method'] == 'GET'

    def test_invoke_non_dict_raises(self):
        """_tool_invoke with non-dict input should raise."""
        driver = HttpDriver(server_name='http', enabled_methods={'GET'}, url_patterns=[])
        with pytest.raises(ValueError, match='JSON object'):
            driver._tool_invoke(tool_name='http_request', input_obj='not a dict')


# ===================================================================
# IGlobal
# ===================================================================


class TestHttpRequestIGlobal:
    """Test suite for tool_http_request IGlobal."""

    def test_build_guardrails_default_methods(self):
        """_build_guardrails with no explicit flags should enable default methods."""
        cfg = {}
        methods, patterns = IGlobal._build_guardrails(cfg)
        # Defaults: GET, POST, PUT, PATCH, DELETE
        assert 'GET' in methods
        assert 'POST' in methods
        assert 'PUT' in methods
        assert 'PATCH' in methods
        assert 'DELETE' in methods

    def test_build_guardrails_explicit_methods(self):
        """_build_guardrails should respect explicit flag overrides."""
        cfg = {'allowGET': True, 'allowPOST': False, 'allowPUT': False, 'allowPATCH': False, 'allowDELETE': False, 'allowHEAD': True, 'allowOPTIONS': False}
        methods, _ = IGlobal._build_guardrails(cfg)
        assert 'GET' in methods
        assert 'HEAD' in methods
        assert 'POST' not in methods
        assert 'DELETE' not in methods

    def test_build_guardrails_url_patterns(self):
        """_build_guardrails should compile URL whitelist patterns."""
        cfg = {
            'urlWhitelist': [
                {'whitelistPattern': r'https://api\.example\.com/.*'},
                {'whitelistPattern': r'https://cdn\.example\.com/.*'},
            ]
        }
        _, patterns = IGlobal._build_guardrails(cfg)
        assert len(patterns) == 2
        assert all(isinstance(p, re.Pattern) for p in patterns)

    def test_build_guardrails_invalid_regex_warns(self, warned_messages):
        """Invalid regex in URL whitelist should produce a warning."""
        cfg = {'urlWhitelist': [{'whitelistPattern': '[invalid'}]}
        _, patterns = IGlobal._build_guardrails(cfg)
        assert len(patterns) == 0
        assert any('Invalid URL whitelist regex' in m for m in warned_messages)

    def test_validate_config_missing_server_name_warns(self, mock_config, warned_messages):
        """Missing serverName should produce a warning."""
        config = {'serverName': '', 'urlWhitelist': []}
        mock_config.set_config('tool_http_request', config)

        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'tool_http_request'
        ig.glb.connConfig = config

        ig.validateConfig()
        assert any('serverName' in m for m in warned_messages)

    def test_validate_config_empty_whitelist_warns(self, mock_config, warned_messages):
        """Empty URL whitelist should produce an informational warning."""
        config = {'serverName': 'my-api', 'urlWhitelist': []}
        mock_config.set_config('tool_http_request', config)

        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'tool_http_request'
        ig.glb.connConfig = config

        ig.validateConfig()
        assert any('whitelist is empty' in m.lower() for m in warned_messages)

    def test_end_global_clears_driver(self):
        """EndGlobal should set driver to None."""
        ig = IGlobal()
        ig.driver = MagicMock()
        ig.endGlobal()
        assert ig.driver is None


# ===================================================================
# IInstance
# ===================================================================


class TestHttpRequestIInstance:
    """Test suite for tool_http_request IInstance."""

    def test_invoke_delegates_to_driver(self):
        """Invoke should delegate to driver.handle_invoke."""
        inst = IInstance()
        mock_driver = MagicMock()
        mock_driver.handle_invoke.return_value = {'status': 200}
        inst.IGlobal = MagicMock()
        inst.IGlobal.driver = mock_driver

        inst.invoke({'op': 'tool.invoke', 'tool': 'http_request', 'input': {'url': 'http://example.com', 'method': 'GET'}})
        mock_driver.handle_invoke.assert_called_once()

    def test_invoke_no_driver_raises(self):
        """Invoke should raise when driver is not initialized."""
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal.driver = None

        with pytest.raises(RuntimeError, match='driver not initialized'):
            inst.invoke({})
