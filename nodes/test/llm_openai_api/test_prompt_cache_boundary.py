# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The OpenAI-compatible node can pass the cacheable prefix on as its own content part.

These tests run the real driver, the real node config and the real langchain-openai
client against a local HTTP server that records each request body. They prove what
goes on the wire. They cannot prove that any gateway or provider then caches anything.
"""

from __future__ import annotations

import importlib.util
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import json5
import pytest
from depends import depends

from ai.common.schema import Question

_NODE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'nodes', 'llm_openai_api')
_PLANTED_SECRET = 'sk-planted-provider-secret'


class _Recorder(BaseHTTPRequestHandler):
    bodies: list = []
    reject_parts = False

    def log_message(self, *args):
        pass

    def _send(self, status, data, content_type='application/json'):
        self.send_response(status)
        self.send_header('content-type', content_type)
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length') or 0)))
        _Recorder.bodies.append(body)
        if _Recorder.reject_parts and isinstance(body['messages'][-1]['content'], list):
            error = {'error': {'message': f'content must be a string ({_PLANTED_SECRET})'}}
            self._send(400, json.dumps(error).encode())
            return
        if body.get('stream'):
            base = {'id': 'c1', 'object': 'chat.completion.chunk', 'created': 1, 'model': body['model']}
            chunks = [
                {
                    **base,
                    'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'ok'}, 'finish_reason': None}],
                },
                {**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]},
            ]
            data = b''.join(b'data: ' + json.dumps(c).encode() + b'\n\n' for c in chunks) + b'data: [DONE]\n\n'
            self._send(200, data, 'text/event-stream')
            return
        reply = {
            'id': 'c1',
            'object': 'chat.completion',
            'created': 1,
            'model': body['model'],
            'choices': [
                {'index': 0, 'message': {'role': 'assistant', 'content': '{"done": true}'}, 'finish_reason': 'stop'}
            ],
            'usage': {'prompt_tokens': 10, 'completion_tokens': 2, 'total_tokens': 12},
        }
        self._send(200, json.dumps(reply).encode())


@pytest.fixture(scope='module', autouse=True)
def _node_packages():
    # The way the node gets them at runtime, so these tests run rather than skip.
    depends(os.path.join(_NODE_DIR, 'requirements.txt'))


@pytest.fixture
def endpoint():
    _Recorder.bodies = []
    _Recorder.reject_parts = False
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), _Recorder)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{httpd.server_address[1]}/v1'
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=5)


def _driver(conn_config):
    spec = importlib.util.spec_from_file_location(
        '_llm_openai_api_cache_test', os.path.join(_NODE_DIR, 'openai_client.py')
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    chat = module.Chat('llm_openai_api', conn_config, {})
    chat.getTokens = lambda value: (len(value) + 3) // 4  # no tokenizer download
    return chat


def _settings(endpoint, **options):
    return {
        'model': 'gateway-model',
        'apikey': 'test-key',
        'base_url': endpoint,
        'modelTotalTokens': 100000,
        **options,
    }


def _chat(endpoint, **options):
    return _driver(_settings(endpoint, **options))


def _question(scratch='round 1', cache=True, json_reply=True):
    q = Question(role='You are a planning agent.', expectJson=json_reply)
    q.cachePrefix = cache
    q.addInstruction('Available Tools', 'tool list ' * 50)
    q.addContext(f'Scratch: {scratch}')
    q.addQuestion('Plan the next step.')
    return q


def _turn():
    """A turn whose history holds reasoning written by the plain ChatOpenAI class.

    langchain-openai sends this block type on to the endpoint, so a request shows whether
    the driver still treats the turn as running on that class.
    """
    reasoning = {'type': 'redacted_thinking', 'data': 'opaque-state'}
    question = Question(role='You are helpful.', cachePrefix=True)
    question.addMessage({'role': 'user', 'content': 'Hello'})
    question.addMessage(
        {
            'role': 'assistant',
            'content': [
                {'type': 'reasoning', 'text': '', 'state': {'origin': 'ChatOpenAI', 'block': reasoning}},
                {'type': 'text', 'text': 'Hi'},
            ],
        }
    )
    question.addMessage({'role': 'user', 'content': 'Go on'})
    return question


def _content(body):
    return body['messages'][-1]['content']


def test_with_the_option_the_prefix_is_its_own_unmarked_part(endpoint):
    question = _question()

    _chat(endpoint, cachePrefixParts=True).chat(question)

    parts = _content(_Recorder.bodies[0])
    assert [p['type'] for p in parts] == ['text', 'text']
    assert parts[0]['text'] + parts[1]['text'] == question.getPrompt()
    assert 'Scratch' not in parts[0]['text'] and 'Scratch' in parts[1]['text']
    assert 'cache_control' not in json.dumps(_Recorder.bodies[0])


def test_the_prefix_part_is_identical_across_rounds(endpoint):
    chat = _chat(endpoint, cachePrefixParts=True)

    chat.chat(_question('round 1'))
    chat.chat(_question('round 2 with more notes'))

    first, second = (_content(b) for b in _Recorder.bodies)
    assert first[0] == second[0]
    assert first[1] != second[1]


def test_a_streamed_request_is_split_too(endpoint):
    question = _question(json_reply=False)

    _chat(endpoint, cachePrefixParts=True).chat(question, on_chunk=lambda text: None)

    assert _Recorder.bodies[0]['stream'] is True
    parts = _content(_Recorder.bodies[0])
    assert parts[0]['text'] + parts[1]['text'] == question.getPrompt()
    assert 'cache_control' not in json.dumps(_Recorder.bodies[0])


def test_by_default_the_request_is_one_string(endpoint):
    question = _question()
    chat = _chat(endpoint)

    chat.chat(question)

    assert type(chat._llm).__name__ == 'ChatOpenAI'
    assert _content(_Recorder.bodies[0]) == question.getPrompt()


def test_the_option_set_to_false_changes_nothing(endpoint):
    question = _question()

    _chat(endpoint).chat(question)
    _chat(endpoint, cachePrefixParts=False).chat(question)

    assert _Recorder.bodies[0] == _Recorder.bodies[1]


def test_a_question_that_does_not_ask_for_caching_stays_one_string(endpoint):
    question = _question(cache=False)

    _chat(endpoint, cachePrefixParts=True).chat(question)

    assert _content(_Recorder.bodies[0]) == question.getPrompt()


@pytest.mark.parametrize('streamed', [False, True], ids=['invoked', 'streamed'])
def test_an_endpoint_that_rejects_parts_fails_the_call_visibly(endpoint, streamed):
    _Recorder.reject_parts = True
    on_chunk = (lambda text: None) if streamed else None

    with pytest.raises(ValueError, match='error occurred with the API') as failure:
        _chat(endpoint, cachePrefixParts=True).chat(_question(json_reply=False), on_chunk=on_chunk)

    assert _PLANTED_SECRET not in str(failure.value)
    assert _Recorder.bodies
    assert all(isinstance(_content(b), list) for b in _Recorder.bodies)


def test_a_turn_is_not_marked_for_caching(endpoint):
    _chat(endpoint).chat(_turn())
    _chat(endpoint, cachePrefixParts=True).chat(_turn())

    off, on = _Recorder.bodies
    assert 'cache_control' not in json.dumps(on)
    assert 'opaque-state' in json.dumps(on)  # the reasoning still goes back to the class that wrote it
    assert off == on


def test_the_option_reaches_the_driver_through_the_node_config(endpoint):
    question = _question()
    conn_config = {'profile': 'custom', 'custom': _settings(endpoint, cachePrefixParts=True), 'parameters': {}}

    _driver(conn_config).chat(question)

    parts = _content(_Recorder.bodies[0])
    assert parts[0]['text'] + parts[1]['text'] == question.getPrompt()


def test_the_option_is_offered_on_the_custom_profile_and_defaults_off():
    with open(os.path.join(_NODE_DIR, 'services.json'), encoding='utf-8') as f:
        services = json5.load(f)

    assert services['fields']['cachePrefixParts']['type'] == 'boolean'
    assert services['fields']['cachePrefixParts']['default'] is False
    assert 'cachePrefixParts' in services['fields']['openai_api.custom']['properties']
