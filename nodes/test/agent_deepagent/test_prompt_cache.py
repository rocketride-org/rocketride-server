# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The deep agent's fixed prompt reaches the provider as a cacheable start.

Every model call repeats the tool protocol, the tool list and the system prompt.
These tests run the real driver, the real Question and the real llm_anthropic and
llm_bedrock nodes against local HTTP servers that record each request, so they check
what goes on the wire. No key or network is used, and no provider cache is involved.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import json
import os
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from ai.common.chat import ChatBase
from ai.common.config import Config
from ai.common.llm_native_stream import PROMPT_CACHE_PREFIX_VAR

from .._real_langchain import real_langchain_or_skip

_NODES = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'nodes')
_SYSTEM = 'You are a deep agent. Plan your work.'
_TOOL = types.SimpleNamespace(name='calc', description='Evaluate arithmetic.', args_schema=None)
_BROKEN_CALL = '{"type":"tool_call","name":"calc","args":{"e":"a "b"}}'
_TASK_HEADING = '### Current Task:'


def _load(name, *path):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_NODES, *path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _messages():
    """The real LangChain message classes. Other test modules stub them, so look them up late."""
    return importlib.import_module('langchain_core.messages')


@pytest.fixture(scope='module')
def real_langchain():
    restore = real_langchain_or_skip()
    yield
    restore()


@pytest.fixture(scope='module')
def driver(real_langchain):
    return _load('_deepagent_cache_test', 'agent_deepagent', 'deepagent.py')


class _Recorder(BaseHTTPRequestHandler):
    """Plays the Anthropic Messages API and keeps every request body."""

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
            'content': [{'type': 'text', 'text': 'FINAL>>>done'}],
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


def _serve(handler):
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f'http://127.0.0.1:{httpd.server_address[1]}'


@pytest.fixture
def anthropic_chat(monkeypatch, real_langchain):
    _Recorder.bodies = []
    httpd, url = _serve(_Recorder)
    monkeypatch.setenv('ANTHROPIC_BASE_URL', url)
    config = {
        'model': 'claude-sonnet-4-6',
        'apikey': 'sk-ant-test',
        'modelTotalTokens': 200000,
        'modelOutputTokens': 8192,
    }
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    yield _load('_anthropic_for_deepagent', 'llm_anthropic', 'anthropic.py').Chat('anthropic', {}, {}), _Recorder.bodies
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture
def bedrock_chat(monkeypatch, real_langchain):
    # Imported first so a missing package fails here. The module below would skip instead.
    importlib.import_module('langchain_aws')
    from ..llm_bedrock import test_prompt_cache as wire

    wire._Bedrock.requests = []
    httpd, url = _serve(wire._Bedrock)
    monkeypatch.setenv('AWS_ENDPOINT_URL_BEDROCK_RUNTIME', url)
    yield wire._chat(monkeypatch), wire._Bedrock.requests
    httpd.shutdown()
    httpd.server_close()


def _model(driver, ask, tools=(_TOOL,)):
    model = driver._build_deepagent_llm(types.SimpleNamespace(call_llm=ask), None)
    model.bind_tools(list(tools))
    return model


def _recording(replies):
    """A call_llm that answers from *replies* (the last repeats) and keeps what it was sent."""
    seen = []

    def ask(context, prompt, **kwargs):
        seen.append((prompt, kwargs))
        return replies[min(len(seen) - 1, len(replies) - 1)]

    return ask, seen


def _sending_to(chat):
    """A call_llm that sends each question through *chat* and keeps it."""
    questions = []

    def ask(context, question, **kwargs):
        questions.append(question)
        chat.chat(question)
        return 'FINAL>>>done'

    return ask, questions


def _conversation(task):
    lc = _messages()
    return [lc.SystemMessage(content=_SYSTEM), lc.HumanMessage(content=task)]


def test_the_anthropic_request_marks_the_fixed_prompt_only(driver, anthropic_chat):
    chat, bodies = anthropic_chat
    ask, questions = _sending_to(chat)

    _model(driver, ask)._generate(_conversation('What is 6 x 7?'))

    fixed, rest = bodies[0]['messages'][0]['content']
    assert fixed['cache_control'] == {'type': 'ephemeral'}
    assert 'cache_control' not in rest
    assert 'To CALL A TOOL' in fixed['text'] and '"calc"' in fixed['text'] and _SYSTEM in fixed['text']
    assert 'What is 6 x 7?' not in fixed['text'] and 'What is 6 x 7?' in rest['text']
    assert _TASK_HEADING not in fixed['text'] and _TASK_HEADING in rest['text']
    assert fixed['text'] + rest['text'] == questions[0].getPrompt()


def test_the_bedrock_request_marks_the_fixed_prompt_only(driver, bedrock_chat):
    chat, requests = bedrock_chat
    ask, questions = _sending_to(chat)

    _model(driver, ask)._generate(_conversation('What is 6 x 7?'))

    fixed, rest = requests[0]['body']['messages'][0]['content']
    assert fixed['cache_control'] == {'type': 'ephemeral'}
    assert 'cache_control' not in rest
    assert 'To CALL A TOOL' in fixed['text'] and '"calc"' in fixed['text'] and _SYSTEM in fixed['text']
    assert 'What is 6 x 7?' not in fixed['text'] and 'What is 6 x 7?' in rest['text']
    assert fixed['text'] + rest['text'] == questions[0].getPrompt()


