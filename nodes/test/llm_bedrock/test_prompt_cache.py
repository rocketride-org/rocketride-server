# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Claude on Bedrock: the unchanging start of an agent prompt is marked for caching,
and tokens read from the cache are metered as input.

An agent resends its whole prompt every round, and most of it (role, tool list,
rules) never changes. Bedrock's own caching of Claude prompts is best effort; a
cache_control marker at the end of the unchanging start makes it eligible every call.
The Anthropic driver places one (ChatBase publishes the prefix); the Bedrock driver
did not.

Bedrock also counts input differently from LangChain: its input count leaves out
cached tokens, and langchain-aws passes it on as is for InvokeModel. The token meter
subtracts the cache detail from input_tokens, so a call that read 1,800 tokens from
the cache and 200 fresh was metered as 0 fresh input.

These tests run the real node driver and the real langchain-aws client against a
local HTTP server that plays Bedrock and records each request, so they check what
goes on the wire and what gets metered. No key or network is used.
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

_SONNET = 'anthropic.claude-sonnet-4-5-20250929-v1:0'
_ANSWER = '```json\n{"done": true, "answer": "ok"}\n```'

# What the server reports for every call: 200 fresh input tokens, 1,800 read from the
# cache, 5 output tokens. Bedrock's input count (the first) leaves the cached ones out.
_FRESH, _CACHE_READ, _OUTPUT = 200, 1800, 5


def _event(payload: dict) -> bytes:
    """One AWS event-stream message holding *payload* as a Bedrock response chunk."""
    body = json.dumps({'bytes': base64.b64encode(json.dumps(payload).encode()).decode()}).encode()
    headers = b''
    for name, value in ((':event-type', 'chunk'), (':content-type', 'application/json'), (':message-type', 'event')):
        headers += bytes([len(name)]) + name.encode() + b'\x07' + struct.pack('>H', len(value)) + value.encode()
    prelude = struct.pack('>II', 16 + len(headers) + len(body), len(headers))
    message = prelude + struct.pack('>I', binascii.crc32(prelude)) + headers + body
    return message + struct.pack('>I', binascii.crc32(message))


