# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The OpenAI-compatible node recovers when an endpoint rejects its temperature.

The node sent `temperature: 0` with every request and had no setting for it. Models
that only run at their own default (Claude Opus 4.7 and 4.8, the Claude 5 models,
OpenAI's reasoning models) answer that with HTTP 400, and so does a gateway in front of one, where the
node only sees a deployment name. Every call then failed (#3363).

The node now sends a request refused that way once more without a temperature, and
drops the value from that model's requests for the rest of the run only if that second
request goes through.

These tests run the real node driver and the real langchain-openai client against a
local HTTP server that records each request body and answers the way those endpoints
do, so they check what goes on the wire. No key or network is used. The three provider
error bodies are the ones the endpoints returned.

The driver is built as its IGlobal builds it, over the engine-resolved schema, and every
request runs inside the call it serves (``ChatBase.calling``), as LLMBase runs it: the
temperature is a per-call parameter, bound onto each request with the model.
"""

from __future__ import annotations

import inspect
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import rocketlib
from rocketlib.config import resolveConfig

pytest.importorskip('langchain_openai')
openai = pytest.importorskip('openai')

from ai.common.llm_native_stream import STOP_SEQUENCES_VAR  # noqa: E402
from ai.common.llm_tools import model_origin  # noqa: E402

NODES_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from llm_openai_api import openai_client  # noqa: E402

_LOGICAL_TYPE = 'llm_openai_api'
# The Nebius preset (services.nebius.json): the same driver, no Temperature field
_NEBIUS = 'llm_nebius'

# What each endpoint answered a request carrying `temperature: 0` (status, body).
OPENAI = (
    400,
    {
        'error': {
            'message': "Unsupported value: 'temperature' does not support 0 with this model. "
            'Only the default (1) value is supported.',
            'type': 'invalid_request_error',
            'param': 'temperature',
            'code': 'unsupported_value',
        }
    },
)
ANTHROPIC = (
    400,
    {
        'error': {
            'code': 'invalid_request_error',
            'message': '`temperature` is deprecated for this model.',
            'type': 'invalid_request_error',
            'param': None,
        }
    },
)
LITELLM = (
    400,
    {
        'error': {
            'message': 'litellm.UnsupportedParamsError: claude-opus-5-5 does not support temperature=0.0. '
            'Only temperature=1 is supported. To drop unsupported params, set `litellm.drop_params = True`.'
            "\n\nLiteLLM: model group 'rr-gw-deploy-a' failed with the error above. No fallback was attempted.",
            'type': 'invalid_request_error',
            'param': None,
            'code': '400',
        }
    },
)
# The shape a FastAPI-based server gives a request-validation failure (not from a captured run).
FASTAPI = (
    422,
    {
        'detail': [
            {
                'type': 'extra_forbidden',
                'loc': ['body', 'temperature'],
                'msg': 'Extra inputs are not permitted',
                'input': 0,
            }
        ]
    },
)
# More ways a refusal can name the temperature (shapes, not captured runs): a gateway that
# wraps the provider's error in its own, a message that names it only as a key of the
# parameters it does not support, a FastAPI check on the whole request, and a message that
# states the parameter and then copies the request.
WRAPPED = (
    400,
    {
        'error': {
            'message': 'Provider returned error',
            'code': 400,
            'metadata': {
                'raw': '{"type":"error","error":{"type":"invalid_request_error",'
                '"message":"`temperature` is deprecated for this model."}}',
                'provider_name': 'Anthropic',
            },
        }
    },
)
NAMED_AS_A_KEY = (
    400,
    {
        'error': {
            'message': "UnsupportedParamsError: this deployment does not support parameters: {'temperature': 0.0}.",
            'type': 'invalid_request_error',
            'param': None,
            'code': '400',
        }
    },
)
FASTAPI_WHOLE_REQUEST = (
    422,
    {
        'detail': [
            {
                'type': 'value_error',
                'loc': ['body'],
                'msg': 'Value error, this model only runs at its default temperature',
                'input': {'model': 'any-model', 'messages': []},
            }
        ]
    },
)
STATED_BESIDE_A_COPY = (
    400,
    {
        'error': {
            'message': "Unsupported parameters: {'temperature': 0}. "
            "Request: {'model': 'deployment', 'messages': [], 'temperature': 0}",
            'type': 'invalid_request_error',
            'param': None,
            'code': '400',
        }
    },
)
# A server that lists nothing in `detail` and states the refusal in a `message` beside it.
# (A shape, not a captured run.)
MESSAGE_BESIDE_A_DETAIL_LIST = (
    400,
    {'message': 'temperature is not supported by this model', 'detail': []},
)
TEMPERATURE_REJECTIONS = [
    pytest.param(OPENAI, id='openai'),
    pytest.param(ANTHROPIC, id='anthropic'),
    pytest.param(LITELLM, id='litellm'),
    pytest.param(FASTAPI, id='fastapi-422'),
    pytest.param(WRAPPED, id='wrapped-provider-error'),
    pytest.param(NAMED_AS_A_KEY, id='named-only-as-a-key'),
    pytest.param(FASTAPI_WHOLE_REQUEST, id='fastapi-422-whole-request'),
    pytest.param(STATED_BESIDE_A_COPY, id='stated-beside-a-copy-of-the-request'),
    pytest.param(MESSAGE_BESIDE_A_DETAIL_LIST, id='message-beside-a-detail-list'),
]

# Refusals that are not about the temperature, whatever the message mentions.
OTHER_REJECTIONS = [
    pytest.param(
        (
            400,
            {
                'error': {
                    'message': "Unsupported parameter: 'max_tokens' is not supported with this model.",
                    'type': 'invalid_request_error',
                    'param': 'max_tokens',
                    'code': 'unsupported_parameter',
                }
            },
        ),
        id='another-parameter',
    ),
    pytest.param(
        (
            400,
            {
                'error': {
                    'message': "Invalid 'stop': not supported at this temperature setting.",
                    'type': 'invalid_request_error',
                    'param': 'stop',
                    'code': 'unsupported_parameter',
                }
            },
        ),
        id='another-parameter-whose-message-mentions-temperature',
    ),
    pytest.param(
        (
            400,
            {
                'error': {
                    'message': 'This model has a maximum context length of 8192 tokens.',
                    'type': 'invalid_request_error',
                    'param': None,
                    'code': 'context_length_exceeded',
                }
            },
        ),
        id='no-parameter-named',
    ),
    pytest.param(
        (401, {'error': {'message': 'Bad key for the temperature service.', 'type': 'authentication_error'}}),
        id='not-a-rejected-request',
    ),
    # A FastAPI-based server copies the request into `input`, which always carries a
    # temperature and says nothing about why the request was refused. (A shape, not a captured run.)
    pytest.param(
        (
            422,
            {
                'detail': [
                    {
                        'type': 'missing',
                        'loc': ['body', 'user'],
                        'msg': 'Field required',
                        'input': {'model': 'any-model', 'messages': [], 'temperature': 0},
                    }
                ]
            },
        ),
        id='validation-detail-that-copies-the-request',
    ),
    # The same with a `message` beside the list that is about something else: the message is
    # read, the copy in `input` still is not.
    pytest.param(
        (
            422,
            {
                'message': 'Request validation failed',
                'detail': [
                    {
                        'type': 'missing',
                        'loc': ['body', 'user'],
                        'msg': 'Field required',
                        'input': {'model': 'any-model', 'messages': [], 'temperature': 0},
                    }
                ],
            },
        ),
        id='validation-detail-that-copies-the-request-beside-another-message',
    ),
]

# A server that copies the request into its message names the temperature in every refusal,
# whatever the refusal is about. (A shape, not a captured run.)
MESSAGE_COPY = (
    400,
    {
        'object': 'error',
        'message': '1 validation error for ChatCompletionRequest\n  Value error, When using `tool_choice`, '
        "`tools` must be set. [type=value_error, input_value={'model': 'any-model', "
        "'temperature': 0.0, 'tool_choice': 'auto'}, input_type=dict]",
        'type': 'BadRequestError',
        'param': None,
        'code': 400,
    },
)

# What a strict proxy answers a request that asks for streaming usage.
USAGE_REJECTION = (
    400,
    {
        'error': {
            'message': "Unknown parameter: 'stream_options'.",
            'type': 'invalid_request_error',
            'param': 'stream_options',
            'code': 'unknown_parameter',
        }
    },
)

# What a model that takes no stop sequences answers a request that carries one. (A shape,
# not a captured run; the fields are the ones OpenAI's API uses for an unsupported parameter.)
STOP_REJECTION = (
    400,
    {
        'error': {
            'message': "Unsupported parameter: 'stop' is not supported with this model.",
            'type': 'invalid_request_error',
            'param': 'stop',
            'code': 'unsupported_parameter',
        }
    },
)


def _completion(body: dict) -> bytes:
    """Answer `ok`, as one JSON completion or as a stream, the way the request asks."""
    base = {'id': 'chatcmpl-1', 'created': 0, 'model': body.get('model')}
    usage = {'prompt_tokens': 3, 'completion_tokens': 1, 'total_tokens': 4}
    if not body.get('stream'):
        message = {'role': 'assistant', 'content': 'ok'}
        choice = {'index': 0, 'message': message, 'finish_reason': 'stop'}
        return json.dumps({**base, 'object': 'chat.completion', 'choices': [choice], 'usage': usage}).encode()
    base['object'] = 'chat.completion.chunk'
    events = [
        {**base, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': 'ok'}, 'finish_reason': None}]},
        {**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]},
    ]
    if (body.get('stream_options') or {}).get('include_usage'):
        events.append({**base, 'choices': [], 'usage': usage})
    return ''.join(f'data: {json.dumps(e)}\n\n' for e in events).encode() + b'data: [DONE]\n\n'


class _Endpoint(BaseHTTPRequestHandler):
    """An OpenAI-compatible endpoint that can refuse requests the way the real ones do."""

    bodies: list = []
    # (status, body) sent instead of an answer, or None to answer every request.
    rejection = None
    # False: refuse only requests that carry a temperature. True: refuse every request.
    reject_always = False
    # When set, only requests for one of these models are refused; None refuses whatever the model.
    refusing_models = None
    # When set, requests that carry a temperature wait here for each other before they are refused.
    barrier = None
    # (status, body) for a request that carries `stop` and was not refused above, or None.
    stop_rejection = None
    # (status, body) for a request that carries `stream_options` and was not refused above, or None.
    usage_rejection = None

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('content-length') or 0)))
        _Endpoint.bodies.append(body)
        refuse = (
            _Endpoint.rejection is not None
            and (_Endpoint.reject_always or 'temperature' in body)
            and (_Endpoint.refusing_models is None or body.get('model') in _Endpoint.refusing_models)
        )
        if refuse and _Endpoint.barrier is not None and 'temperature' in body:
            _Endpoint.barrier.wait(timeout=20)
        if refuse:
            status, payload = _Endpoint.rejection
            data, content_type = json.dumps(payload).encode(), 'application/json'
        elif _Endpoint.stop_rejection is not None and 'stop' in body:
            status, payload = _Endpoint.stop_rejection
            data, content_type = json.dumps(payload).encode(), 'application/json'
        elif _Endpoint.usage_rejection is not None and 'stream_options' in body:
            status, payload = _Endpoint.usage_rejection
            data, content_type = json.dumps(payload).encode(), 'application/json'
        else:
            status, data = 200, _completion(body)
            content_type = 'text/event-stream' if body.get('stream') else 'application/json'
        self.send_response(status)
        self.send_header('content-type', content_type)
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def endpoint():
    """Start the local endpoint; yields its base URL and the request bodies it received."""
    _Endpoint.bodies = []
    _Endpoint.rejection = None
    _Endpoint.reject_always = False
    _Endpoint.refusing_models = None
    _Endpoint.barrier = None
    _Endpoint.stop_rejection = None
    _Endpoint.usage_rejection = None
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), _Endpoint)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{httpd.server_address[1]}/v1', _Endpoint.bodies
    httpd.shutdown()
    httpd.server_close()


class _Node:
    """The node's chat, built as its IGlobal builds it, and the settings of a call that sets no parameter."""

    def __init__(self, driver, settings):
        """Keep the chat and the resolved configuration its calls overlay."""
        self.driver = driver
        self.settings = settings

    @property
    def llm(self):
        """The one LangChain client every call of the control goes through."""
        return self.driver._llm

    def calling(self, params=None):
        """Serve one call on the chat, with the caller's parameters, as LLMBase does around a request."""
        return self.driver.calling(self.driver.resolve_call(self.settings.overlay(params)))


@pytest.fixture
def node(monkeypatch, endpoint):
    """Return a function that builds the node over a config, plus the warnings it raised."""
    base_url, _bodies = endpoint
    warnings: list = []
    monkeypatch.setattr(openai_client, 'warning', warnings.append)

    def build(model: str = 'any-model', logical_type: str = _LOGICAL_TYPE, stored=None, **extra) -> _Node:
        if stored is None:
            stored = {'model': model, 'modelTotalTokens': 200000, 'modelOutputTokens': 4096, **extra}
        schema = rocketlib.getServiceSchema(logical_type)
        assert schema is not None, f'{logical_type} is not registered with the engine'
        view = resolveConfig(schema, {'base_url': base_url, 'apikey': 'sk-test', **stored})
        # The IGlobal's view refuses the per-call leaves; the call's settings serve them
        chat = openai_client.Chat(logical_type, view.restricted(refuse_params=True), {})
        # Counting real tokens would download a tokenizer; the tests do not depend on the count.
        monkeypatch.setattr(chat, 'getTokens', lambda value: len(value) // 4)
        return _Node(chat, view)

    return build, warnings


def _ask(chat: _Node, call: str, params=None, **kwargs) -> str:
    """Send one question through the LangChain client with the call's values bound, by `invoke` or by `stream`."""
    with chat.calling(params):
        llm = chat.driver.bound_llm()
        if call == 'invoke':
            return llm.invoke('hi', **kwargs).content
        return ''.join(chunk.content for chunk in llm.stream('hi', **kwargs))


def _chat_string(chat: _Node, **kwargs) -> str:
    """Ask through the shared chat layer (ChatBase.chat_string), inside the call, as LLMBase does."""
    with chat.calling():
        return chat.driver.chat_string('hi', **kwargs)


def _dropped(chat: _Node) -> set:
    """The models whose requests the client now sends without a temperature."""
    return set(chat.llm._refused_temperature)


# --- what is sent ---


def test_zero_is_sent_when_the_node_sets_nothing(node, endpoint):
    build, _warnings = node
    _url, bodies = endpoint

    assert _ask(build(), 'invoke') == 'ok'

    assert [b['temperature'] for b in bodies] == [0]


def test_the_configured_value_is_sent(node, endpoint):
    build, _warnings = node
    _url, bodies = endpoint

    _ask(build(temperature=0.7), 'invoke')

    assert [b['temperature'] for b in bodies] == [0.7]


def test_an_explicit_zero_is_sent_as_zero(node, endpoint):
    """Pins the `'temperature' in settings` check: a falsy check would treat 0 as absent."""
    build, _warnings = node
    _url, bodies = endpoint

    _ask(build(temperature=0), 'invoke')

    assert [b['temperature'] for b in bodies] == [0]


def test_a_calls_own_value_is_sent_on_the_same_client(node, endpoint):
    """The temperature is a per-call parameter: each call's value goes out, and the client is not rebuilt."""
    build, _warnings = node
    _url, bodies = endpoint
    chat = build(temperature=0.7)
    llm = chat.llm

    _ask(chat, 'invoke', params={'temperature': 1.3})
    _ask(chat, 'invoke')

    assert [b['temperature'] for b in bodies] == [1.3, 0.7]
    assert chat.llm is llm


def test_the_nebius_preset_sends_zero_and_recovers_the_same_way(node, endpoint):
    """The preset declares no Temperature field: it sends 0, and a refusal of it is handled as for the generic node."""
    build, warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = OPENAI
    chat = build(logical_type=_NEBIUS, stored={'model': 'meta-llama/Llama-3.3-70B-Instruct'})

    assert _ask(chat, 'invoke') == 'ok'

    assert len(bodies) == 2
    assert bodies[0]['temperature'] == 0 and 'temperature' not in bodies[1]
    assert len(warnings) == 1


# --- the endpoint rejects the temperature ---


@pytest.mark.parametrize('call', ['invoke', 'stream'])
@pytest.mark.parametrize('rejection', TEMPERATURE_REJECTIONS)
def test_a_rejected_temperature_is_dropped_and_the_request_is_sent_again(node, endpoint, rejection, call):
    build, warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = rejection
    chat = build()

    assert _ask(chat, call) == 'ok'

    assert len(bodies) == 2
    assert bodies[0]['temperature'] == 0
    assert 'temperature' not in bodies[1]
    # Everything else about the request is unchanged.
    assert {k: v for k, v in bodies[0].items() if k != 'temperature'} == bodies[1]
    assert len(warnings) == 1 and 'temperature=0' in warnings[0]


@pytest.mark.parametrize('call', ['invoke', 'stream'])
def test_later_requests_in_the_run_leave_the_temperature_out(node, endpoint, call):
    build, warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = ANTHROPIC
    chat = build()

    _ask(chat, call)
    assert _ask(chat, call) == 'ok'

    assert len(bodies) == 3
    assert 'temperature' not in bodies[2]
    assert len(warnings) == 1


def test_a_value_the_node_set_is_dropped_the_same_way(node, endpoint):
    build, warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = OPENAI

    assert _ask(build(temperature=0.7), 'invoke') == 'ok'

    assert bodies[0]['temperature'] == 0.7 and 'temperature' not in bodies[1]
    assert 'temperature=0.7' in warnings[0]


def test_the_warning_leaves_out_what_the_endpoint_wrote(node, endpoint):
    """Some endpoints copy the request, prompt included, into the refusal. None of that text reaches the warning."""
    build, warnings = node
    _Endpoint.rejection = (
        400,
        {
            'error': {
                'message': "Unsupported parameters: {'temperature': 0}. Request: {'model': 'deployment', "
                "'messages': [{'role': 'user', 'content': 'PROMPT-TEXT'}], 'temperature': 0}",
                'type': 'invalid_request_error',
                'param': None,
                'code': '400',
            }
        },
    )
    chat = build()

    assert _ask(chat, 'invoke') == 'ok'

    assert len(warnings) == 1
    assert 'PROMPT-TEXT' not in warnings[0] and 'Unsupported parameters' not in warnings[0]
    assert 'temperature=0' in warnings[0] and 'HTTP 400' in warnings[0]
    # The call's model, not the placeholder the client is built with
    assert warnings[0].startswith('any-model:')


def test_a_model_with_tools_bound_recovers_too(node, endpoint):
    """A turn with tools runs on a binding of the same client."""
    build, _warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = LITELLM
    tool = {'type': 'function', 'function': {'name': 'lookup', 'description': 'Look up.', 'parameters': {}}}
    chat = build()

    with chat.calling():
        # Bound as ChatBase.chat_turn binds them: the tools first, then the call's values
        llm = chat.llm.bind_tools([tool]).bind(**chat.driver.turn_kwargs())
        assert llm.invoke('hi').content == 'ok'

    assert len(bodies) == 2
    assert 'temperature' not in bodies[1] and bodies[1]['tools'] == bodies[0]['tools']


def test_two_requests_refused_at_once_both_recover_and_one_warns(node, endpoint):
    """One client serves every pipeline thread of a run."""
    build, warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = ANTHROPIC
    _Endpoint.barrier = threading.Barrier(2)
    chat = build()
    answers: list = []

    threads = [threading.Thread(target=lambda: answers.append(_ask(chat, 'invoke'))) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert answers == ['ok', 'ok']
    assert sum('temperature' in b for b in bodies) == 2 and len(bodies) == 4
    assert len(warnings) == 1


def test_another_model_on_the_same_client_keeps_its_temperature(node, endpoint):
    """One client serves every model a call names: only the model whose endpoint refused the temperature loses it."""
    build, warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = OPENAI
    _Endpoint.refusing_models = {'refusing-model'}
    chat = build(model='refusing-model')

    assert _ask(chat, 'invoke') == 'ok'
    assert _ask(chat, 'invoke', params={'model': 'other-model'}) == 'ok'
    assert _ask(chat, 'invoke') == 'ok'

    assert [(b['model'], 'temperature' in b) for b in bodies] == [
        ('refusing-model', True),
        ('refusing-model', False),
        ('other-model', True),
        ('refusing-model', False),
    ]
    assert _dropped(chat) == {'refusing-model'}
    assert len(warnings) == 1


# --- the endpoint refuses the request for another reason ---


@pytest.mark.parametrize('call', ['invoke', 'stream'])
@pytest.mark.parametrize('rejection', OTHER_REJECTIONS)
def test_another_refusal_is_raised_without_a_second_request(node, endpoint, rejection, call):
    build, warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = rejection
    _Endpoint.reject_always = True
    chat = build()

    with pytest.raises(openai.APIStatusError) as raised:
        _ask(chat, call)

    assert raised.value.status_code == rejection[0]
    assert len(bodies) == 1
    assert _dropped(chat) == set()
    assert warnings == []


@pytest.mark.parametrize('call', ['invoke', 'stream'])
@pytest.mark.parametrize(
    'rejection',
    [pytest.param(ANTHROPIC, id='names-the-temperature'), pytest.param(MESSAGE_COPY, id='copies-the-request')],
)
def test_a_refusal_repeated_without_the_temperature_is_raised_and_changes_nothing(node, endpoint, rejection, call):
    """The temperature was not the reason, so the client keeps sending it and says nothing about it."""
    build, warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = rejection
    _Endpoint.reject_always = True
    chat = build()

    with pytest.raises(openai.BadRequestError):
        _ask(chat, call)

    assert len(bodies) == 2 and 'temperature' not in bodies[1]
    assert _dropped(chat) == set()
    assert warnings == []


@pytest.mark.parametrize('call', ['invoke', 'stream'])
def test_a_second_request_refused_for_another_reason_raises_that_refusal(node, endpoint, call):
    """What is raised is what the endpoint still refuses once the temperature is gone, not the first refusal."""
    build, warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = OPENAI
    _Endpoint.stop_rejection = STOP_REJECTION
    chat = build()

    with pytest.raises(openai.BadRequestError) as raised:
        _ask(chat, call, stop=['END'])

    assert raised.value.param == 'stop'
    assert len(bodies) == 2 and 'temperature' not in bodies[1]
    assert _dropped(chat) == set()
    assert warnings == []


@pytest.mark.parametrize('call', ['invoke', 'stream'])
def test_once_the_temperature_is_gone_a_refusal_that_names_it_is_not_retried(node, endpoint, call):
    """Only a request that carried a temperature is sent again."""
    build, warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = ANTHROPIC
    chat = build()
    _ask(chat, call)
    assert _dropped(chat) == {'any-model'} and len(bodies) == 2

    _Endpoint.reject_always = True
    with pytest.raises(openai.BadRequestError):
        _ask(chat, call)

    assert len(bodies) == 3
    assert len(warnings) == 1


# --- through the shared chat layer ---


def test_a_streamed_chat_answers_and_is_still_metered(node, endpoint):
    """The shared layer never sees the refusal, so it neither gives up usage reporting nor falls back."""
    build, _warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = ANTHROPIC
    chunks: list = []

    assert _chat_string(build(), on_chunk=chunks.append) == 'ok'

    assert ''.join(chunks) == 'ok'
    assert len(bodies) == 2
    assert all(b['stream'] is True and b['stream_options'] == {'include_usage': True} for b in bodies)
    assert 'temperature' not in bodies[1]


def test_a_proxy_that_also_refuses_streaming_usage_still_answers(node, endpoint):
    """The node's retry and the shared layer's own retry without usage each handle their part."""
    build, _warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = OPENAI
    _Endpoint.usage_rejection = USAGE_REJECTION
    chat = build()

    assert _chat_string(chat, on_chunk=lambda text: None) == 'ok'

    sent = [sorted(k for k in ('stream_options', 'temperature') if k in b) for b in bodies]
    assert sent == [['stream_options', 'temperature'], ['stream_options'], ['temperature'], []]
    assert _dropped(chat) == {'any-model'}


@pytest.mark.parametrize('streamed', [True, False], ids=['streamed', 'not-streamed'])
def test_a_model_that_also_refuses_stop_sequences_still_answers(node, endpoint, streamed):
    """The shared layer drops `stop` only when it is handed the refusal that names it, so the node raises that one."""
    build, _warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = OPENAI
    _Endpoint.stop_rejection = STOP_REJECTION
    chat = build()
    on_chunk = (lambda text: None) if streamed else None

    active = STOP_SEQUENCES_VAR.set(['END'])
    try:
        assert _chat_string(chat, on_chunk=on_chunk) == 'ok'
    finally:
        STOP_SEQUENCES_VAR.reset(active)

    sent = [sorted(k for k in ('stop', 'temperature') if k in b) for b in bodies]
    assert sent == [['stop', 'temperature'], ['stop'], ['temperature'], []]
    assert _dropped(chat) == {'any-model'}


def test_a_chat_that_does_not_stream_answers(node, endpoint):
    build, _warnings = node
    _url, bodies = endpoint
    _Endpoint.rejection = OPENAI

    assert _chat_string(build()) == 'ok'

    assert len(bodies) == 2 and 'temperature' not in bodies[1]


def test_generate_still_takes_the_run_manager(node):
    """langchain-core passes `run_manager` to `_generate` only when its signature names it."""
    build, _warnings = node

    assert 'run_manager' in inspect.signature(build().llm._generate).parameters


def test_the_client_keeps_the_class_name_turns_are_tagged_with(node):
    """Reasoning state is replayed only to the model class name that wrote it (llm_tools.model_origin)."""
    build, _warnings = node

    assert model_origin(build().llm) == 'ChatOpenAI'