def test_the_fixed_prompt_is_identical_across_calls_and_runs(driver, anthropic_chat):
    chat, bodies = anthropic_chat
    ask, _ = _sending_to(chat)
    lc = _messages()

    model = _model(driver, ask)
    first_turn = _conversation('First task')
    model._generate(first_turn)
    model._generate(
        first_turn
        + [
            lc.AIMessage(
                content='', tool_calls=[{'id': 'c1', 'name': 'calc', 'args': {'e': '1'}, 'type': 'tool_call'}]
            ),
            lc.ToolMessage(content='42', tool_call_id='c1', name='calc'),
        ]
    )
    _model(driver, ask)._generate(_conversation('A different task'))

    assert len(bodies) == 3
    fixed = [body['messages'][0]['content'][0]['text'] for body in bodies]
    rest = [body['messages'][0]['content'][1]['text'] for body in bodies]
    assert fixed[0] == fixed[1] == fixed[2]
    assert len(set(rest)) == 3


def test_the_real_deepagents_library_repeats_one_fixed_prompt(driver):
    """Only the real library shows whether its system prompt changes between calls."""
    import deepagents
    from langchain_core.tools import tool

    @tool
    def calc(expression: str) -> str:
        """Evaluate arithmetic."""
        return '42'

    def run(task):
        replies = ['{"type":"tool_call","name":"calc","args":{"expression":"1+1"}}', 'FINAL>>>done']
        ask, seen = _recording(replies)
        agent = deepagents.create_deep_agent(
            model=driver._build_deepagent_llm(types.SimpleNamespace(call_llm=ask), None),
            tools=[calc],
            system_prompt=_SYSTEM,
        )
        asyncio.run(agent.ainvoke({'messages': [_messages().HumanMessage(content=task)]}))
        return [question for question, _ in seen]

    first, second = run('First task'), run('A different task')

    assert len(first) == len(second) == 2
    assert len({question.role for question in first + second}) == 1
    role = first[0].role
    assert _SYSTEM in role and '"calc"' in role and 'To CALL A TOOL' in role
    assert 'First task' not in role and 'A different task' not in role
    assert all('First task' in question.questions[0].text for question in first)
    assert all('A different task' in question.questions[0].text for question in second)


def test_a_retry_keeps_the_fixed_prompt_and_adds_the_hint_to_the_conversation(driver):
    ask, seen = _recording([_BROKEN_CALL, 'FINAL>>>ok'])

    result = _model(driver, ask)._generate(_conversation('Task'))

    first, second = seen[0][0], seen[1][0]
    hint = driver._parse_failure_hint(_BROKEN_CALL)
    assert result.generations[0].message.content == 'ok'
    assert first.role == second.role
    assert hint not in second.role
    assert hint not in first.questions[0].text
    assert second.questions[0].text == f'{first.questions[0].text}\n\nsystem: {hint}'


def test_a_tool_call_that_never_parses_still_fails_the_run(driver):
    ask, seen = _recording([_BROKEN_CALL])

    with pytest.raises(ValueError, match='No valid tool call or final answer'):
        _model(driver, ask)._generate(_conversation('Task'))
    assert len(seen) == 3


def test_a_later_system_message_stays_in_the_conversation(driver):
    ask, seen = _recording(['FINAL>>>ok'])
    lc = _messages()
    messages = [
        *_conversation('Task'),
        lc.SystemMessage(content='Summary of earlier work'),
        lc.HumanMessage(content='Next step'),
    ]

    _model(driver, ask)._generate(messages)

    question = seen[0][0]
    assert 'Summary of earlier work' not in question.role
    assert _SYSTEM in question.role
    assert question.questions[0].text.split('\n') == [
        'user: Task',
        'system: Summary of earlier work',
        'user: Next step',
    ]


def test_without_a_system_message_the_protocol_is_still_fixed(driver):
    ask, seen = _recording(['FINAL>>>ok'])

    _model(driver, ask)._generate([_messages().HumanMessage(content='Task')])

    question = seen[0][0]
    assert 'To CALL A TOOL' in question.role
    assert question.cachePrefix is True
    assert question.questions[0].text == 'user: Task'


def test_stop_words_still_reach_the_model_call(driver):
    ask, seen = _recording(['FINAL>>>ok'])

    _model(driver, ask)._generate(_conversation('Task'), stop=['Observation:'])

    assert seen[0][1]['stop_words'] == ['Observation:']


def test_a_provider_without_caching_gets_one_plain_prompt(driver):
    class _Plain(ChatBase):
        def __init__(self):
            self.seen = []
            self._modelOutputTokens = 4096

        def chat_string(self, prompt, **_kwargs):
            self.seen.append((prompt, PROMPT_CACHE_PREFIX_VAR.get()))
            return 'FINAL>>>ok'

    plain = _Plain()
    ask, questions = _sending_to(plain)

    _model(driver, ask)._generate(_conversation('Task'))

    prompt, prefix = plain.seen[0]
    assert prefix is None
    assert prompt == questions[0].getPrompt()
    assert prompt.index('To CALL A TOOL') < prompt.index(_SYSTEM) < prompt.index('user: Task')
