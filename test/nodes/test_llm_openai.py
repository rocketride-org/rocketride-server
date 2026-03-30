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

"""Tests for the OpenAI LLM pipeline node (llm_openai).

Covers IGlobal.validateConfig (success, auth errors, rate limit, token
validation), IGlobal.beginGlobal / endGlobal lifecycle, and IInstance
inheritance from IInstanceGenericLLM.
"""

import sys
import types
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Provider SDK mocks — installed before importing the node module.
# Originals are saved so they can be restored after the test module runs.
# ---------------------------------------------------------------------------

_SDK_MODULES = ['openai', 'langchain_openai']
_saved_sdk_modules = {name: sys.modules[name] for name in _SDK_MODULES if name in sys.modules}

# Mock openai SDK
_mock_openai = types.ModuleType('openai')


class _FakeOpenAI:
    def __init__(self, api_key=None):
        self.api_key = api_key
        self.chat = MagicMock()
        self.chat.completions = MagicMock()
        self.chat.completions.create = MagicMock()


class _FakeAPIStatusError(Exception):
    def __init__(self, message='', status_code=None, response=None):
        super().__init__(message)
        self.status_code = status_code
        self.response = response


class _FakeOpenAIError(Exception):
    pass


class _FakeAuthenticationError(_FakeOpenAIError):
    def __init__(self, message='', response=None, body=None):
        super().__init__(message)
        self.response = response
        self.body = body


class _FakeRateLimitError(_FakeOpenAIError):
    def __init__(self, message='', response=None, body=None):
        super().__init__(message)
        self.response = response
        self.body = body


class _FakeAPIConnectionError(_FakeOpenAIError):
    def __init__(self, message='', request=None):
        super().__init__(message)
        self.request = request


_mock_openai.OpenAI = _FakeOpenAI
_mock_openai.APIStatusError = _FakeAPIStatusError
_mock_openai.OpenAIError = _FakeOpenAIError
_mock_openai.AuthenticationError = _FakeAuthenticationError
_mock_openai.RateLimitError = _FakeRateLimitError
_mock_openai.APIConnectionError = _FakeAPIConnectionError
_mock_openai.APIError = _FakeOpenAIError

sys.modules['openai'] = _mock_openai

# Mock langchain_openai (used by openai_client.py Chat)
_mock_lc_openai = types.ModuleType('langchain_openai')
_mock_lc_openai.ChatOpenAI = MagicMock()
_mock_lc_openai.OpenAIEmbeddings = MagicMock()
sys.modules['langchain_openai'] = _mock_lc_openai


@pytest.fixture(autouse=True, scope='module')
def _restore_openai_sdk_modules():
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

from nodes.llm_openai.IGlobal import IGlobal  # noqa: E402
from nodes.llm_openai.IInstance import IInstance  # noqa: E402
from nodes.llm_base.IInstance import IInstanceGenericLLM  # noqa: E402


# ===================================================================
# IGlobal.validateConfig
# ===================================================================


