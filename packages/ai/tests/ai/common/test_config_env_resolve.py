"""Unit tests for ${ROCKETRIDE_*} placeholder resolution in Config.getNodeConfig.

Pins the fix for issue #1105: an apikey field set via the env-var autocomplete
(e.g. "${ROCKETRIDE_ANTHROPIC_KEY}") must never reach a node's validateConfig()/
beginGlobal() as a literal, unresolved string -- callers that skip pipeline-level
resolution (e.g. the engine's live validateConfig probe) previously sent the raw
placeholder to the provider SDK, producing a silent 401.

Loaded by file path with rocketlib/json5 stubbed so no engine runtime is needed --
mirrors the approach in test_config_shapes.py.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

import pytest

_CONFIG_PATH = Path(__file__).resolve().parents[3] / 'src' / 'ai' / 'common' / 'config.py'

_SERVICE = {
    'preconfig': {
        'default': 'default',
        'profiles': {
            'default': {'apikey': '', 'model': 'claude'},
        },
    }
}


def _load_config():
    """Load config.py with rocketlib/json5 stubbed; patch getServiceDefinition."""
    saved = {k: sys.modules.get(k) for k in ('rocketlib', 'json5')}

    rl = types.ModuleType('rocketlib')

    class _IJson:
        @staticmethod
        def toDict(x):
            # Mirrors rocketlib.IJson.toDict: recursive, and a no-op on values
            # that are already native. getNodeConfig runs this immediately
            # before resolve_env_placeholders (which round-trips through
            # json.dumps), so a shallow stub here would not exercise the same
            # normalization the engine relies on.
            if isinstance(x, dict):
                return {k: _IJson.toDict(v) for k, v in x.items()}
            if isinstance(x, list):
                return [_IJson.toDict(v) for v in x]
            return x

    rl.IJson = _IJson
    rl.warning = lambda *a, **k: None
    rl.getServiceDefinition = lambda logical_type: _SERVICE
    sys.modules['rocketlib'] = rl
    sys.modules['json5'] = types.ModuleType('json5')

    try:
        spec = importlib.util.spec_from_file_location('rr_real_config_env_resolve', _CONFIG_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.Config
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v


Config = _load_config()


class TestApiKeyPlaceholderResolution:
    def test_allowed_placeholder_resolves(self):
        with patch.dict(os.environ, {'ROCKETRIDE_ANTHROPIC_KEY': 'sk-ant-real-key'}):
            cfg = Config.getNodeConfig('llm_anthropic', {'apikey': '${ROCKETRIDE_ANTHROPIC_KEY}'})
            assert cfg['apikey'] == 'sk-ant-real-key'

    def test_missing_placeholder_left_as_is(self):
        # Clear the variable rather than merely not setting it: the assertion is
        # that an *unset* var keeps its placeholder, so a runner that happens to
        # export ROCKETRIDE_MISSING_KEY would otherwise turn this green test red
        # (or, worse, mask a regression) depending on ambient environment.
        with patch.dict(os.environ):
            os.environ.pop('ROCKETRIDE_MISSING_KEY', None)
            cfg = Config.getNodeConfig('llm_anthropic', {'apikey': '${ROCKETRIDE_MISSING_KEY}'})
            assert cfg['apikey'] == '${ROCKETRIDE_MISSING_KEY}'

    def test_disallowed_var_redacted_not_leaked(self):
        with patch.dict(os.environ, {'AWS_SECRET_ACCESS_KEY': 'super-secret'}):
            cfg = Config.getNodeConfig('llm_anthropic', {'apikey': '${AWS_SECRET_ACCESS_KEY}'})
            assert cfg['apikey'] == '<REDACTED>'

    def test_plain_apikey_unchanged(self):
        cfg = Config.getNodeConfig('llm_anthropic', {'apikey': 'sk-ant-literal'})
        assert cfg['apikey'] == 'sk-ant-literal'

    def test_nested_profile_shape_resolves(self):
        with patch.dict(os.environ, {'ROCKETRIDE_ANTHROPIC_KEY': 'sk-ant-real-key'}):
            cfg = Config.getNodeConfig(
                'llm_anthropic',
                {'profile': 'default', 'default': {'apikey': '${ROCKETRIDE_ANTHROPIC_KEY}'}},
            )
            assert cfg['apikey'] == 'sk-ant-real-key'


# ==============================================================================
# End-to-end repro: the resolved key must reach the *actual outgoing HTTP
# request*, not just the in-memory config dict. This drives the real
# `anthropic` SDK the same way nodes/src/nodes/llm_anthropic/IGlobal.py's
# validateConfig() does (Anthropic(api_key=apikey).messages.create(...)),
# pointed at a local mock server instead of the real API, and inspects the
# captured x-api-key header. No network access or real API key required.
# ==============================================================================


class _CaptureHandler(BaseHTTPRequestHandler):
    # self.headers (email.message.Message) is case-insensitive on .get();
    # store the lookup result directly rather than a plain dict(), which
    # would preserve the wire casing ("X-Api-Key") and break a lowercase lookup.
    captured_api_key: str | None = None

    def do_POST(self):  # noqa: N802 (BaseHTTPRequestHandler API)
        _CaptureHandler.captured_api_key = self.headers.get('x-api-key')
        body = json.dumps(
            {
                'id': 'msg_test',
                'type': 'message',
                'role': 'assistant',
                'content': [{'type': 'text', 'text': 'hi'}],
                'model': 'claude-3-haiku-20240307',
                'stop_reason': 'end_turn',
                'stop_sequence': None,
                'usage': {'input_tokens': 1, 'output_tokens': 1},
            }
        ).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002 (silence request logging)
        pass


@pytest.fixture
def mock_anthropic_server():
    server = HTTPServer(('127.0.0.1', 0), _CaptureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join()


class TestResolvedApiKeyReachesOutgoingRequest:
    def test_placeholder_never_sent_as_x_api_key(self, mock_anthropic_server):
        from anthropic import Anthropic

        with patch.dict(os.environ, {'ROCKETRIDE_ANTHROPIC_KEY': 'sk-ant-test-repro-secret'}):
            # Same lookup every LLM node performs in validateConfig()/beginGlobal().
            cfg = Config.getNodeConfig('llm_anthropic', {'apikey': '${ROCKETRIDE_ANTHROPIC_KEY}'})
            apikey = cfg['apikey']

            port = mock_anthropic_server.server_address[1]
            client = Anthropic(api_key=apikey, base_url=f'http://127.0.0.1:{port}')
            client.messages.create(
                model='claude-3-haiku-20240307', max_tokens=1, messages=[{'role': 'user', 'content': 'Hi'}]
            )

        sent_key = _CaptureHandler.captured_api_key
        assert sent_key == 'sk-ant-test-repro-secret'
        assert sent_key != '${ROCKETRIDE_ANTHROPIC_KEY}'
