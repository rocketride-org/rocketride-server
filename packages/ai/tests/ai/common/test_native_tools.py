# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Native tool calling: the name map, the stop table, the LangChain codec, and the turn path.

The codec is checked by what the provider would receive: each turn is encoded, then
LangChain's own request builder turns it into the wire payload, which is what the
assertions read. The turn path runs the real drivers over mocked HTTP transports.
"""

from __future__ import annotations

import ast
import functools
import importlib.util
import json
import re
from pathlib import Path

import pytest

from ai.common.config import Config
from ai.common.llm_base import LLMBase

from ai.common.llm_tools import (
    ToolNames,
    from_langchain,
    model_origin,
    provider_tool_name,
    stop_reason,
    to_langchain,
    tool_specs,
)
from ai.common.schema import AssistantMessage, Question, ReasoningBlock, TextBlock, ToolCallBlock, UserMessage

langchain_anthropic = pytest.importorskip('langchain_anthropic')
from langchain_core.messages import AIMessage  # noqa: E402

PROVIDER_NAME = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
SIG = 'EqQBCkYIBxgCKkBsig=='


def _anthropic():
    return langchain_anthropic.ChatAnthropic(model='claude-sonnet-4-5', api_key='sk-ant-test', max_tokens=1024)


def _payload(llm, question: Question, cache: bool = False):
    """The request body LangChain would send for this turn."""
    origin = model_origin(llm)
    messages = to_langchain(question.getSystemPrompt(), question.getTurnMessages(), origin, cache)
    bound = llm.bind_tools(tool_specs(question.tools))
    return bound.bound._get_request_payload(messages, **bound.kwargs)


def _loop_question(llm) -> Question:
    """A wave after one call: the assistant thought, called two tools (one with bad args), and got results."""
    q = Question(
        role='You are the Rocket agent.',
        tools=[{'name': 'tool_github_1.create_issue'}, {'name': 'memory.peek'}],
        messages=[UserMessage(content='File an issue.')],
    )
    q.addMessage(
        AssistantMessage(
            content=[
                ReasoningBlock(
                    text='I should file it.',
                    state={
                        'origin': model_origin(llm),
                        'block': {'type': 'thinking', 'thinking': 'I should file it.', 'signature': SIG},
                    },
                ),
                TextBlock(text='Filing it.'),
                ToolCallBlock(id='call_1', name='tool_github_1.create_issue', args={'title': 'Flaky'}),
                ToolCallBlock(id='call_2', name='memory.peek', args='{"key": '),
            ]
        )
    )
    q.addToolResult('call_1', '#42')
    q.addToolResult('call_2', 'bad arguments', isError=True)
    return q


def test_provider_names_are_legal_distinct_and_map_back():
    names = [
        'navigate',
        'memory.peek',
        'tool_github_1.create_issue',
        'a__b',
        'a_.b',
        'a._b',
        'x y',
        'é',
        'm.' + 'n' * 70,
    ]
    tools = [{'name': n} for n in names]
    q = Question(tools=tools, messages=[UserMessage(content='hi')])
    table = ToolNames.build(q.tools, q.messages)

    provider = [provider_tool_name(n) for n in names]
    assert all(PROVIDER_NAME.match(p) for p in provider)
    assert len(set(provider)) == len(names)
    assert [table.caller(p) for p in provider] == names
    assert provider[:3] == ['navigate', 'memory__peek', 'tool_github_1__create_issue']
    assert table.caller('memory.peek') == 'memory.peek'


@pytest.mark.parametrize(
    'raw, has_calls, expected',
    [
        ('end_turn', False, 'end_turn'),
        ('tool_use', True, 'tool_use'),
        ('tool_calls', True, 'tool_use'),
        ('stop', True, 'tool_use'),
        ('stop', False, 'end_turn'),
        ('length', False, 'max_tokens'),
        ('max_output_tokens', False, 'max_tokens'),
        ('content_filter', False, 'refusal'),
        ('stop_sequence', False, 'stop_sequence'),
        ('tool_use', False, 'end_turn'),
        (None, False, 'end_turn'),
    ],
)
def test_stop_reasons_normalize_and_agree_with_the_calls(raw, has_calls, expected):
    assert stop_reason(raw, has_calls) == expected


def test_anthropic_wire_carries_signed_thinking_calls_results_and_cache_marks():
    llm = _anthropic()
    q = _loop_question(llm)
    q.addContext('The page is /home.')

    payload = _payload(llm, q, cache=True)

    assert payload['system'] == [{'type': 'text', 'text': q.getSystemPrompt(), 'cache_control': {'type': 'ephemeral'}}]
    assert [t['name'] for t in payload['tools']] == ['tool_github_1__create_issue', 'memory__peek']
    user, assistant, results = payload['messages']
    assert user == {'role': 'user', 'content': [{'type': 'text', 'text': 'File an issue.'}]}
    assert assistant['content'][0] == {'type': 'thinking', 'thinking': 'I should file it.', 'signature': SIG}
    assert [(b['type'], b.get('id'), b.get('name')) for b in assistant['content'][1:]] == [
        ('text', None, None),
        ('tool_use', 'call_1', 'tool_github_1__create_issue'),
        ('tool_use', 'call_2', 'memory__peek'),
    ]
    kinds = [(b['type'], b.get('tool_use_id'), b.get('is_error')) for b in results['content']]
    assert kinds == [('tool_result', 'call_1', False), ('tool_result', 'call_2', True), ('text', None, None)]
    assert 'The page is /home.' in results['content'][-1]['text']
    assert results['content'][-1]['cache_control'] == {'type': 'ephemeral'}
    assert sum('cache_control' in b for m in payload['messages'] for b in m['content']) == 1


def test_reasoning_from_another_model_is_not_sent():
    llm = _anthropic()
    q = _loop_question(llm)
    q.messages[1].content[0].state['origin'] = 'SomeOtherChatModel'

    assistant = _payload(llm, q)['messages'][1]

    assert [b['type'] for b in assistant['content']] == ['text', 'tool_use', 'tool_use']


def test_openai_wire_maps_names_and_sends_unparsable_arguments_back_empty():
    langchain_openai = pytest.importorskip('langchain_openai')
    llm = langchain_openai.ChatOpenAI(model='gpt-4.1', api_key='sk-test')
    q = _loop_question(_anthropic())

    payload = _payload(llm, q)

    assistant = payload['messages'][2]
    assert [(c['id'], c['function']['name'], c['function']['arguments']) for c in assistant['tool_calls']] == [
        ('call_1', 'tool_github_1__create_issue', '{"title": "Flaky"}'),
        ('call_2', 'memory__peek', '{}'),
    ]
    assert 'thinking' not in str(assistant['content'])
    assert [(m['role'], m.get('tool_call_id')) for m in payload['messages'][3:]] == [
        ('tool', 'call_1'),
        ('tool', 'call_2'),
    ]


def test_a_model_message_decodes_with_caller_names_and_its_reasoning_kept_whole():
    q = _loop_question(_anthropic())
    names = ToolNames.build(q.tools, q.messages)
    thinking = {'type': 'thinking', 'thinking': 'Label it.', 'signature': SIG, 'index': 0}
    reply = AIMessage(
        content=[thinking, {'type': 'text', 'text': 'Labelling.'}],
        tool_calls=[{'id': 'call_3', 'name': 'tool_github_1__create_issue', 'args': {'labels': ['bug']}}],
        invalid_tool_calls=[{'id': 'call_4', 'name': 'memory__peek', 'args': '{oops', 'error': 'bad json'}],
        response_metadata={'stop_reason': 'tool_use'},
    )

    message, stop = from_langchain(reply, names, 'ChatAnthropic')

    assert stop == 'tool_use'
    reasoning, text, call, bad = message.content
    assert (reasoning.text, reasoning.state) == ('Label it.', {'origin': 'ChatAnthropic', 'block': thinking})
    assert text.text == 'Labelling.'
    assert (call.id, call.name, call.args) == ('call_3', 'tool_github_1.create_issue', {'labels': ['bug']})
    assert (bad.id, bad.name, bad.args) == ('call_4', 'memory.peek', '{oops')


def test_think_tags_in_plain_text_become_reasoning_not_text():
    message, stop = from_langchain(AIMessage(content='<think>plan</think>Done.'), ToolNames({}), 'ChatOpenAI')

    assert [(type(b).__name__, getattr(b, 'text', None)) for b in message.content] == [
        ('ReasoningBlock', 'plan'),
        ('TextBlock', 'Done.'),
    ]
    assert stop == 'end_turn'


# ---------------------------------------------------------------------------
# The turn path, through the real drivers
# ---------------------------------------------------------------------------

NODES = Path(__file__).resolve().parents[5] / 'nodes' / 'src' / 'nodes'


class _Transport:
    """Replays canned HTTP responses and records each request body."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.bodies = []

    def __call__(self, request):
        import importlib

        # The Anthropic SDK is on httpx2 in newer pins and httpx in older ones; answer in its flavour.
        lib = importlib.import_module(type(request).__module__.split('.')[0])
        self.bodies.append(json.loads(request.content))
        status, content_type, body = self.responses.pop(0)
        return lib.Response(status, headers={'content-type': content_type}, content=body)


