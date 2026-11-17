# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A hosted backend's refusal reaches the user as its sentence, after exactly one request.

The OpenAI nodes run for real here: the openai SDK and langchain-openai build and send
every request, and only the network is replaced. A stand-in for the hosted backend sits
behind httpx's transport, records each request and answers from a script. For every
refusal code and every model path (a reasoning prompt, an ordinary prompt, a native tool
turn, each streamed and not, and the compatible reasoning stream), the tests count what
reached it: one request for a definitive refusal, and only the SDK's own tries for the
codes the SDK retries. Nothing may send the request again without ``stop`` or without the
usage flag, fall back to another path, or hand back an empty answer.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from pathlib import Path

import pytest

pytest.importorskip('langchain_openai')
openai = pytest.importorskip('openai')
import httpx  # noqa: E402

from ai.common.config import Config  # noqa: E402
from ai.common.llm_native_stream import STOP_SEQUENCES_VAR  # noqa: E402
from ai.common.model_gateway import GATEWAY_ENV, HostedModelError  # noqa: E402
from ai.common.schema import Question, UserMessage  # noqa: E402

NODES = Path(__file__).resolve().parents[5] / 'nodes' / 'src' / 'nodes'

BASE_URL = 'http://127.0.0.1:41873/gateway/openai/v1'
TOKEN = 'rrmg_' + 'b' * 43
STOP = ['\nObservation:']

SENTENCES = {
    'insufficient_credits': (
        "This workspace doesn't have enough compute credits left for this request on RocketRide-hosted models. "
        'Add your own OpenAI key in the node settings, or ask a workspace admin to check compute credits '
        'under Account > Billing in RocketRide.'
    ),
    'model_not_available': (
        "The model {model} isn't offered as a RocketRide-hosted model. Choose another model, "
        'or add your own OpenAI key in the node settings.'
    ),
    'invalid_gateway_pass': "This run's access to RocketRide-hosted models has ended. Start the pipeline again.",
    'request_too_large': (
        'This request is too large for RocketRide-hosted models. Send less text, or add your own OpenAI key '
        'in the node settings.'
    ),
    'unsupported_parameter': (
        "RocketRide-hosted models don't support stop. Add your own OpenAI key in the node settings to run this request."
    ),
    'rate_limited': 'This run has too many requests open at once on RocketRide-hosted models. Try again shortly.',
    'gateway_unavailable': (
        'RocketRide-hosted models are unavailable right now. Try again shortly, or add your own OpenAI key '
        'in the node settings.'
    ),
    'upstream_unavailable': (
        'RocketRide-hosted models are unavailable right now. Try again shortly, or add your own OpenAI key '
        'in the node settings.'
    ),
}
STATUS = {
    'insufficient_credits': 402,
    'model_not_available': 400,
    'invalid_gateway_pass': 401,
    'request_too_large': 413,
    'unsupported_parameter': 400,
    'rate_limited': 429,
    'gateway_unavailable': 503,
    'upstream_unavailable': 503,
}
# The openai SDK retries these statuses on its own, twice by default, before the error reaches the engine.
SDK_TRIES = {code: 3 if STATUS[code] in (429, 503) else 1 for code in STATUS}
# The three codes whose status matched a retry test before (400, 402, 413).
USED_TO_MATCH = ('unsupported_parameter', 'insufficient_credits', 'request_too_large')

PLAIN = {
    'model': 'gpt-4o-mini',
    'apikey': '',
    'modelTotalTokens': 128000,
    'modelOutputTokens': 4096,
    'capabilities': {'reasoning': False},
}
REASONING = {
    'model': 'gpt-5-nano',
    'apikey': '',
    'modelTotalTokens': 400000,
    'modelOutputTokens': 8192,
    'capabilities': {'reasoning': True},
}


# ---------------------------------------------------------------------------
# The stand-in
# ---------------------------------------------------------------------------


