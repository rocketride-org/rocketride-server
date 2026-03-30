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

"""Tests for the Anthropic LLM pipeline node (llm_anthropic).

Covers IGlobal.validateConfig (success, auth errors, rate limit, token
validation, _format_error helper), IGlobal.beginGlobal / endGlobal lifecycle,
and IInstance inheritance from IInstanceGenericLLM.
"""

import sys
import types
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Provider SDK mocks — Anthropic
# ---------------------------------------------------------------------------

_mock_anthropic = types.ModuleType('anthropic')


class _FakeAnthropic:
    def __init__(self, api_key=None):
        self.api_key = api_key
        self.messages = MagicMock()
        self.messages.create = MagicMock()


class _FakeAPIStatusError(Exception):
    def __init__(self, message='', status_code=None, response=None):
        super().__init__(message)
        self.status_code = status_code
        self.status = status_code
        self.response = response


class _FakeAPIConnectionError(Exception):
    pass


class _FakeAPITimeoutError(Exception):
    pass


class _FakeRateLimitError(Exception):
    def __init__(self, message='', response=None, body=None):
        super().__init__(message)
        self.response = response
        self.body = body


class _FakeAuthenticationError(Exception):
    def __init__(self, message='', response=None, body=None):
        super().__init__(message)
        self.response = response
        self.body = body


class _FakeBadRequestError(Exception):
    pass


class _FakePermissionDeniedError(Exception):
    pass


class _FakeNotFoundError(Exception):
    pass


class _FakeInternalServerError(Exception):
    pass


class _FakeAPIError(Exception):
    pass


_mock_anthropic.Anthropic = _FakeAnthropic
_mock_anthropic.APIStatusError = _FakeAPIStatusError
_mock_anthropic.APIConnectionError = _FakeAPIConnectionError
_mock_anthropic.APITimeoutError = _FakeAPITimeoutError
_mock_anthropic.RateLimitError = _FakeRateLimitError
_mock_anthropic.AuthenticationError = _FakeAuthenticationError
_mock_anthropic.BadRequestError = _FakeBadRequestError
_mock_anthropic.PermissionDeniedError = _FakePermissionDeniedError
_mock_anthropic.NotFoundError = _FakeNotFoundError
_mock_anthropic.InternalServerError = _FakeInternalServerError
_mock_anthropic.APIError = _FakeAPIError

sys.modules['anthropic'] = _mock_anthropic

# Mock langchain_anthropic
_mock_lc_anthropic = types.ModuleType('langchain_anthropic')
_mock_lc_anthropic.ChatAnthropic = MagicMock()
sys.modules['langchain_anthropic'] = _mock_lc_anthropic

# ---------------------------------------------------------------------------
# Import the node under test
# ---------------------------------------------------------------------------

import os

_nodes_src = os.path.join(os.path.dirname(__file__), '..', '..', 'nodes', 'src')
if _nodes_src not in sys.path:
    sys.path.insert(0, os.path.abspath(_nodes_src))

from nodes.llm_anthropic.IGlobal import IGlobal  # noqa: E402
from nodes.llm_anthropic.IInstance import IInstance  # noqa: E402
from nodes.llm_base.IInstance import IInstanceGenericLLM  # noqa: E402


# ===================================================================
# IGlobal.validateConfig
# ===================================================================