def _sse(events, named=True):
    return ''.join((f'event: {e["type"]}\n' if named else '') + f'data: {json.dumps(e)}\n\n' for e in events).encode()


def _driver(monkeypatch, node: str, module: str, config: dict):
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    spec = importlib.util.spec_from_file_location(f'_turn_{node}', NODES / node / module)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, mod.Chat(node, {}, {})


def _mock_anthropic_http(monkeypatch, transport):
    """Route langchain-anthropic's HTTP client through `transport`, with the httpx flavour its SDK uses."""
    import importlib

    import langchain_anthropic.chat_models as lca

    client = type(lca._get_default_httpx_client(base_url=None))
    lib = importlib.import_module(
        next(c.__module__ for c in client.__mro__ if c.__module__.startswith('httpx')).split('.')[0]
    )
    monkeypatch.setattr(
        lca,
        '_get_default_httpx_client',
        lambda **kw: lib.Client(transport=lib.MockTransport(transport), base_url=kw['base_url']),
    )


def _anthropic_driver(monkeypatch, transport, thinking=True):
    _mock_anthropic_http(monkeypatch, transport)
    config = {
        'model': 'claude-sonnet-4-6',
        'apikey': 'sk-ant-test',
        'modelTotalTokens': 200000,
        'modelOutputTokens': 8192,
        'capabilities': {'reasoning': True},
        'extendedThinking': thinking,
    }
    return _driver(monkeypatch, 'llm_anthropic', 'anthropic.py', config)[1]


