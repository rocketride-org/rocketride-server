# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Every request the two OpenAI nodes send fits the request fields a hosted backend accepts.

A hosted backend forwards only the fields, items and content types these nodes send,
and refuses the rest by name. The nodes run for real here (the openai SDK and
langchain-openai build every body) on every path: string prompts streamed and not, a
reasoning prompt and its fallback, native tool turns with the tool result sent back,
reasoning tool turns that replay encrypted reasoning, and the compatible reasoning
stream, each with and without stop sequences. A new langchain-openai that adds a field
fails here first.

ALLOWED is a literal copy of that list, kept here on purpose.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest

pytest.importorskip('langchain_openai')
pytest.importorskip('openai')
import httpx  # noqa: E402

from ai.common.config import Config  # noqa: E402
from ai.common.llm_native_stream import STOP_SEQUENCES_VAR  # noqa: E402
from ai.common.model_gateway import GATEWAY_ENV  # noqa: E402
from ai.common.schema import Question, UserMessage  # noqa: E402

NODES = Path(__file__).resolve().parents[5] / 'nodes' / 'src' / 'nodes'
BASE_URL = 'http://127.0.0.1:41873/gateway/openai/v1'
TOKEN = 'rrmg_' + 'c' * 43

# Request fields a hosted backend accepts.
ALLOWED = {
    'chat': {
        'model',
        'messages',
        'stream',
        'stream_options',
        'temperature',
        'max_tokens',
        'max_completion_tokens',
        'stop',
        'tools',
        'tool_choice',
        'parallel_tool_calls',
        'reasoning_effort',
    },
    'responses': {
        'model',
        'input',
        'stream',
        'store',
        'reasoning',
        'include',
        'max_output_tokens',
        'tools',
        'tool_choice',
        'parallel_tool_calls',
    },
}
CHAT_ROLES = {'system', 'developer', 'user', 'assistant', 'tool'}
RESPONSES_ROLES = {'system', 'developer', 'user', 'assistant'}
RESPONSES_PARTS = {'input_text', 'output_text', 'refusal'}
RESPONSES_ITEMS = {'message', 'function_call', 'function_call_output', 'reasoning'}


def violations(endpoint: str, body: dict) -> list[str]:
    """Every field, item or content type in ``body`` that is not on the list."""
    found = [f'field {k}' for k in body if k not in ALLOWED[endpoint]]
    if 'file_id' in json.dumps(body):
        found.append('file_id')
    for tool in body.get('tools') or []:
        if tool.get('type') != 'function':
            found.append(f'tool type {tool.get("type")}')
    if endpoint == 'chat':
        if 'max_tokens' in body and 'max_completion_tokens' in body:
            found.append('both max_tokens and max_completion_tokens')
        options = body.get('stream_options')
        if options is not None and set(options) - {'include_usage'}:
            found.append(f'stream_options {sorted(options)}')
        for message in body.get('messages') or []:
            role = message.get('role')
            if role not in CHAT_ROLES:
                found.append(f'role {role}')
            content = message.get('content')
            if isinstance(content, list):
                kinds = {'text', 'refusal'} if role == 'assistant' else {'text'}
                found += [f'part {p.get("type")}' for p in content if p.get('type') not in kinds]
            elif content is not None and not isinstance(content, str):
                found.append(f'content {type(content).__name__}')
            for call in message.get('tool_calls') or []:
                if role != 'assistant' or call.get('type') != 'function':
                    found.append(f'tool_call {call.get("type")} on {role}')
            if role == 'tool' and not message.get('tool_call_id'):
                found.append('tool message without tool_call_id')
    else:
        reasoning = body.get('reasoning')
        if reasoning is not None and set(reasoning) - {'effort', 'summary'}:
            found.append(f'reasoning {sorted(reasoning)}')
        for value in body.get('include') or []:
            if value != 'reasoning.encrypted_content':
                found.append(f'include {value}')
        items = body.get('input')
        for item in [] if isinstance(items, str) else items or []:
            kind = item.get('type')
            if kind is None or (kind == 'message' and 'role' in item):
                if item.get('role') not in RESPONSES_ROLES:
                    found.append(f'role {item.get("role")}')
                content = item.get('content')
                if isinstance(content, list):
                    found += [f'part {p.get("type")}' for p in content if p.get('type') not in RESPONSES_PARTS]
                elif not isinstance(content, str):
                    found.append(f'content {type(content).__name__}')
            elif kind not in RESPONSES_ITEMS:
                found.append(f'item {kind}')
            elif kind == 'reasoning' and not item.get('encrypted_content'):
                found.append('reasoning item without encrypted_content')
    return found