class _Dropped(httpx.SyncByteStream):
    """A stream that sends one empty chunk, then loses the connection."""

    def __init__(self, first: bytes):
        self.first = first

    def __iter__(self):
        yield self.first
        raise httpx.RemoteProtocolError('peer closed connection without sending complete message body')


class Backend:
    """Records every request and answers from a script; the last entry repeats."""

    def __init__(self, *script):
        self.script = list(script)
        self.requests: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        self.requests.append(
            {
                'url': str(request.url),
                'authorization': request.headers.get('authorization'),
                'body': body,
            }
        )
        answer = self.script[min(len(self.requests), len(self.script)) - 1]
        return answer(body)

    @property
    def bodies(self) -> list[dict]:
        return [r['body'] for r in self.requests]


def refusal(code: str, message: str = ''):
    status = STATUS.get(code, 400)
    err = {'message': message or f'refused: {code}', 'type': 'rocketride_gateway_error', 'code': code}

    def answer(_body):
        # retry-after-ms keeps the SDK's own retries fast; it does not change how many it makes
        headers = {'x-rocketride-gateway': '1', 'retry-after-ms': '1'}
        return httpx.Response(status, headers=headers, json={'error': err})

    return answer


def ordinary_error(status: int = 400):
    err = {'message': 'Invalid value for messages.', 'type': 'invalid_request_error', 'code': None}
    return lambda _body: httpx.Response(status, headers={'retry-after-ms': '1'}, json={'error': err})


def _sse(chunks) -> bytes:
    return ''.join(f'data: {json.dumps(c)}\n\n' for c in chunks).encode() + b'data: [DONE]\n\n'


def _chunk(delta, finish=None):
    return {
        'id': 'chatcmpl-1',
        'object': 'chat.completion.chunk',
        'created': 1,
        'model': 'gpt-4o-mini',
        'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}],
    }


def text_and_tool_call(_body):
    """A streamed turn that shows text, then calls a tool."""
    call = {
        'index': 0,
        'id': 'call_1',
        'type': 'function',
        'function': {'name': 'tool_github_1__create_issue', 'arguments': '{"title": "Flaky"}'},
    }
    chunks = [
        _chunk({'role': 'assistant', 'content': 'Filing it.'}),
        _chunk({'tool_calls': [call]}),
        _chunk({}, 'tool_calls'),
        {**_chunk({}), 'choices': [], 'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}},
    ]
    return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=_sse(chunks))


def dropped_stream(_body):
    first = f'data: {json.dumps(_chunk({"role": "assistant"}))}\n\n'.encode()
    return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=_Dropped(first))


def responses_without_text(_body):
    """A Responses stream that ends without any text, which sends the engine to its fallback."""
    base = {
        'id': 'resp_1',
        'object': 'response',
        'created_at': 1,
        'model': 'gpt-5-nano',
        'tools': [],
        'parallel_tool_calls': True,
        'tool_choice': 'auto',
    }
    usage = {
        'input_tokens': 5,
        'output_tokens': 0,
        'total_tokens': 5,
        'input_tokens_details': {'cached_tokens': 0},
        'output_tokens_details': {'reasoning_tokens': 0},
    }
    events = [
        {'type': 'response.created', 'sequence_number': 0, 'response': {**base, 'status': 'in_progress', 'output': []}},
        {
            'type': 'response.completed',
            'sequence_number': 1,
            'response': {**base, 'status': 'completed', 'output': [], 'usage': usage},
        },
    ]
    content = ''.join(f'data: {json.dumps(e)}\n\n' for e in events).encode()
    return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=content)


# ---------------------------------------------------------------------------
# Drivers
# ---------------------------------------------------------------------------


@pytest.fixture
def backend(monkeypatch):
    """Route every httpx request in this process to a stand-in the test scripts."""
    holder = {}

    def handle(self, request):
        return holder['backend'](request)

    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', handle)

    def install(*script):
        holder['backend'] = Backend(*script)
        return holder['backend']

    return install