def _anthropic_stream(model: str) -> bytes:
    """The events Bedrock streams for a short Claude reply, ending with its usage."""
    events = [
        {
            'type': 'message_start',
            'message': {
                'id': 'msg_1',
                'type': 'message',
                'role': 'assistant',
                'model': model,
                'content': [],
                'usage': {'input_tokens': _FRESH, 'output_tokens': 1},
            },
        },
        {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
        {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': _ANSWER}},
        {'type': 'content_block_stop', 'index': 0},
        {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': _OUTPUT}},
        {
            'type': 'message_stop',
            'amazon-bedrock-invocationMetrics': {
                'inputTokenCount': _FRESH,
                'outputTokenCount': _OUTPUT,
                'invocationLatency': 10,
                'firstByteLatency': 5,
                'cacheReadInputTokenCount': _CACHE_READ,
                'cacheWriteInputTokenCount': 0,
            },
        },
    ]
    return b''.join(_event(e) for e in events)


class _Bedrock(BaseHTTPRequestHandler):
    """Plays bedrock-runtime: InvokeModel, InvokeModelWithResponseStream and Converse."""

    requests: list = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length') or 0)))
        _, _, model, action = unquote(self.path).split('/', 3)
        _Bedrock.requests.append({'action': action, 'model': model, 'body': body})
        headers = {}
        if action == 'invoke':
            data = json.dumps(
                {
                    'id': 'msg_1',
                    'type': 'message',
                    'role': 'assistant',
                    'model': model,
                    'content': [{'type': 'text', 'text': _ANSWER}],
                    'stop_reason': 'end_turn',
                    'stop_sequence': None,
                    'usage': {
                        'input_tokens': _FRESH,
                        'output_tokens': _OUTPUT,
                        'cache_read_input_tokens': _CACHE_READ,
                        'cache_creation_input_tokens': 0,
                    },
                }
            ).encode()
            content_type = 'application/json'
            headers = {
                'x-amzn-bedrock-input-token-count': str(_FRESH),
                'x-amzn-bedrock-output-token-count': str(_OUTPUT),
                'x-amzn-bedrock-cache-read-input-token-count': str(_CACHE_READ),
                'x-amzn-bedrock-cache-write-input-token-count': '0',
            }
        elif action == 'invoke-with-response-stream':
            data = _anthropic_stream(model)
            content_type = 'application/vnd.amazon.eventstream'
        else:  # converse: Nova, which langchain-aws routes through the Converse API
            data = json.dumps(
                {
                    'output': {'message': {'role': 'assistant', 'content': [{'text': _ANSWER}]}},
                    'stopReason': 'end_turn',
                    'usage': {
                        'inputTokens': _FRESH,
                        'outputTokens': _OUTPUT,
                        'cacheReadInputTokens': _CACHE_READ,
                        'cacheWriteInputTokens': 0,
                        'totalTokens': _FRESH + _CACHE_READ + _OUTPUT,
                    },
                    'metrics': {'latencyMs': 10},
                }
            ).encode()
            content_type = 'application/json'
        self.send_response(200)
        self.send_header('content-type', content_type)
        self.send_header('content-length', str(len(data)))
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def server(monkeypatch):
    _Bedrock.requests = []
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), _Bedrock)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv('AWS_ENDPOINT_URL_BEDROCK_RUNTIME', f'http://127.0.0.1:{httpd.server_address[1]}')
    yield _Bedrock.requests
    httpd.shutdown()


def _load_driver():
    spec = importlib.util.spec_from_file_location('_llm_bedrock_cache_test', _MOD_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _chat(monkeypatch, model: str = _SONNET):
    config = {
        'model': model,
        'accessKey': 'AKIDEXAMPLE',
        'secretKey': 'secret-example',
        'region': 'us-east-1',
        'modelTotalTokens': 200000,
        'modelOutputTokens': 8192,
    }
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    chat = _load_driver().Chat('bedrock', {}, {})
    # Counting is not what these tests are about; a fixed estimate keeps them
    # independent of how the node counts tokens.
    chat.getTokens = lambda value: (len(value) + 3) // 4
    return chat


def _agent_question(scratch: str, cache: bool = True, json_reply: bool = True) -> Question:
    q = Question(role='You are a planning agent.', expectJson=json_reply)
    q.cachePrefix = cache
    q.addInstruction('Available Tools', 'tool list ' * 200)
    q.addInstruction('Rules', '- Plan carefully.')
    q.addContext(f'Scratch: {scratch}')
    q.addGoal('Make the header blue.')
    q.addQuestion('Plan the next set of tool calls.')
    return q


def test_the_unchanging_start_is_marked_and_the_rest_is_not(monkeypatch, server):
    chat = _chat(monkeypatch)
    question = _agent_question('round 1')

    chat.chat(question)

    assert server[0]['action'] == 'invoke'
    content = server[0]['body']['messages'][0]['content']
    assert isinstance(content, list) and len(content) == 2
    assert content[0]['cache_control'] == {'type': 'ephemeral'}
    assert 'cache_control' not in content[1]
    assert content[0]['text'] + content[1]['text'] == question.getPrompt()
    assert content[1]['text'].lstrip().startswith('### Context:')


def test_the_marked_start_is_identical_across_rounds(monkeypatch, server):
    """Only an identical prefix can be read back from the cache."""
    chat = _chat(monkeypatch)

    chat.chat(_agent_question('round 1'))
    chat.chat(_agent_question('round 2: read App.css, it is revision 1'))

    first, second = (r['body']['messages'][0]['content'] for r in server)
    assert first[0]['text'] == second[0]['text']
    assert first[1]['text'] != second[1]['text']


def test_a_streamed_reply_is_marked_too(monkeypatch, server):
    """A question without expectJson streams; that request is built by a second method."""
    chat = _chat(monkeypatch)
    question = _agent_question('round 1', json_reply=False)

    chat.chat(question, on_chunk=lambda text: None)

    assert server[0]['action'] == 'invoke-with-response-stream'
    content = server[0]['body']['messages'][0]['content']
    assert content[0]['cache_control'] == {'type': 'ephemeral'}
    assert content[0]['text'] + content[1]['text'] == question.getPrompt()


def test_without_the_flag_the_request_is_unchanged(monkeypatch, server):
    """Questions that do not ask for caching send one plain string, as before."""
    chat = _chat(monkeypatch)
    question = _agent_question('round 1', cache=False)

    chat.chat(question)

    assert server[0]['body']['messages'][0]['content'] == question.getPrompt()
    assert 'cache_control' not in json.dumps(server[0]['body'])


def test_a_claude_model_without_caching_never_gets_the_marker(monkeypatch, server):
    """Bedrock rejects the marker for Claude models that have no caching (ValidationException)."""
    chat = _chat(monkeypatch, model='anthropic.claude-3-haiku-20240307-v1:0')
    question = _agent_question('round 1')

    chat.chat(question)

    assert server[0]['body']['messages'][0]['content'] == question.getPrompt()


@pytest.mark.parametrize(
    'model, marked',
    [
        ('us.anthropic.claude-sonnet-4-5-20250929-v1:0', True),
        ('eu.anthropic.claude-opus-4-20250514-v1:0', True),
        ('us.anthropic.claude-haiku-4-5-20251001-v1:0', True),
        ('us.anthropic.claude-3-7-sonnet-20250219-v1:0', True),
        ('us.anthropic.claude-3-5-haiku-20241022-v1:0', True),
        ('global.anthropic.claude-opus-5', True),  # a Claude newer than this code
        ('us.anthropic.claude-3-haiku-20240307-v1:0', False),
        ('us.anthropic.claude-3-opus-20240229-v1:0', False),
        ('us.anthropic.claude-3-5-sonnet-20241022-v2:0', False),  # caching only in preview
        ('us.anthropic.claude-v2:1', False),
        ('us.anthropic.claude-instant-v1', False),
        ('us.meta.llama3-3-70b-instruct-v1:0', False),
        ('us.amazon.nova-2-lite-v1:0', False),
    ],
)
def test_which_models_get_the_marker(model, marked):
    assert _load_driver()._accepts_cache_marker(model) is marked


def _metered(chat, question, **callbacks) -> dict:
    with turn_usage() as read:
        chat.chat(question, **callbacks)
    return read()


def test_fresh_input_is_still_metered_when_the_cache_was_read(monkeypatch, server):
    """Before: input 200 (Bedrock's fresh count) minus 1,800 cached, clamped to 0 fresh."""
    chat = _chat(monkeypatch)

    usage = _metered(chat, _agent_question('round 1'))

    assert (usage['input'], usage['cache_read'], usage['output']) == (_FRESH, _CACHE_READ, _OUTPUT)


def test_a_streamed_reply_is_metered_the_same_way(monkeypatch, server):
    chat = _chat(monkeypatch)

    usage = _metered(chat, _agent_question('round 1', json_reply=False), on_chunk=lambda text: None)

    assert server[0]['action'] == 'invoke-with-response-stream'
    assert (usage['input'], usage['cache_read'], usage['output']) == (_FRESH, _CACHE_READ, _OUTPUT)


def test_nova_is_not_counted_twice(monkeypatch, server):
    """Nova goes through the Converse API, where langchain-aws already adds the cached tokens."""
    chat = _chat(monkeypatch, model='amazon.nova-2-lite-v1:0')

    usage = _metered(chat, _agent_question('round 1'))

    assert server[0]['action'] == 'converse'
    assert 'cachePoint' not in json.dumps(server[0]['body'])
    assert (usage['input'], usage['cache_read'], usage['output']) == (_FRESH, _CACHE_READ, _OUTPUT)