# ---------------------------------------------------------------------------
# A backend that answers both APIs, as JSON and as a stream
# ---------------------------------------------------------------------------

CALL = {'name': 'tool_github_1__create_issue', 'arguments': '{"title": "Flaky"}'}
USAGE_CHAT = {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}
USAGE_RESPONSES = {
    'input_tokens': 10,
    'output_tokens': 5,
    'total_tokens': 15,
    'input_tokens_details': {'cached_tokens': 0},
    'output_tokens_details': {'reasoning_tokens': 2},
}


def _wants_call(endpoint: str, body: dict) -> bool:
    """Call the tool once, then answer in text once its result is back."""
    if not body.get('tools'):
        return False
    if endpoint == 'chat':
        return not any(m.get('role') == 'tool' for m in body.get('messages') or [])
    return not any(i.get('type') == 'function_call_output' for i in body.get('input') or [] if isinstance(i, dict))


def _chat_reply(body: dict) -> httpx.Response:
    call = _wants_call('chat', body)
    if body.get('stream'):

        def chunk(delta, finish=None):
            return {
                'id': 'chatcmpl-1',
                'object': 'chat.completion.chunk',
                'created': 1,
                'model': body['model'],
                'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}],
            }

        if call:
            tool = {'index': 0, 'id': 'call_1', 'type': 'function', 'function': CALL}
            chunks = [chunk({'role': 'assistant', 'tool_calls': [tool]}), chunk({}, 'tool_calls')]
        else:
            chunks = [chunk({'role': 'assistant', 'content': '4'}), chunk({}, 'stop')]
        chunks.append({**chunk({}), 'choices': [], 'usage': USAGE_CHAT})
        content = ''.join(f'data: {json.dumps(c)}\n\n' for c in chunks) + 'data: [DONE]\n\n'
        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=content.encode())
    message = {'role': 'assistant', 'content': None if call else '4'}
    if call:
        message['tool_calls'] = [{'id': 'call_1', 'type': 'function', 'function': CALL}]
    choice = {'index': 0, 'message': message, 'finish_reason': 'tool_calls' if call else 'stop'}
    return httpx.Response(
        200,
        json={
            'id': 'chatcmpl-1',
            'object': 'chat.completion',
            'created': 1,
            'model': body['model'],
            'choices': [choice],
            'usage': USAGE_CHAT,
        },
    )


def _responses_reply(body: dict) -> httpx.Response:
    reasoning = {
        'id': 'rs_1',
        'type': 'reasoning',
        'summary': [{'type': 'summary_text', 'text': 'Thinking.'}],
        'encrypted_content': 'gAAAAenc==',
    }
    if _wants_call('responses', body):
        last = {**CALL, 'id': 'fc_1', 'type': 'function_call', 'call_id': 'call_1', 'status': 'completed'}
    else:
        last = {
            'id': 'msg_1',
            'type': 'message',
            'role': 'assistant',
            'status': 'completed',
            'content': [{'type': 'output_text', 'text': '4', 'annotations': []}],
        }
    base = {
        'id': 'resp_1',
        'object': 'response',
        'created_at': 1,
        'model': body['model'],
        'tools': [],
        'parallel_tool_calls': True,
        'tool_choice': 'auto',
    }
    done = {**base, 'status': 'completed', 'output': [reasoning, last], 'usage': USAGE_RESPONSES}
    if not body.get('stream'):
        return httpx.Response(200, json=done)
    events = [
        {'type': 'response.created', 'response': {**base, 'status': 'in_progress', 'output': []}},
        {'type': 'response.output_item.added', 'output_index': 0, 'item': {**reasoning, 'summary': []}},
        {
            'type': 'response.reasoning_summary_text.delta',
            'item_id': 'rs_1',
            'output_index': 0,
            'summary_index': 0,
            'delta': 'Thinking.',
        },
        {'type': 'response.output_item.done', 'output_index': 0, 'item': reasoning},
    ]
    if last['type'] == 'message':
        events += [
            {'type': 'response.output_item.added', 'output_index': 1, 'item': {**last, 'content': []}},
            {
                'type': 'response.output_text.delta',
                'item_id': 'msg_1',
                'output_index': 1,
                'content_index': 0,
                'delta': '4',
            },
        ]
    else:
        events.append({'type': 'response.output_item.added', 'output_index': 1, 'item': {**last, 'arguments': ''}})
    events += [
        {'type': 'response.output_item.done', 'output_index': 1, 'item': last},
        {'type': 'response.completed', 'response': done},
    ]
    content = ''.join(f'data: {json.dumps({**e, "sequence_number": n})}\n\n' for n, e in enumerate(events))
    return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=content.encode())


