# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The Anthropic request marks the unchanging start of an agent prompt for caching.

An agent resends its whole prompt every round, and most of it (role, tool list,
rules) never changes. Anthropic reuses a prompt only up to an explicit cache_control
marker, and the prompt was sent as one text block, so every Wave round with Claude
paid for the full prompt again: 0 cached tokens on every run.

These tests run the real node driver and the real langchain-anthropic client against
a local HTTP server that records the request body, so they check what goes on the
wire. No key or network is used.
"""

from __future__ import annotations

import importlib.util
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

pytest.importorskip('langchain_anthropic')

from ai.common.config import Config  # noqa: E402
from ai.common.schema import Question  # noqa: E402

_MOD_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'nodes', 'llm_anthropic', 'anthropic.py'
)


class _Recorder(BaseHTTPRequestHandler):
    bodies: list = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length') or 0)))
        _Recorder.bodies.append(body)
        reply = {
            'id': 'msg_1',
            'type': 'message',
            'role': 'assistant',
            'model': body.get('model'),
            'content': [{'type': 'text', 'text': '```json\n{"done": true, "answer": "ok"}\n```'}],
            'stop_reason': 'end_turn',
            'stop_sequence': None,
            'usage': {'input_tokens': 10, 'output_tokens': 5},
        }
        data = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def server(monkeypatch):
    _Recorder.bodies = []
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), _Recorder)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv('ANTHROPIC_BASE_URL', f'http://127.0.0.1:{httpd.server_address[1]}')
    yield _Recorder.bodies
    httpd.shutdown()


def _chat(monkeypatch):
    config = {
        'model': 'claude-sonnet-4-6',
        'apikey': 'sk-ant-test',
        'modelTotalTokens': 200000,
        'modelOutputTokens': 8192,
    }
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    spec = importlib.util.spec_from_file_location('_llm_anthropic_cache_test', _MOD_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Chat('anthropic', {}, {})


def _agent_question(scratch: str, cache: bool = True) -> Question:
    q = Question(role='You are a planning agent.', expectJson=True)
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

    content = server[0]['messages'][0]['content']
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

    first, second = (b['messages'][0]['content'] for b in server)
    assert first[0]['text'] == second[0]['text']
    assert first[1]['text'] != second[1]['text']


def test_without_the_flag_the_request_is_unchanged(monkeypatch, server):
    """Questions that do not ask for caching send one plain string, as before."""
    chat = _chat(monkeypatch)
    question = _agent_question('round 1', cache=False)

    chat.chat(question)

    assert server[0]['messages'][0]['content'] == question.getPrompt()
    assert 'cache_control' not in json.dumps(server[0])