def _anthropic_stream(text, tool=None):
    events = [
        {
            'type': 'message_start',
            'message': {
                'id': 'msg_1',
                'type': 'message',
                'role': 'assistant',
                'model': 'claude-sonnet-4-6',
                'content': [],
                'stop_reason': None,
                'stop_sequence': None,
                'usage': {'input_tokens': 50, 'output_tokens': 1},
            },
        },
        {
            'type': 'content_block_start',
            'index': 0,
            'content_block': {'type': 'thinking', 'thinking': '', 'signature': ''},
        },
        {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'thinking_delta', 'thinking': 'Plan the call.'}},
        {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'signature_delta', 'signature': SIG}},
        {'type': 'content_block_stop', 'index': 0},
        {'type': 'content_block_start', 'index': 1, 'content_block': {'type': 'text', 'text': ''}},
        {'type': 'content_block_delta', 'index': 1, 'delta': {'type': 'text_delta', 'text': text}},
        {'type': 'content_block_stop', 'index': 1},
    ]
    if tool:
        events += [
            {
                'type': 'content_block_start',
                'index': 2,
                'content_block': {'type': 'tool_use', 'id': 'toolu_1', 'name': tool, 'input': {}},
            },
            {
                'type': 'content_block_delta',
                'index': 2,
                'delta': {'type': 'input_json_delta', 'partial_json': '{"title": "Flaky"}'},
            },
            {'type': 'content_block_stop', 'index': 2},
        ]
    events += [
        {
            'type': 'message_delta',
            'delta': {'stop_reason': 'tool_use' if tool else 'end_turn', 'stop_sequence': None},
            'usage': {'output_tokens': 30},
        },
        {'type': 'message_stop'},
    ]
    return 200, 'text/event-stream', _sse(events)


def _turn(**fields) -> Question:
    return Question(
        role='You are the Rocket agent.',
        cachePrefix=True,
        tools=[{'name': 'tool_github_1.create_issue', 'description': 'File an issue.'}],
        messages=[UserMessage(content='File an issue about the flaky test.')],
        **fields,
    )


def test_a_streamed_anthropic_tool_loop_with_thinking(monkeypatch):
    transport = _Transport(
        _anthropic_stream('Filing it.', tool='tool_github_1__create_issue'), _anthropic_stream('Filed #42.')
    )
    chat = _anthropic_driver(monkeypatch, transport)
    q = _turn()
    thinking = []

    first = chat.chat(q, on_chunk=lambda _t: None, on_reasoning_chunk=thinking.append)

    sent = transport.bodies[0]
    assert sent['thinking'] == chat._thinking_mode_kwargs['thinking']
    assert sent['tools'][0]['name'] == 'tool_github_1__create_issue'
    assert sent['system'][0]['cache_control'] == {'type': 'ephemeral'}
    assert 'Plan the call.' in ''.join(thinking)
    assert first.stopReason == 'tool_use'
    assert first.getText() == 'Filing it.'
    assert [(c.id, c.name, c.args) for c in first.toolCalls()] == [
        ('toolu_1', 'tool_github_1.create_issue', {'title': 'Flaky'})
    ]

    q.addMessage(first.message)
    q.addToolResult('toolu_1', '#42')
    second = chat.chat(q, on_chunk=lambda _t: None)

    replayed = transport.bodies[1]['messages'][1]['content']
    assert replayed[0] == {'type': 'thinking', 'thinking': 'Plan the call.', 'signature': SIG}
    assert replayed[-1]['type'] == 'tool_use' and replayed[-1]['id'] == 'toolu_1'
    assert transport.bodies[1]['messages'][2]['content'][0]['tool_use_id'] == 'toolu_1'
    assert (second.stopReason, second.getText(), second.toolCalls()) == ('end_turn', 'Filed #42.', [])