@pytest.fixture
def hosted(monkeypatch):
    """A hosted task with a live pass, and a key in the environment that must never be used."""
    monkeypatch.setattr(sys, 'argv', [*sys.argv, '--hosted'])
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-canary-environment')
    gateway = {'provider': 'openai', 'base_url': BASE_URL, 'token': TOKEN, 'expires_at': time.time() + 3600}
    monkeypatch.setenv(GATEWAY_ENV, json.dumps(gateway))


def _driver(monkeypatch, node: str, config: dict):
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    spec = importlib.util.spec_from_file_location(f'_hosted_{node}', NODES / node / 'openai_client.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    chat = mod.Chat(node, {}, {})
    # Count tokens without a tokenizer download
    chat.getTokens = lambda value: len(value) // 4
    return chat


def _prompt() -> Question:
    q = Question()
    q.addQuestion('What is 2+2?')
    return q


def _turn() -> Question:
    return Question(
        role='You are the Rocket agent.',
        tools=[{'name': 'tool_github_1.create_issue', 'description': 'File an issue.'}],
        messages=[UserMessage(content='File an issue about the flaky test.')],
    )


# name: (node, config, question)
PATHS = {
    'reasoning-prompt': ('llm_openai', REASONING, _prompt),
    'prompt': ('llm_openai', PLAIN, _prompt),
    'tool-turn': ('llm_openai', PLAIN, _turn),
    'reasoning-tool-turn': ('llm_openai', REASONING, _turn),
}


def _ask(chat, question: Question, streamed: bool, stop: bool):
    """Run one question; returns (raised error, text the callbacks received)."""
    shown: list[str] = []
    token = STOP_SEQUENCES_VAR.set(list(STOP)) if stop else None
    try:
        if streamed:
            chat.chat(question, on_chunk=shown.append, on_reasoning_chunk=shown.append)
        else:
            chat.chat(question)
    except Exception as e:  # noqa: BLE001 - the test inspects what was raised
        return e, shown
    finally:
        if token is not None:
            STOP_SEQUENCES_VAR.reset(token)
    return None, shown


def _expected(code: str, model: str) -> str:
    return SENTENCES[code].format(model=model)


# ---------------------------------------------------------------------------
# Every code, every path
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('stop', [False, True], ids=['no-stop', 'stop'])
@pytest.mark.parametrize('streamed', [True, False], ids=['streamed', 'invoked'])
@pytest.mark.parametrize('path', sorted(PATHS))
@pytest.mark.parametrize('code', sorted(STATUS))
def test_a_refusal_is_raised_once_with_its_sentence(monkeypatch, backend, hosted, code, path, streamed, stop):
    node, config, question = PATHS[path]
    gateway = backend(refusal(code, SENTENCES['unsupported_parameter'] if code == 'unsupported_parameter' else ''))
    chat = _driver(monkeypatch, node, config)

    error, shown = _ask(chat, question(), streamed, stop)

    assert isinstance(error, HostedModelError), repr(error)
    assert str(error) == _expected(code, config['model'])
    assert shown == []
    assert len(gateway.requests) == SDK_TRIES[code]
    # Every request went to the pass's URL with the pass, never with the key in the environment
    assert all(r['url'].startswith(BASE_URL + '/') for r in gateway.requests)
    assert {r['authorization'] for r in gateway.requests} == {f'Bearer {TOKEN}'}
    if code in USED_TO_MATCH and stop:
        # No second request without stop, or without the usage flag
        sent_stop = [b for b in gateway.bodies if 'stop' in b]
        assert len(sent_stop) in (0, len(gateway.bodies))


@pytest.mark.parametrize('stop', [False, True], ids=['no-stop', 'stop'])
@pytest.mark.parametrize('code', sorted(STATUS))
def test_a_refusal_on_the_compatible_reasoning_stream_is_raised_once(monkeypatch, backend, hosted, code, stop):
    """llm_openai_api with a reasoning model streams through its own raw client, built from the pass."""
    gateway = backend(refusal(code, SENTENCES['unsupported_parameter'] if code == 'unsupported_parameter' else ''))
    chat = _driver(monkeypatch, 'llm_openai_api', {**REASONING, 'base_url': ''})

    error, shown = _ask(chat, _prompt(), True, stop)

    assert chat._native_stream_provider == 'openai_compat_reasoning'
    assert isinstance(error, HostedModelError), repr(error)
    assert str(error) == _expected(code, REASONING['model'])
    assert shown == []
    assert len(gateway.requests) == SDK_TRIES[code]
    assert all(r['url'] == f'{BASE_URL}/chat/completions' for r in gateway.requests)
    assert all('stream_options' in b for b in gateway.bodies)
    assert all(('stop' in b) == stop for b in gateway.bodies)


@pytest.mark.parametrize('stop', [False, True], ids=['no-stop', 'stop'])
@pytest.mark.parametrize('streamed', [True, False], ids=['streamed', 'invoked'])
@pytest.mark.parametrize('path', ['prompt', 'tool-turn'])
@pytest.mark.parametrize('code', USED_TO_MATCH)
def test_the_codes_that_matched_a_retry_test_send_one_request(monkeypatch, backend, hosted, code, path, streamed, stop):
    """400, 402 and 413 on Chat Completions: the request goes once, with stop and the usage flag as asked."""
    node, config, question = PATHS[path]
    gateway = backend(refusal(code))
    chat = _driver(monkeypatch, node, config)

    error, _shown = _ask(chat, question(), streamed, stop)

    assert isinstance(error, HostedModelError)
    assert len(gateway.requests) == 1
    body = gateway.bodies[0]
    assert ('stop' in body) == stop
    assert ('stream_options' in body) == streamed


# ---------------------------------------------------------------------------
# A refusal on a fallback call
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'path,first',
    [
        ('reasoning-prompt', responses_without_text),
        ('prompt', dropped_stream),
        ('tool-turn', dropped_stream),
    ],
)
def test_a_refusal_on_the_fallback_call_is_raised(monkeypatch, backend, hosted, path, first):
    """The first request fails in an ordinary way; the fallback is the one refused. No third request."""
    node, config, question = PATHS[path]
    gateway = backend(first, refusal('insufficient_credits'))
    chat = _driver(monkeypatch, node, config)

    error, shown = _ask(chat, question(), True, False)

    assert isinstance(error, HostedModelError), repr(error)
    assert str(error) == SENTENCES['insufficient_credits']
    assert shown == []
    assert len(gateway.requests) == 2


