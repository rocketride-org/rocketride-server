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

"""Tests for the Gemini LLM pipeline node (llm_gemini).

Covers IGlobal.validateConfig (success, various Google API errors, response
modality skip), _format_error and _extract_status_message_code helpers,
IGlobal.beginGlobal / endGlobal lifecycle, and IInstance inheritance.
"""

import sys
import types
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Provider SDK mocks — Google GenAI and google.api_core
# ---------------------------------------------------------------------------

# Mock google.genai
_mock_google = types.ModuleType('google')
_mock_google_genai = types.ModuleType('google.genai')


class _FakeGenAIClient:
    def __init__(self, api_key=None):
        self.api_key = api_key
        self.models = MagicMock()
        self.models.generate_content = MagicMock()


_mock_google_genai.Client = _FakeGenAIClient
_mock_google.genai = _mock_google_genai

# Mock google.api_core.exceptions
_mock_google_api_core = types.ModuleType('google.api_core')
_mock_google_api_core_exceptions = types.ModuleType('google.api_core.exceptions')


class _FakeGoogleAPICallError(Exception):
    def __init__(self, message='', code=None):
        super().__init__(message)
        self.code = code


class _FakeClientError(_FakeGoogleAPICallError):
    pass


class _FakeBadRequest(_FakeClientError):
    pass


class _FakeUnauthorized(_FakeClientError):
    pass


class _FakeForbidden(_FakeClientError):
    pass


class _FakeNotFound(_FakeClientError):
    pass


class _FakeTooManyRequests(_FakeClientError):
    pass


class _FakeServiceUnavailable(_FakeGoogleAPICallError):
    pass


class _FakeInternalServerError(_FakeGoogleAPICallError):
    pass


class _FakeDeadlineExceeded(_FakeGoogleAPICallError):
    pass


class _FakeInvalidArgument(_FakeClientError):
    pass


_mock_google_api_core_exceptions.GoogleAPICallError = _FakeGoogleAPICallError
_mock_google_api_core_exceptions.ClientError = _FakeClientError
_mock_google_api_core_exceptions.BadRequest = _FakeBadRequest
_mock_google_api_core_exceptions.Unauthorized = _FakeUnauthorized
_mock_google_api_core_exceptions.Forbidden = _FakeForbidden
_mock_google_api_core_exceptions.NotFound = _FakeNotFound
_mock_google_api_core_exceptions.TooManyRequests = _FakeTooManyRequests
_mock_google_api_core_exceptions.ServiceUnavailable = _FakeServiceUnavailable
_mock_google_api_core_exceptions.InternalServerError = _FakeInternalServerError
_mock_google_api_core_exceptions.DeadlineExceeded = _FakeDeadlineExceeded
_mock_google_api_core_exceptions.InvalidArgument = _FakeInvalidArgument

# Mock google.auth.exceptions
_mock_google_auth = types.ModuleType('google.auth')
_mock_google_auth_exceptions = types.ModuleType('google.auth.exceptions')


class _FakeGoogleAuthError(Exception):
    pass


class _FakeRefreshError(Exception):
    pass


_mock_google_auth_exceptions.GoogleAuthError = _FakeGoogleAuthError
_mock_google_auth_exceptions.RefreshError = _FakeRefreshError

sys.modules['google'] = _mock_google
sys.modules['google.genai'] = _mock_google_genai
sys.modules['google.api_core'] = _mock_google_api_core
sys.modules['google.api_core.exceptions'] = _mock_google_api_core_exceptions
sys.modules['google.auth'] = _mock_google_auth
sys.modules['google.auth.exceptions'] = _mock_google_auth_exceptions

# ---------------------------------------------------------------------------
# Import the node under test
# ---------------------------------------------------------------------------

import os

_nodes_src = os.path.join(os.path.dirname(__file__), '..', '..', 'nodes', 'src')
if _nodes_src not in sys.path:
    sys.path.insert(0, os.path.abspath(_nodes_src))

from nodes.llm_gemini.IGlobal import IGlobal  # noqa: E402
from nodes.llm_gemini.IInstance import IInstance  # noqa: E402
from nodes.llm_base.IInstance import IInstanceGenericLLM  # noqa: E402