def test_a_failed_stream_falls_back_to_one_invoke(monkeypatch):
    reply = {
        'id': 'msg_2',
        'type': 'message',
        'role': 'assistant',
        'model': 'claude-sonnet-4-6',
        'content': [{'type': 'text', 'text': 'Done.'}],
        'stop_reason': 'end_turn',
        'stop_sequence': None,
        'usage': {'input_tokens': 10, 'output_tokens': 2},
    }
    error = {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'bad stream'}}
    rejected = (400, 'application/json', json.dumps(error).encode())
    transport = _Transport(rejected, rejected, (200, 'application/json', json.dumps(reply).encode()))
    chat = _anthropic_driver(monkeypatch, transport, thinking=False)
    finished = []

    answer = chat.chat(_turn(), on_chunk=lambda _t: None, on_finish=finished.append)

    assert [body.get('stream', False) for body in transport.bodies] == [True, True, False]
    assert (answer.getText(), answer.stopReason, finished) == ('Done.', 'end_turn', ['end_turn'])


def test_an_openai_reasoning_turn_round_trips_encrypted_reasoning(monkeypatch):
    pytest.importorskip('langchain_openai')
    import httpx

    def response(item_id):
        return {
            'id': item_id,
            'type': 'reasoning',
            'summary': [{'type': 'summary_text', 'text': 'Need to file.'}],
            'encrypted_content': 'gAAAAenc==',
        }

    call = {
        'id': 'fc_1',
        'type': 'function_call',
        'call_id': 'call_1',
        'name': 'tool_github_1__create_issue',
        'arguments': '{"title": "Flaky"}',
        'status': 'completed',
    }
    usage = {
        'input_tokens': 40,
        'output_tokens': 20,
        'total_tokens': 60,
        'input_tokens_details': {'cached_tokens': 0},
        'output_tokens_details': {'reasoning_tokens': 10},
    }
    base = {
        'id': 'resp_1',
        'object': 'response',
        'created_at': 1,
        'model': 'gpt-5',
        'tools': [],
        'parallel_tool_calls': True,
        'tool_choice': 'auto',
    }
    events = [
        {'type': 'response.created', 'sequence_number': 0, 'response': {**base, 'status': 'in_progress', 'output': []}},
        {
            'type': 'response.output_item.added',
            'sequence_number': 1,
            'output_index': 0,
            'item': {**response('rs_1'), 'summary': []},
        },
        {
            'type': 'response.reasoning_summary_part.added',
            'sequence_number': 2,
            'item_id': 'rs_1',
            'output_index': 0,
            'summary_index': 0,
            'part': {'type': 'summary_text', 'text': ''},
        },
        {
            'type': 'response.reasoning_summary_text.delta',
            'sequence_number': 3,
            'item_id': 'rs_1',
            'output_index': 0,
            'summary_index': 0,
            'delta': 'Need to file.',
        },
        {'type': 'response.output_item.done', 'sequence_number': 4, 'output_index': 0, 'item': response('rs_1')},
        {
            'type': 'response.output_item.added',
            'sequence_number': 5,
            'output_index': 1,
            'item': {**call, 'arguments': '', 'status': 'in_progress'},
        },
        {
            'type': 'response.function_call_arguments.delta',
            'sequence_number': 6,
            'item_id': 'fc_1',
            'output_index': 1,
            'delta': call['arguments'],
        },
        {'type': 'response.output_item.done', 'sequence_number': 7, 'output_index': 1, 'item': call},
        {
            'type': 'response.completed',
            'sequence_number': 8,
            'response': {**base, 'status': 'completed', 'output': [response('rs_1'), call], 'usage': usage},
        },
    ]
    transport = _Transport(
        (200, 'text/event-stream', _sse(events, named=False)), (200, 'text/event-stream', _sse(events, named=False))
    )
    config = {
        'model': 'gpt-5',
        'apikey': 'sk-test',
        'modelTotalTokens': 400000,
        'modelOutputTokens': 8192,
        'capabilities': {'reasoning': True},
    }
    mod, _ = _driver(monkeypatch, 'llm_openai', 'openai_client.py', config)
    monkeypatch.setattr(
        mod,
        '_ResponsesChatOpenAI',
        functools.partial(mod._ResponsesChatOpenAI, http_client=httpx.Client(transport=httpx.MockTransport(transport))),
    )
    chat = mod.Chat('llm_openai', {}, {})
    q = _turn()
    thinking = []

    first = chat.chat(q, on_chunk=lambda _t: None, on_reasoning_chunk=thinking.append)
    q.addMessage(first.message)
    q.addToolResult('call_1', '#42')
    chat.chat(q, on_chunk=lambda _t: None)

    sent = transport.bodies[0]
    assert (sent['store'], sent['include'], sent['max_output_tokens']) == (False, ['reasoning.encrypted_content'], 8192)
    assert 'Need to file.' in ''.join(thinking)
    assert first.stopReason == 'tool_use'
    assert [(c.id, c.name) for c in first.toolCalls()] == [('call_1', 'tool_github_1.create_issue')]
    replayed = transport.bodies[1]['input']
    kinds = [item.get('type') for item in replayed]
    assert kinds.index('reasoning') < kinds.index('function_call') < kinds.index('function_call_output')
    assert replayed[kinds.index('reasoning')]['encrypted_content'] == 'gAAAAenc=='