def test_a_refusal_after_text_was_streamed_on_the_turn_before(monkeypatch, backend, hosted):
    """A turn shows text and calls a tool; the next turn is refused and raises, not an empty answer."""
    gateway = backend(text_and_tool_call, refusal('insufficient_credits'))
    chat = _driver(monkeypatch, 'llm_openai', PLAIN)
    q = _turn()
    shown: list[str] = []

    first = chat.chat(q, on_chunk=shown.append)
    assert ''.join(shown) == 'Filing it.'
    assert [c.id for c in first.toolCalls()] == ['call_1']
    q.addMessage(first.message)
    q.addToolResult('call_1', '#42')
    with pytest.raises(HostedModelError) as caught:
        chat.chat(q, on_chunk=shown.append)

    assert str(caught.value) == SENTENCES['insufficient_credits']
    assert ''.join(shown) == 'Filing it.'
    assert len(gateway.requests) == 2


# ---------------------------------------------------------------------------
# The JSON repair loop
# ---------------------------------------------------------------------------


def _json_prompt() -> Question:
    q = Question(expectJson=True)
    q.addQuestion('Return {"answer": 4} as JSON.')
    return q


def _completion(text: str):
    body = {
        'id': 'chatcmpl-1',
        'object': 'chat.completion',
        'created': 1,
        'model': 'gpt-4o-mini',
        'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': text}, 'finish_reason': 'stop'}],
        'usage': {'prompt_tokens': 5, 'completion_tokens': 3, 'total_tokens': 8},
    }
    return lambda _body: httpx.Response(200, json=body)