# ===================================================================
# IGlobal.validateConfig
# ===================================================================


class TestGeminiValidateConfig:
    """Test suite for IGlobal.validateConfig."""

    def _make_iglobal(self, config, mock_config):
        mock_config.set_config('gemini', config)
        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'gemini'
        ig.glb.connConfig = config
        return ig

    def test_valid_config_succeeds(self, mock_config, warned_messages):
        """A valid config should produce no warnings."""
        config = {'apikey': 'AIzaSyTest', 'model': 'gemini-pro'}
        ig = self._make_iglobal(config, mock_config)
        ig.validateConfig()
        assert len(warned_messages) == 0

    def test_unauthorized_error_warns(self, mock_config, warned_messages):
        """Unauthorized error should produce a warning."""
        config = {'apikey': 'bad-key', 'model': 'gemini-pro'}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakeGenAIClient()
        fake_client.models.generate_content = MagicMock(side_effect=_FakeUnauthorized('API key not valid', code=401))
        with patch('google.genai.Client', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'API key not valid' in warned_messages[0]

    def test_not_found_error_warns(self, mock_config, warned_messages):
        """NotFound error should produce a warning."""
        config = {'apikey': 'AIzaSyTest', 'model': 'bad-model'}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakeGenAIClient()
        fake_client.models.generate_content = MagicMock(side_effect=_FakeNotFound('Model not found', code=404))
        with patch('google.genai.Client', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'Model not found' in warned_messages[0]

    def test_too_many_requests_warns(self, mock_config, warned_messages):
        """TooManyRequests error should produce a warning."""
        config = {'apikey': 'AIzaSyTest', 'model': 'gemini-pro'}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakeGenAIClient()
        fake_client.models.generate_content = MagicMock(side_effect=_FakeTooManyRequests('Rate limit exceeded', code=429))
        with patch('google.genai.Client', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'Rate limit' in warned_messages[0]

    def test_invalid_argument_response_modalities_skipped(self, mock_config, warned_messages):
        """INVALID_ARGUMENT about response modalities should NOT warn (not a config error)."""
        config = {'apikey': 'AIzaSyTest', 'model': 'gemini-2.0-flash-exp'}
        ig = self._make_iglobal(config, mock_config)

        # The exception string must contain a JSON payload with INVALID_ARGUMENT status
        # and a message mentioning response modalities
        json_body = '{"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "response modalities are not supported"}}'
        fake_client = _FakeGenAIClient()
        fake_client.models.generate_content = MagicMock(side_effect=_FakeInvalidArgument(f'400 INVALID_ARGUMENT. {json_body}', code=400))
        with patch('google.genai.Client', return_value=fake_client):
            ig.validateConfig()

        # Should NOT have warned — response modality errors are skipped
        assert len(warned_messages) == 0

    def test_google_auth_error_warns(self, mock_config, warned_messages):
        """GoogleAuthError should produce a warning."""
        config = {'apikey': 'AIzaSyTest', 'model': 'gemini-pro'}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakeGenAIClient()
        fake_client.models.generate_content = MagicMock(side_effect=_FakeGoogleAuthError('Auth error'))
        with patch('google.genai.Client', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'Auth error' in warned_messages[0]

    def test_generic_exception_fallback(self, mock_config, warned_messages):
        """Generic exceptions should be caught and produce a warning."""
        config = {'apikey': 'AIzaSyTest', 'model': 'gemini-pro'}
        ig = self._make_iglobal(config, mock_config)

        fake_client = _FakeGenAIClient()
        fake_client.models.generate_content = MagicMock(side_effect=Exception('Unexpected error occurred'))
        with patch('google.genai.Client', return_value=fake_client):
            ig.validateConfig()

        assert len(warned_messages) == 1
        assert 'Unexpected error' in warned_messages[0]


# ===================================================================
# IGlobal._format_error
# ===================================================================


class TestGeminiFormatError:
    """Test suite for the _format_error helper."""

    def _make_iglobal(self):
        ig = IGlobal()
        ig.glb = MagicMock()
        return ig

    def test_format_with_all_fields(self):
        """Should format: 'Error <code>: <status> - <message>'."""
        ig = self._make_iglobal()
        result = ig._format_error(400, 'INVALID_ARGUMENT', 'Bad request', 'fallback')
        assert result == 'Error 400: INVALID_ARGUMENT - Bad request'

    def test_format_with_code_only(self):
        """Should format: 'Error <code>:'."""
        ig = self._make_iglobal()
        result = ig._format_error(500, None, None, 'fallback')
        assert result == 'Error 500:'

    def test_format_falls_back(self):
        """No structured fields should return the fallback."""
        ig = self._make_iglobal()
        result = ig._format_error(None, None, None, 'Something broke')
        assert result == 'Something broke'


# ===================================================================
# IGlobal._extract_status_message_code
# ===================================================================


class TestGeminiExtractStatusMessageCode:
    """Test suite for the _extract_status_message_code helper."""

    def _make_iglobal(self):
        ig = IGlobal()
        ig.glb = MagicMock()
        return ig

    def test_extract_from_json_body(self):
        """Should extract status, message, and code from a JSON body."""
        ig = self._make_iglobal()
        raw = '400 INVALID_ARGUMENT. {"error": {"code": 400, "status": "INVALID_ARGUMENT", "message": "Bad request"}}'
        status, emsg, code = ig._extract_status_message_code(raw, None)
        assert status == 'INVALID_ARGUMENT'
        assert emsg == 'Bad request'
        assert code == 400

    def test_extract_from_regex_when_no_json(self):
        """Should fall back to regex extraction when no JSON found."""
        ig = self._make_iglobal()
        raw = "403 FORBIDDEN 'message': 'Access denied'"
        status, emsg, code = ig._extract_status_message_code(raw, None)
        assert status == 'FORBIDDEN'
        assert emsg == 'Access denied'
        assert code == 403

    def test_extract_returns_nones_for_empty_string(self):
        """Empty string should return all Nones."""
        ig = self._make_iglobal()
        status, emsg, code = ig._extract_status_message_code('', None)
        assert status is None
        assert emsg is None
        assert code is None

    def test_extract_uses_prov_code_fallback(self):
        """Should use prov_code if no code found in string."""
        ig = self._make_iglobal()
        # Use a format where the JSON is a single top-level dict (no nested braces)
        # so rfind('{') finds the right starting point.
        raw = '503 UNAVAILABLE. Service is unavailable'
        status, emsg, code = ig._extract_status_message_code(raw, 503)
        assert status == 'UNAVAILABLE'
        assert code == 503


# ===================================================================
# IGlobal.beginGlobal / endGlobal
# ===================================================================


class TestGeminiBeginEndGlobal:
    """Test suite for IGlobal.beginGlobal and endGlobal lifecycle."""

    def test_begin_global_config_mode_does_not_create_chat(self, mock_config, mock_endpoint_config):
        """In CONFIG mode, beginGlobal should not create a Chat instance."""
        config = {'apikey': 'AIzaSyTest', 'model': 'gemini-pro'}
        mock_config.set_config('gemini', config)

        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'gemini'
        ig.glb.connConfig = config
        ig.IEndpoint = mock_endpoint_config

        ig.beginGlobal()
        assert not hasattr(ig, '_chat') or ig._chat is None or ig.chat is None

    def test_begin_global_write_mode_creates_chat(self, mock_config, mock_endpoint):
        """In WRITE mode, beginGlobal should create a Chat instance."""
        config = {'apikey': 'AIzaSyTest', 'model': 'gemini-pro'}
        mock_config.set_config('gemini', config)

        ig = IGlobal()
        ig.glb = MagicMock()
        ig.glb.logicalType = 'gemini'
        ig.glb.connConfig = config
        ig.IEndpoint = mock_endpoint

        mock_chat = MagicMock()
        with patch('nodes.llm_gemini.gemini.Chat', return_value=mock_chat):
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


class TestGeminiIInstance:
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