class TestOpenAIValidateConfig:
    """Test suite for IGlobal.validateConfig."""

    def _make_iglobal(self, config, mock_config):
        mock_config.set_config('openai', config)
        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'openai'
        ig.glb.connConfig = config
        return ig

    def test_valid_config_succeeds(self, mock_config, warned_messages):
        """A valid config with good creds should produce no warnings."""
        config = {'apikey': 'sk-test-key', 'model': 'gpt-4o', 'modelTotalTokens': 4096}
        ig = self._make_iglobal(config, mock_config)
        ig.validateConfig()
        assert len(warned_messages) == 0

    def test_token_limit_zero_warns(self, mock_config, warned_messages):
        """Token limit of 0 should produce a warning."""
        config = {'apikey': 'sk-test', 'model': 'gpt-4o', 'modelTotalTokens': 0}
        ig = self._make_iglobal(config, mock_config)
        ig.validateConfig()
        assert any('Token limit' in m for m in warned_messages)

    def test_token_limit_negative_warns(self, mock_config, warned_messages):
        """Negative token limit should produce a warning."""
        config = {'apikey': 'sk-test', 'model': 'gpt-4o', 'modelTotalTokens': -5}
        ig = self._make_iglobal(config, mock_config)
        ig.validateConfig()
        assert any('Token limit' in m for m in warned_messages)

    def test_token_limit_none_passes(self, mock_config, warned_messages):
        """None token limit (not provided) should not produce a warning."""
        config = {'apikey': 'sk-test', 'model': 'gpt-4o', 'modelTotalTokens': None}
        ig = self._make_iglobal(config, mock_config)
        ig.validateConfig()
        assert len(warned_messages) == 0

    def test_authentication_error_warns(self, mock_config, warned_messages):
        """AuthenticationError should be caught and produce a warning."""
        config = {'apikey': 'bad-key', 'model': 'gpt-4o', 'modelTotalTokens': None}
        ig = self._make_iglobal(config, mock_config)

        with patch.object(_FakeOpenAI, '__init__', return_value=None):
            fake_client = _FakeOpenAI()
            fake_client.chat = MagicMock()
            fake_client.chat.completions = MagicMock()
            fake_client.chat.completions.create = MagicMock(side_effect=_FakeAuthenticationError('Incorrect API key provided: bad-key'))
            with patch('openai.OpenAI', return_value=fake_client):
                ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'Incorrect API key' in warned_messages[0]

    def test_rate_limit_error_warns(self, mock_config, warned_messages):
        """RateLimitError should be caught and produce a warning."""
        config = {'apikey': 'sk-test', 'model': 'gpt-4o', 'modelTotalTokens': None}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakeOpenAI()
        fake_client.chat.completions.create = MagicMock(side_effect=_FakeRateLimitError('Rate limit exceeded'))
        with patch('openai.OpenAI', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'Rate limit' in warned_messages[0]

    def test_api_connection_error_warns(self, mock_config, warned_messages):
        """APIConnectionError should be caught and produce a warning."""
        config = {'apikey': 'sk-test', 'model': 'gpt-4o', 'modelTotalTokens': None}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakeOpenAI()
        fake_client.chat.completions.create = MagicMock(side_effect=_FakeAPIConnectionError('Connection error'))
        with patch('openai.OpenAI', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'Connection error' in warned_messages[0]

    @pytest.mark.parametrize('model', ['gpt-5', 'gpt-5.1', 'gpt-5-mini', 'gpt-5-nano'])
    def test_newer_models_use_max_completion_tokens(self, model, mock_config, warned_messages):
        """Newer GPT-5 models should use max_completion_tokens parameter."""
        config = {'apikey': 'sk-test', 'model': model, 'modelTotalTokens': None}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakeOpenAI()
        with patch('openai.OpenAI', return_value=fake_client):
            ig.validateConfig()

        # Verify max_completion_tokens was used (not max_tokens)
        call_kwargs = fake_client.chat.completions.create.call_args
        assert 'max_completion_tokens' in call_kwargs.kwargs or (len(call_kwargs.args) == 0 and 'max_completion_tokens' in (call_kwargs[1] if len(call_kwargs) > 1 else {}))

    def test_older_model_uses_max_tokens(self, mock_config, warned_messages):
        """Older models (gpt-4o) should use max_tokens parameter."""
        config = {'apikey': 'sk-test', 'model': 'gpt-4o', 'modelTotalTokens': None}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakeOpenAI()
        with patch('openai.OpenAI', return_value=fake_client):
            ig.validateConfig()

        call_kwargs = fake_client.chat.completions.create.call_args
        assert call_kwargs is not None
        _, kw = call_kwargs
        assert 'max_tokens' in kw
        assert kw['max_tokens'] == 1

    def test_api_status_error_with_json_body(self, mock_config, warned_messages):
        """APIStatusError with structured JSON body should be parsed for the warning."""
        config = {'apikey': 'sk-test', 'model': 'gpt-4o', 'modelTotalTokens': None}
        ig = self._make_iglobal(config, mock_config)

        mock_response = MagicMock()
        mock_response.json.return_value = {
            'error': {
                'type': 'invalid_request_error',
                'message': 'The model does not exist',
            }
        }
        err = _FakeAPIStatusError('API error', status_code=404, response=mock_response)

        fake_client = _FakeOpenAI()
        fake_client.chat.completions.create = MagicMock(side_effect=err)
        with patch('openai.OpenAI', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'invalid_request_error' in warned_messages[0]
        assert 'The model does not exist' in warned_messages[0]


# ===================================================================
# IGlobal.beginGlobal / endGlobal
# ===================================================================


class TestOpenAIBeginEndGlobal:
    """Test suite for IGlobal.beginGlobal and endGlobal lifecycle."""

    def test_begin_global_config_mode_does_not_create_chat(self, mock_config, mock_endpoint_config):
        """In CONFIG mode, beginGlobal should not create a Chat instance."""
        config = {'apikey': 'sk-test', 'model': 'gpt-4o'}
        mock_config.set_config('openai', config)

        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'openai'
        ig.glb.connConfig = config
        ig.IEndpoint = mock_endpoint_config

        ig.beginGlobal()
        assert getattr(ig, '_chat', None) is None

    def test_begin_global_write_mode_creates_chat(self, mock_config, mock_endpoint):
        """In WRITE mode, beginGlobal should create a Chat instance."""
        config = {'apikey': 'sk-test', 'model': 'gpt-4o'}
        mock_config.set_config('openai', config)

        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'openai'
        ig.glb.connConfig = config
        ig.IEndpoint = mock_endpoint

        # Mock the Chat class imported inside beginGlobal
        mock_chat = MagicMock()
        with patch('nodes.llm_openai.openai_client.Chat', return_value=mock_chat):
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


class TestOpenAIIInstance:
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

    def test_invoke_ask_operation(self):
        """Invoke with op='ask' should delegate to _question."""
        inst = IInstance()
        mock_answer = MagicMock()
        inst.IGlobal = MagicMock()
        inst.IGlobal._chat.chat.return_value = mock_answer

        from conftest import IInvokeLLM

        question = MagicMock()
        param = IInvokeLLM(op='ask', question=question)

        result = inst.invoke(param)
        assert result is mock_answer

    def test_invoke_get_context_length(self):
        """Invoke with op='getContextLength' should return total tokens."""
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal._chat.getTotalTokens.return_value = 8192

        from conftest import IInvokeLLM

        param = IInvokeLLM(op='getContextLength')

        result = inst.invoke(param)
        assert result == 8192

    def test_invoke_get_output_length(self):
        """Invoke with op='getOutputLength' should return output tokens."""
        inst = IInstance()
        inst.IGlobal = MagicMock()
        inst.IGlobal._chat.getOutputTokens.return_value = 2048

        from conftest import IInvokeLLM

        param = IInvokeLLM(op='getOutputLength')

        result = inst.invoke(param)
        assert result == 2048

    def test_invoke_get_token_counter(self):
        """Invoke with op='getTokenCounter' should return a callable."""
        inst = IInstance()
        inst.IGlobal = MagicMock()
        token_fn = MagicMock()
        inst.IGlobal._chat.getTokens = token_fn

        from conftest import IInvokeLLM

        param = IInvokeLLM(op='getTokenCounter')

        result = inst.invoke(param)
        assert result is token_fn

    def test_invoke_unknown_op_raises(self):
        """Invoke with an unknown op should raise an exception."""
        inst = IInstance()
        inst.IGlobal = MagicMock()

        from conftest import IInvokeLLM

        param = IInvokeLLM(op='unknownOp')

        with pytest.raises(Exception, match='not defined'):
            inst.invoke(param)

    def test_invoke_wrong_param_type_raises(self):
        """Invoke with wrong param type should raise an exception."""
        inst = IInstance()
        inst.IGlobal = MagicMock()

        with pytest.raises(Exception, match='IInvokeLLM'):
            inst.invoke({'op': 'ask'})