class _Inner:
    def __init__(self):
        self.written = []

    def writeAnswers(self, answer):
        self.written.append(answer)

    def sendSSE(self, *a, **k):
        pass


class _Untouchable:
    """A driver without native tools whose model fails the test if it is ever called."""

    _model = 'some-model'

    def chat(self, question):
        raise AssertionError('the provider must not be called')


def _node(chat) -> LLMBase:
    node = LLMBase.__new__(LLMBase)
    node.IGlobal = type('G', (), {'_chat': chat})()
    node.instance = _Inner()
    return node


def test_a_turn_to_a_driver_without_native_tools_is_refused_before_any_request():
    node = _node(_Untouchable())

    node.writeQuestions(_turn())

    error = node.instance.written[0].error
    assert error.code == 'tools_unsupported'
    with pytest.raises(Exception, match='does not support native tool calling'):
        node.ask(type('Ask', (), {'question': _turn(), 'stop': None})())


def test_a_failed_turn_is_a_typed_error_and_a_text_question_keeps_its_text_error():
    class _Failing:
        supports_tools = True

        def chat(self, question, on_chunk=None, on_finish=None, on_reasoning_chunk=None):
            raise RuntimeError('provider down')

    node = _node(_Failing())
    text = Question()
    text.addQuestion('hi')

    node.writeQuestions(_turn())
    node.writeQuestions(text)

    turn_answer, text_answer = node.instance.written
    assert (turn_answer.error.code, turn_answer.message) == ('provider_error', None)
    assert text_answer.getText().startswith('**LLM error**') and text_answer.error is None


def test_a_question_like_object_takes_the_text_path():
    from ai.common.chat import ChatBase

    class _QuestionLike:
        expectJson = False
        cachePrefix = False

        def getPrompt(self):
            return 'hi'

    chat = ChatBase.__new__(ChatBase)
    chat.chat_string = lambda prompt, **_: f'echo {prompt}'

    assert chat.chat(_QuestionLike()).getText() == 'echo hi'


def _flagged_drivers():
    """Each llm_* Chat class that sets SUPPORTS_NATIVE_TOOLS = True, with the methods it defines."""
    found = {}
    for path in sorted(NODES.glob('llm_*/*.py')):
        for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
            if isinstance(node, ast.ClassDef) and node.name == 'Chat':
                flags = {
                    t.id
                    for s in node.body
                    if isinstance(s, ast.Assign) and getattr(s.value, 'value', None) is True
                    for t in s.targets
                    if isinstance(t, ast.Name)
                }
                if 'SUPPORTS_NATIVE_TOOLS' in flags:
                    found[path.parent.name] = {s.name for s in node.body if isinstance(s, ast.FunctionDef)}
    return found


def test_drivers_with_native_tools_do_not_override_chat():
    drivers = _flagged_drivers()

    assert set(drivers) == {'llm_anthropic', 'llm_openai', 'llm_openai_api'}
    assert [name for name, methods in drivers.items() if 'chat' in methods] == []