def test_a_refused_json_question_is_not_asked_again(monkeypatch, backend, hosted):
    gateway = backend(refusal('insufficient_credits'))
    chat = _driver(monkeypatch, 'llm_openai', PLAIN)

    with pytest.raises(HostedModelError):
        chat.chat(_json_prompt())
    assert len(gateway.requests) == 1


def test_a_refused_json_repair_is_not_asked_again(monkeypatch, backend, hosted):
    """The first answer is not JSON; the repair request is refused; there is no third."""
    gateway = backend(_completion('not json at all'), refusal('insufficient_credits'))
    chat = _driver(monkeypatch, 'llm_openai', PLAIN)

    with pytest.raises(HostedModelError):
        chat.chat(_json_prompt())
    assert len(gateway.requests) == 2


# ---------------------------------------------------------------------------
# Nothing changes for a node with its own key, or for an ordinary error
# ---------------------------------------------------------------------------

# Requests a 400 invalid_request_error costs on each path, and what is raised: the same
# numbers and errors as before hosted models existed, fallbacks included. The reasoning
# prompt's fallback raises the SDK's error as it is (langchain-openai may subclass it).
ORDINARY = {
    ('reasoning-prompt', True): (2, openai.BadRequestError, None),
    ('reasoning-prompt', False): (2, openai.BadRequestError, None),
    ('prompt', True): (3, ValueError, 'An error occurred with the OpenAI API.'),
    ('prompt', False): (1, ValueError, 'An error occurred with the OpenAI API.'),
    ('tool-turn', True): (3, ValueError, 'An error occurred with the OpenAI API.'),
    ('tool-turn', False): (1, ValueError, 'An error occurred with the OpenAI API.'),
}


@pytest.fixture
def keyed(monkeypatch):
    """A self-hosted task: no pass, and the node brings its own key."""
    monkeypatch.setattr(sys, 'argv', [a for a in sys.argv if a not in ('--hosted', '--saas')])
    monkeypatch.delenv(GATEWAY_ENV, raising=False)


@pytest.mark.parametrize('path,streamed', sorted(ORDINARY))
def test_an_ordinary_error_with_a_key_of_its_own_is_unchanged(monkeypatch, backend, keyed, path, streamed):
    node, config, question = PATHS[path]
    gateway = backend(ordinary_error(400))
    chat = _driver(monkeypatch, node, {**config, 'apikey': 'sk-user'})

    error, _shown = _ask(chat, question(), streamed, False)

    count, kind, message = ORDINARY[(path, streamed)]
    assert isinstance(error, kind) and not isinstance(error, HostedModelError), repr(error)
    if message:
        assert str(error) == message
    assert len(gateway.requests) == count
    assert {r['authorization'] for r in gateway.requests} == {'Bearer sk-user'}
    assert all(r['url'].startswith('https://api.openai.com/v1/') for r in gateway.requests)


@pytest.mark.parametrize('path,streamed', sorted(ORDINARY))
def test_an_ordinary_error_on_hosted_models_keeps_its_fallbacks(monkeypatch, backend, hosted, path, streamed):
    """An upstream error the backend passes through is not a refusal: today's handling applies."""
    node, config, question = PATHS[path]
    gateway = backend(ordinary_error(400))
    chat = _driver(monkeypatch, node, config)

    error, _shown = _ask(chat, question(), streamed, False)

    count, kind, _message = ORDINARY[(path, streamed)]
    assert isinstance(error, kind) and not isinstance(error, HostedModelError), repr(error)
    assert len(gateway.requests) == count


def test_a_refusal_shape_from_a_node_with_its_own_key_is_not_rewritten(monkeypatch, backend, keyed):
    """Only hosted models map refusals; another server sending the same type gets today's message."""
    gateway = backend(refusal('insufficient_credits'))
    chat = _driver(monkeypatch, 'llm_openai', {**PLAIN, 'apikey': 'sk-user'})

    error, _shown = _ask(chat, _prompt(), False, False)

    assert type(error) is ValueError
    assert str(error) == 'An error occurred with the OpenAI API.'
    assert len(gateway.requests) == 1