class TestAnthropicValidateConfig:
    """Test suite for IGlobal.validateConfig."""

    def _make_iglobal(self, config, mock_config):
        mock_config.set_config('anthropic', config)
        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'anthropic'
        ig.glb.connConfig = config
        return ig

    def test_valid_config_succeeds(self, mock_config, warned_messages):
        """A valid config with good creds should produce no warnings."""
        config = {'apikey': 'sk-ant-test', 'model': 'claude-sonnet-4-20250514', 'modelTotalTokens': 200000}
        ig = self._make_iglobal(config, mock_config)
        ig.validateConfig()
        assert len(warned_messages) == 0

    def test_token_limit_zero_warns(self, mock_config, warned_messages):
        """Token limit of 0 should produce a warning."""
        config = {'apikey': 'sk-ant-test', 'model': 'claude-sonnet-4-20250514', 'modelTotalTokens': 0}
        ig = self._make_iglobal(config, mock_config)
        ig.validateConfig()
        assert any('Token limit' in m for m in warned_messages)

    def test_token_limit_negative_warns(self, mock_config, warned_messages):
        """Negative token limit should produce a warning."""
        config = {'apikey': 'sk-ant-test', 'model': 'claude-sonnet-4-20250514', 'modelTotalTokens': -10}
        ig = self._make_iglobal(config, mock_config)
        ig.validateConfig()
        assert any('Token limit' in m for m in warned_messages)

    def test_authentication_error_warns(self, mock_config, warned_messages):
        """AuthenticationError from Anthropic SDK should produce a warning."""
        config = {'apikey': 'bad-key', 'model': 'claude-sonnet-4-20250514', 'modelTotalTokens': None}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakeAnthropic()
        fake_client.messages.create = MagicMock(side_effect=_FakeAuthenticationError('Invalid API key'))
        with patch('anthropic.Anthropic', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'Invalid API key' in warned_messages[0]

    def test_rate_limit_error_warns(self, mock_config, warned_messages):
        """RateLimitError should be caught and produce a warning."""
        config = {'apikey': 'sk-ant-test', 'model': 'claude-sonnet-4-20250514', 'modelTotalTokens': None}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakeAnthropic()
        fake_client.messages.create = MagicMock(side_effect=_FakeRateLimitError('Rate limit exceeded'))
        with patch('anthropic.Anthropic', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'Rate limit' in warned_messages[0]

    def test_api_status_error_with_json_body(self, mock_config, warned_messages):
        """APIStatusError with structured JSON body should parse type and message."""
        config = {'apikey': 'sk-ant-test', 'model': 'claude-sonnet-4-20250514', 'modelTotalTokens': None}
        ig = self._make_iglobal(config, mock_config)

        mock_response = MagicMock()
        mock_response.json.return_value = {
            'error': {
                'type': 'not_found_error',
                'message': 'model: claude-sonnet-4-20250514 not found',
            }
        }
        err = _FakeAPIStatusError('Not found', status_code=404, response=mock_response)

        fake_client = _FakeAnthropic()
        fake_client.messages.create = MagicMock(side_effect=err)
        with patch('anthropic.Anthropic', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'not_found_error' in warned_messages[0]

    def test_api_connection_error_warns(self, mock_config, warned_messages):
        """APIConnectionError should be caught and produce a warning."""
        config = {'apikey': 'sk-ant-test', 'model': 'claude-sonnet-4-20250514', 'modelTotalTokens': None}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakeAnthropic()
        fake_client.messages.create = MagicMock(side_effect=_FakeAPIConnectionError('Connection failed'))
        with patch('anthropic.Anthropic', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'Connection failed' in warned_messages[0]


# ===================================================================
# IGlobal._format_error
# ===================================================================


class TestAnthropicFormatError:
    """Test suite for the _format_error helper method."""

    def _make_iglobal(self):
        ig = IGlobal()
        ig.glb = MagicMock()
        return ig

    def test_format_with_all_fields(self):
        """Should format: 'Error <status>: <type> - <message>'."""
        ig = self._make_iglobal()
        result = ig._format_error(401, 'authentication_error', 'Invalid API key', 'fallback')
        assert result == 'Error 401: authentication_error - Invalid API key'

    def test_format_with_status_only(self):
        """Should format: 'Error <status>:'."""
        ig = self._make_iglobal()
        result = ig._format_error(500, None, None, 'fallback')
        assert result == 'Error 500:'

    def test_format_with_no_structured_fields(self):
        """Should return the fallback string."""
        ig = self._make_iglobal()
        result = ig._format_error(None, None, None, 'Something went wrong')
        assert result == 'Something went wrong'

    def test_format_collapses_whitespace(self):
        """Should collapse multiple spaces and strip."""
        ig = self._make_iglobal()
        result = ig._format_error(None, None, None, '  Too   many   spaces  ')
        assert result == 'Too many spaces'

    @pytest.mark.parametrize(
        'status,etype,emsg,expected_fragment',
        [
            (429, 'rate_limit_error', 'Too many requests', 'Error 429:'),
            (403, 'permission_denied', 'Access denied', 'permission_denied'),
            (None, 'overloaded_error', 'Overloaded', 'overloaded_error'),
        ],
    )
    def test_format_error_parametrized(self, status, etype, emsg, expected_fragment):
        """Parametrized tests for various _format_error inputs."""
        ig = self._make_iglobal()
        result = ig._format_error(status, etype, emsg, 'fallback')
        assert expected_fragment in result


# ===================================================================
# IGlobal.beginGlobal / endGlobal
# ===================================================================


class TestAnthropicBeginEndGlobal:
    """Test suite for IGlobal.beginGlobal and endGlobal lifecycle."""

    def test_begin_global_creates_chat(self, mock_config, mock_endpoint):
        """BeginGlobal should create a Chat instance from the anthropic module."""
        config = {'apikey': 'sk-ant-test', 'model': 'claude-sonnet-4-20250514'}
        mock_config.set_config('anthropic', config)

        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'anthropic'
        ig.glb.connConfig = config
        ig.IEndpoint = mock_endpoint

        mock_chat = MagicMock()
        with patch('nodes.llm_anthropic.anthropic.Chat', return_value=mock_chat):
            ig.beginGlobal()

        assert ig._chat is mock_chat

    def test_end_global_clears_chat(self):
        """EndGlobal should set chat to None."""
        ig = IGlobal()
        ig.chat = MagicMock()
        ig.endGlobal()
        assert ig.chat is None


# ===================================================================
# IInstance
# ===================================================================


class TestAnthropicIInstance:
    """Test suite for IInstance."""

    def test_inherits_from_generic_llm(self):
        """IInstance should inherit from IInstanceGenericLLM."""
        assert issubclass(IInstance, IInstanceGenericLLM)

    def test_write_questions_delegates_to_chat(self):
        """WriteQuestions should call IGlobal._chat.chat and writeAnswers."""
        inst = IInstance()
        mock_answer = MagicMock()
        inst.IGlobal = MagicMock()
        inst.IGlobal._chat.chat.return_value = mock_answer
        inst.instance = MagicMock()

        question = MagicMock()
        inst.writeQuestions(question)

        inst.IGlobal._chat.chat.assert_called_once_with(question)
        inst.instance.writeAnswers.assert_called_once_with(mock_answer)
