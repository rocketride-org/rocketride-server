# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A streamed Llama or Mistral reply that reaches the output limit is still metered.

langchain-aws (1.9.0 and before) reports a streamed Meta or Mistral reply's usage only
when it stops with "stop". Bedrock stops one that reaches max_gen_len / max_tokens with
"length", and the reply was metered as nothing, though Bedrock sent the counts in the
last chunk. The driver reports those counts once when the stream ends without usage.

Like test_prompt_cache.py, these run the real driver and the real langchain-aws client
against a local HTTP server that plays Bedrock. No key or network is used.
"""

from __future__ import annotations

import base64
import binascii
import importlib.util
import json
import os
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

import pytest

pytest.importorskip('langchain_aws')

from ai.common.config import Config  # noqa: E402
from ai.common.llm_adapter import turn_usage  # noqa: E402
from ai.common.schema import Question  # noqa: E402

_MOD_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'nodes', 'llm_bedrock', 'bedrock.py'
)

_LLAMA = 'meta.llama3-3-70b-instruct-v1:0'
_MISTRAL = 'mistral.mistral-large-2407-v1:0'
_INPUT, _OUTPUT = 30, 50


def _event(payload: dict) -> bytes:
    """One AWS event-stream message holding *payload* as a Bedrock response chunk."""
    body = json.dumps({'bytes': base64.b64encode(json.dumps(payload).encode()).decode()}).encode()
    headers = b''
    for name, value in ((':event-type', 'chunk'), (':content-type', 'application/json'), (':message-type', 'event')):
        headers += bytes([len(name)]) + name.encode() + b'\x07' + struct.pack('>H', len(value)) + value.encode()
    prelude = struct.pack('>II', 16 + len(headers) + len(body), len(headers))
    message = prelude + struct.pack('>I', binascii.crc32(prelude)) + headers + body
    return message + struct.pack('>I', binascii.crc32(message))


_METRICS = {
    'inputTokenCount': _INPUT,
    'outputTokenCount': _OUTPUT,
    'invocationLatency': 10,
    'firstByteLatency': 5,
}


def _llama_stream(stop_reason: str) -> bytes:
    events = [
        {
            'generation': 'The history of bridges',
            'prompt_token_count': _INPUT,
            'generation_token_count': 5,
            'stop_reason': None,
        },
        {'generation': ' begins with', 'prompt_token_count': None, 'generation_token_count': 8, 'stop_reason': None},
        {
            'generation': '',
            'prompt_token_count': None,
            'generation_token_count': _OUTPUT,
            'stop_reason': stop_reason,
            'amazon-bedrock-invocationMetrics': dict(_METRICS),
        },
    ]
    return b''.join(_event(e) for e in events)


def _mistral_stream(stop_reason: str) -> bytes:
    events = [
        {'outputs': [{'text': 'The history of bridges', 'stop_reason': None}]},
        {
            'outputs': [{'text': ' begins with', 'stop_reason': stop_reason}],
            'amazon-bedrock-invocationMetrics': dict(_METRICS),
        },
    ]
    return b''.join(_event(e) for e in events)


class _Bedrock(BaseHTTPRequestHandler):
    """Plays bedrock-runtime InvokeModelWithResponseStream for Llama and Mistral."""

    requests: list = []
    stop_reason = 'length'

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length') or 0)))
        _, _, model, action = unquote(self.path).split('/', 3)
        _Bedrock.requests.append({'action': action, 'model': model, 'body': body})
        data = _mistral_stream(_Bedrock.stop_reason) if 'mistral' in model else _llama_stream(_Bedrock.stop_reason)
        self.send_response(200)
        self.send_header('content-type', 'application/vnd.amazon.eventstream')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def server(monkeypatch):
    _Bedrock.requests = []
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), _Bedrock)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv('AWS_ENDPOINT_URL_BEDROCK_RUNTIME', f'http://127.0.0.1:{httpd.server_address[1]}')
    yield _Bedrock
    httpd.shutdown()


def _chat(monkeypatch, model: str):
    config = {
        'model': model,
        'accessKey': 'AKIDEXAMPLE',
        'secretKey': 'secret-example',
        'region': 'us-east-1',
        'modelTotalTokens': 128000,
        'modelOutputTokens': 1024,
    }
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    spec = importlib.util.spec_from_file_location('_llm_bedrock_length_test', _MOD_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    chat = module.Chat('bedrock', {}, {})
    chat.getTokens = lambda value: (len(value) + 3) // 4
    return chat


def _streamed_usage(chat) -> dict:
    question = Question(role='You are a writer.')
    question.addQuestion('Write a long essay on the history of bridges.')
    with turn_usage() as read:
        chat.chat(question, on_chunk=lambda text: None)
    return read() or {}


@pytest.mark.parametrize('model', [_LLAMA, _MISTRAL])
def test_a_reply_that_reaches_the_output_limit_is_metered(monkeypatch, server, model):
    server.stop_reason = 'length'
    usage = _streamed_usage(_chat(monkeypatch, model))

    assert server.requests[0]['action'] == 'invoke-with-response-stream'
    # Counted twice would read 60 and 100.
    assert (usage.get('input'), usage.get('output')) == (_INPUT, _OUTPUT)


@pytest.mark.parametrize('model', [_LLAMA, _MISTRAL])
def test_a_reply_that_stops_normally_is_metered_once(monkeypatch, server, model):
    server.stop_reason = 'stop'
    usage = _streamed_usage(_chat(monkeypatch, model))

    # Counted twice would read 60 and 100.
    assert (usage.get('input'), usage.get('output')) == (_INPUT, _OUTPUT)


@pytest.mark.parametrize('model', [_LLAMA, _MISTRAL])
@pytest.mark.parametrize('stop_reason', ['length', 'stop'])
def test_exactly_one_chunk_carries_the_usage(monkeypatch, server, model, stop_reason):
    """The turn total takes the larger of repeated counts, so it cannot show a usage sent twice; the chunks can."""
    from langchain_core.messages import HumanMessage

    server.stop_reason = stop_reason
    chunks = list(_chat(monkeypatch, model)._llm._stream([HumanMessage(content='Write a long essay.')]))
    usages = [chunk.message.usage_metadata for chunk in chunks if chunk.message.usage_metadata]

    assert len(usages) == 1
    assert (usages[0]['input_tokens'], usages[0]['output_tokens']) == (_INPUT, _OUTPUT)