class Recorder:
    def __init__(self):
        self.sent: list[tuple[str, str, dict]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        endpoint = 'responses' if request.url.path.endswith('/responses') else 'chat'
        self.sent.append((endpoint, request.headers.get('authorization'), body))
        return _responses_reply(body) if endpoint == 'responses' else _chat_reply(body)


@pytest.fixture
def recorder(monkeypatch):
    recording = Recorder()
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', lambda self, request: recording(request))
    monkeypatch.setattr(sys, 'argv', [*sys.argv, '--hosted'])
    gateway = {'provider': 'openai', 'base_url': BASE_URL, 'token': TOKEN, 'expires_at': time.time() + 3600}
    monkeypatch.setenv(GATEWAY_ENV, json.dumps(gateway))
    return recording


def _driver(monkeypatch, node: str, config: dict):
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    spec = importlib.util.spec_from_file_location(f'_shapes_{node}', NODES / node / 'openai_client.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    chat = mod.Chat(node, {}, {})
    chat.getTokens = lambda value: len(value) // 4
    return chat


PLAIN = {'model': 'gpt-4o-mini', 'apikey': '', 'modelTotalTokens': 128000, 'modelOutputTokens': 4096}
REASONING = {
    'model': 'gpt-5-nano',
    'apikey': '',
    'modelTotalTokens': 400000,
    'modelOutputTokens': 8192,
    'capabilities': {'reasoning': True},
}
NODE_CONFIGS = {
    'llm_openai-plain': ('llm_openai', PLAIN),
    'llm_openai-reasoning': ('llm_openai', REASONING),
    'llm_openai_api-plain': ('llm_openai_api', {**PLAIN, 'base_url': ''}),
    'llm_openai_api-reasoning': ('llm_openai_api', {**REASONING, 'base_url': ''}),
}


def _prompt() -> Question:
    q = Question(role='You are helpful.')
    q.addQuestion('What is 2+2?')
    return q


def _turns(chat, streamed: bool):
    """A tool call, then the tool's result back to the model."""
    q = Question(
        role='You are the Rocket agent.',
        tools=[{'name': 'tool_github_1.create_issue', 'description': 'File an issue.'}],
        messages=[UserMessage(content='File an issue about the flaky test.')],
    )
    on_chunk = (lambda _t: None) if streamed else None
    first = chat.chat(q, on_chunk=on_chunk)
    assert [c.id for c in first.toolCalls()] == ['call_1']
    q.addMessage(first.message)
    q.addToolResult('call_1', '#42')
    chat.chat(q, on_chunk=on_chunk)


def _run(chat, kind: str, streamed: bool, stop: bool):
    token = STOP_SEQUENCES_VAR.set(['\nObservation:']) if stop else None
    try:
        if kind == 'prompt':
            chat.chat(_prompt(), on_chunk=(lambda _t: None) if streamed else None)
        else:
            _turns(chat, streamed)
    finally:
        if token is not None:
            STOP_SEQUENCES_VAR.reset(token)


@pytest.mark.parametrize('stop', [False, True], ids=['no-stop', 'stop'])
@pytest.mark.parametrize('streamed', [True, False], ids=['streamed', 'invoked'])
@pytest.mark.parametrize('kind', ['prompt', 'turns'])
@pytest.mark.parametrize('name', sorted(NODE_CONFIGS))
def test_every_request_fits_the_list(monkeypatch, recorder, name, kind, streamed, stop):
    node, config = NODE_CONFIGS[name]
    chat = _driver(monkeypatch, node, config)

    _run(chat, kind, streamed, stop)

    assert recorder.sent
    for endpoint, authorization, body in recorder.sent:
        assert authorization == f'Bearer {TOKEN}'
        assert violations(endpoint, body) == [], (endpoint, body)
        if endpoint == 'responses':
            assert body.get('store') is False


def test_the_reasoning_prompt_fallback_fits_the_list(monkeypatch, recorder):
    """The Responses stream ends without text; the Chat Completions fallback is recorded too."""
    original = Recorder.__call__

    def empty_first(self, request):
        if request.url.path.endswith('/responses') and not self.sent:
            self.sent.append(('responses', request.headers.get('authorization'), json.loads(request.content)))
            events = [{'type': 'response.created', 'sequence_number': 0, 'response': {'id': 'r', 'status': 'x'}}]
            content = ''.join(f'data: {json.dumps(e)}\n\n' for e in events).encode()
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=content)
        return original(self, request)

    monkeypatch.setattr(Recorder, '__call__', empty_first)
    chat = _driver(monkeypatch, 'llm_openai', REASONING)

    _run(chat, 'prompt', True, True)

    assert [endpoint for endpoint, _a, _b in recorder.sent] == ['responses', 'chat']
    for endpoint, _authorization, body in recorder.sent:
        assert violations(endpoint, body) == [], (endpoint, body)


def test_the_paths_reach_both_apis_and_replay_reasoning(monkeypatch, recorder):
    """The cases above cover what they claim: both endpoints, streamed and not, and a replayed reasoning item."""
    chat = _driver(monkeypatch, 'llm_openai', REASONING)
    _run(chat, 'turns', True, True)
    chat = _driver(monkeypatch, 'llm_openai', REASONING)
    _run(chat, 'prompt', True, False)

    endpoints = {endpoint for endpoint, _a, _b in recorder.sent}
    assert endpoints == {'responses'}
    replayed = recorder.sent[1][2]['input']
    kinds = [item.get('type') for item in replayed if isinstance(item, dict)]
    assert 'reasoning' in kinds and 'function_call' in kinds and 'function_call_output' in kinds
    assert recorder.sent[1][2]['include'] == ['reasoning.encrypted_content']


@pytest.mark.parametrize(
    'endpoint,body,expected',
    [
        ('responses', {'model': 'm', 'input': 'x', 'previous_response_id': 'resp_9'}, ['field previous_response_id']),
        ('responses', {'model': 'm', 'input': [{'type': 'item_reference', 'id': 'msg_9'}]}, ['item item_reference']),
        (
            'responses',
            {'model': 'm', 'input': [{'role': 'user', 'content': [{'type': 'input_image', 'image_url': 'u'}]}]},
            ['part input_image'],
        ),
        ('responses', {'model': 'm', 'input': 'x', 'tools': [{'type': 'file_search'}]}, ['tool type file_search']),
        (
            'responses',
            {'model': 'm', 'input': [{'type': 'reasoning', 'id': 'rs_1'}]},
            ['reasoning item without encrypted_content'],
        ),
        ('chat', {'model': 'm', 'messages': [], 'store': True}, ['field store']),
        (
            'chat',
            {'model': 'm', 'messages': [], 'max_tokens': 1, 'max_completion_tokens': 1},
            ['both max_tokens and max_completion_tokens'],
        ),
        (
            'chat',
            {'model': 'm', 'messages': [{'role': 'user', 'content': [{'type': 'file', 'file': {'file_id': 'f'}}]}]},
            ['file_id', 'part file'],
        ),
    ],
)
def test_the_check_itself_refuses_what_the_list_refuses(endpoint, body, expected):
    assert violations(endpoint, body) == expected
