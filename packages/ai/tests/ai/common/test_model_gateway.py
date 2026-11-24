# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Hosted OpenAI models for a node with no key.

The pass and the key choice, the keyless check, the sentences a user reads, the two
OpenAI nodes on a stand-in backend (the openai SDK and langchain-openai build every
request; only the network is replaced), the run's limits, the task's pass from issue to
revoke, the MCP tools, and the account's defaults. The sentences are written out here in
full, not imported, so a change to what a user reads has to change this file too.
"""

import asyncio
import copy
import importlib.util
import inspect
import json
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

pytest.importorskip('langchain_openai')
openai = pytest.importorskip('openai')
import httpx  # noqa: E402

import ai.common.config as config_module  # noqa: E402
from ai.common import model_gateway  # noqa: E402
from ai.common.config import Config  # noqa: E402
from ai.common.model_gateway import (  # noqa: E402
    GATEWAY_ENV,
    HostedModelError,
    MissingModelKeyError,
    friendly_gateway_error,
    hosted_engine,
    missing_key_message,
    read_pass,
    resolve_openai_credentials,
    wants_hosted_openai,
)
from ai.common.schema import Question, UserMessage  # noqa: E402
from ai.modules.mcp import credentials as creds  # noqa: E402
from ai.modules.mcp.tooling import ToolRegistry  # noqa: E402
from ai.modules.mcp.tools import capability, integrations, introspection  # noqa: E402
from ai.modules.task.task_engine import TASK_STATE, Task, filter_subprocess_env  # noqa: E402

from ..modules.mcp.conftest import FakeEngineClient  # noqa: E402
from ..modules.task.test_task_engine import _ending_task, _env_task, _LaunchStop, _startable_task  # noqa: E402

NODES = Path(__file__).resolve().parents[5] / 'nodes' / 'src' / 'nodes'
BASE_URL = 'http://127.0.0.1:41873/gateway/openai/v1'
TOKEN = 'rrmg_' + 'a' * 43
NEBIUS_URL = 'https://api.tokenfactory.nebius.com/v1/'

_KEY_HOW = (
    'To keep the key out of the pipeline, save it in RocketRide under Settings > Environment Variables as '
    "ROCKETRIDE_OPENAI_KEY and enter ${ROCKETRIDE_OPENAI_KEY} as the node's API key."
)
NO_KEY_HOSTED = (
    "llm_openai: no API key is set, and RocketRide-hosted models aren't available for this run. "
    f'Add your OpenAI key in the node settings. {_KEY_HOW}'
)
NO_KEY_SELF_HOSTED = f'llm_openai: no API key is set. Add your OpenAI key in the node settings. {_KEY_HOW}'
NO_KEY_OWN_ENDPOINT = 'llm_openai_api: no API key is set. Add the API key for your endpoint in the node settings.'
TEAM = "Hosted models aren't available for team deployments yet. Add your own OpenAI key to the node."
UNAVAILABLE = (
    'RocketRide-hosted models are unavailable right now. Try again shortly, or add your own OpenAI key '
    'in the node settings.'
)
OTHER = (
    "RocketRide-hosted models couldn't run this request. Try again shortly, or add your own OpenAI key in the "
    'node settings.'
)
SENTENCES = {
    'insufficient_credits': (
        "This workspace doesn't have enough compute credits left for this request on RocketRide-hosted models. "
        'Add your own OpenAI key in the node settings. A workspace admin can also manage compute credits '
        'under Account > Billing in RocketRide.'
    ),
    'spend_limit_reached': (
        "This request would go over this workspace's rolling 24-hour usage limit for RocketRide-hosted models. "
        'Try again later, or add your own OpenAI key in the node settings.'
    ),
    'rate_limited': (
        'This run has too many requests running at once on RocketRide-hosted models. '
        'Try again with fewer requests at once, or add your own OpenAI key in the node settings.'
    ),
    'model_not_available': (
        "The model gpt-4o isn't offered as a RocketRide-hosted model. Choose another model in the node "
        'settings, or add your own OpenAI key there.'
    ),
    'invalid_gateway_pass': "This run's access to RocketRide-hosted models has ended. Start the pipeline again.",
    'gateway_unavailable': UNAVAILABLE,
    'upstream_unavailable': UNAVAILABLE,
    'request_too_large': (
        'This request is too large for RocketRide-hosted models. Shorten the input, or add your own OpenAI key '
        'in the node settings.'
    ),
    'unsupported_parameter': (
        "RocketRide-hosted models don't support stored responses. "
        'Add your own OpenAI key in the node settings to run this request.'
    ),
    'invalid_request': (
        "RocketRide-hosted models couldn't accept this request. Check the node settings, then run the pipeline again."
    ),
    'team_deployment_not_supported': TEAM,
    'something_new': OTHER,
}
STATUS = {'rate_limited': 429, 'gateway_unavailable': 503, 'upstream_unavailable': 503, 'insufficient_credits': 402}


def _pass(**overrides):
    value = {'provider': 'openai', 'base_url': BASE_URL, 'token': TOKEN, 'expires_at': int(time.time()) + 86400}
    value.update(overrides)
    return value


def _env(value):
    return {GATEWAY_ENV: value if isinstance(value, str) else json.dumps(value)}


@pytest.fixture(autouse=True)
def fresh_gate(monkeypatch):
    """Each test starts with no run gate, as a new task process would."""
    monkeypatch.setattr(model_gateway, '_gate', None)


@pytest.fixture
def hosted(monkeypatch):
    """This process is a task of a hosted engine, with a key in its environment that must never be used."""
    monkeypatch.setattr(sys, 'argv', [*sys.argv, '--hosted'])
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-canary-environment')


@pytest.fixture
def self_hosted(monkeypatch):
    monkeypatch.setattr(sys, 'argv', [a for a in sys.argv if a not in ('--hosted', '--saas')])


def _with_pass(monkeypatch, **overrides):
    monkeypatch.setenv(GATEWAY_ENV, json.dumps(_pass(**overrides)))


# ---------------------------------------------------------------------------
# The pass
# ---------------------------------------------------------------------------


def test_read_pass_returns_the_pass_and_the_run_limits():
    gateway = read_pass(_env(_pass(max_concurrent_calls=2, max_output_tokens=16384)))
    assert (gateway.base_url, gateway.token, gateway.max_concurrent_calls, gateway.max_output_tokens) == (
        BASE_URL,
        TOKEN,
        2,
        16384,
    )
    assert TOKEN not in repr(gateway)


@pytest.mark.parametrize(
    'limits', [{}, {'max_concurrent_calls': 0, 'max_output_tokens': -1}, {'max_concurrent_calls': '4'}]
)
def test_limits_that_are_missing_or_not_positive_whole_numbers_take_the_defaults(limits):
    gateway = read_pass(_env(_pass(**limits)))
    assert (gateway.max_concurrent_calls, gateway.max_output_tokens) == (4, None)


def test_a_past_expiry_is_left_to_the_backend():
    """The engine renews the pass with the backend; the copy in the task's environment keeps its first expiry."""
    assert read_pass(_env(_pass(expires_at=1))) is not None


@pytest.mark.parametrize(
    'raw',
    [
        '',
        'not json',
        json.dumps(['a list']),
        json.dumps(_pass(provider='anthropic')),
        json.dumps(_pass(token='')),
        json.dumps(_pass(token='rrmg_ space')),
        json.dumps(_pass(expires_at='soon')),
        json.dumps(_pass(expires_at=True)),
        json.dumps({'error': {'type': 'rocketride_gateway_error', 'code': 'team_deployment_not_supported'}}),
    ]
    + [
        json.dumps(_pass(base_url=url))
        for url in (
            'https://127.0.0.1:41873/v1',
            'http://localhost:41873/v1',
            'http://10.0.0.5:41873/v1',
            'http://127.0.0.1/v1',
            'http://user:pw@127.0.0.1:41873/v1',
            'http://127.0.0.1:41873/v1?to=elsewhere',
            ' http://127.0.0.1:41873/v1',
        )
    ],
)
def test_read_pass_refuses_anything_but_a_pass_to_loopback(raw):
    assert read_pass({GATEWAY_ENV: raw}) is None


# ---------------------------------------------------------------------------
# The key a node builds its clients with
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('where', ['hosted', 'self_hosted'])
def test_a_key_of_its_own_wins(request, monkeypatch, where):
    request.getfixturevalue(where)
    _with_pass(monkeypatch)
    assert resolve_openai_credentials('llm_openai', 'sk-user') == ('sk-user', '', False, None)


def test_a_hosted_task_with_no_key_uses_the_pass(hosted, monkeypatch):
    _with_pass(monkeypatch, max_output_tokens=1000)
    credentials = resolve_openai_credentials('llm_openai', '  ')
    assert (credentials.apikey, credentials.base_url, credentials.hosted) == (TOKEN, BASE_URL, True)
    assert credentials.gateway.max_output_tokens == 1000


@pytest.mark.parametrize(
    'node, base_url, with_pass, message',
    [
        ('llm_openai', '', False, NO_KEY_HOSTED),
        ('llm_openai_api', 'https://my.endpoint/v1', True, NO_KEY_OWN_ENDPOINT),
        ('llm_openai_api', 'https://my.endpoint/v1', False, NO_KEY_OWN_ENDPOINT),
    ],
)
def test_a_hosted_task_with_nothing_to_use_says_why(hosted, monkeypatch, node, base_url, with_pass, message):
    monkeypatch.delenv(GATEWAY_ENV, raising=False)
    if with_pass:
        _with_pass(monkeypatch)
    with pytest.raises(MissingModelKeyError) as raised:
        resolve_openai_credentials(node, '', base_url)
    assert str(raised.value) == message.replace('llm_openai:', f'{node}:', 1)


def test_a_team_deployment_with_no_key_says_hosted_models_dont_cover_it(hosted, monkeypatch):
    """The backend refused the run a pass for a team deployment, and the engine passed its code on."""
    refusal = {'error': {'type': 'rocketride_gateway_error', 'code': 'team_deployment_not_supported'}}
    monkeypatch.setenv(GATEWAY_ENV, json.dumps(refusal))
    with pytest.raises(MissingModelKeyError, match=f'^{TEAM}$'):
        resolve_openai_credentials('llm_openai', '')


@pytest.mark.parametrize('where', ['hosted', 'self_hosted'])
@pytest.mark.parametrize('with_pass', [True, False])
def test_a_nebius_node_keeps_its_own_settings(request, monkeypatch, where, with_pass):
    """llm_nebius runs on the compatible driver, but never on the pass and never with an OpenAI message."""
    request.getfixturevalue(where)
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.delenv(GATEWAY_ENV, raising=False)
    if with_pass:
        _with_pass(monkeypatch)
    assert resolve_openai_credentials('llm_nebius', '', NEBIUS_URL) == ('', NEBIUS_URL, False, None)


def test_a_self_hosted_engine_never_uses_a_pass(self_hosted, monkeypatch):
    _with_pass(monkeypatch)
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    with pytest.raises(MissingModelKeyError, match='^llm_openai: no API key is set. Add your'):
        resolve_openai_credentials('llm_openai', '')
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-env')
    assert resolve_openai_credentials('llm_openai', '') == ('', '', False, None)
    assert resolve_openai_credentials('llm_openai_api', '') == ('', '', False, None)


def test_the_save_time_check_speaks_only_on_a_self_hosted_engine_with_no_key(monkeypatch, self_hosted):
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    assert hosted_engine() is False
    assert missing_key_message('llm_openai') == NO_KEY_SELF_HOSTED
    assert missing_key_message('llm_openai_api') is None
    monkeypatch.setattr(sys, 'argv', [*sys.argv, '--saas'])
    assert hosted_engine() is True
    assert missing_key_message('llm_openai') is None


# ---------------------------------------------------------------------------
# The keyless check the engine runs at start
# ---------------------------------------------------------------------------

_SERVICES = {
    'llm_openai': {
        'preconfig': {
            'default': 'openai-5-2',
            'profiles': {
                'openai-5-2': {'model': 'gpt-5.2', 'apikey': ''},
                'openai-4o-mini': {'model': 'gpt-4o-mini', 'apikey': ''},
                'keyed-default': {'model': 'gpt-4o-mini', 'apikey': 'sk-from-profile-defaults'},
            },
        }
    },
    'llm_openai_api': {
        'preconfig': {'default': 'custom', 'profiles': {'custom': {'model': '', 'base_url': '', 'apikey': ''}}}
    },
}


@pytest.fixture
def decoder(monkeypatch):
    """Serve the nodes' profiles to Config.getNodeConfig and stand in for the secure
    parameter decoder, which edits its argument in place.
    """
    monkeypatch.setattr(config_module, 'getServiceDefinition', lambda name: copy.deepcopy(_SERVICES.get(name)))

    def resolve(pipeline):
        for component in pipeline.get('components') or []:
            for block in (component.get('config') or {}).values():
                if isinstance(block, dict) and 'secureParameters' in block:
                    block.update(json.loads(block.pop('secureParameters')['token']))
        return pipeline

    monkeypatch.setattr(sys.modules['rocketlib'], 'resolveSecureParameters', resolve, raising=False)


def _node(provider='llm_openai', config=None, id='llm_1'):
    return {'id': id, 'provider': provider, 'config': {} if config is None else config}


def _pipe(*components):
    return {'source': 'chat_1', 'components': [{'id': 'chat_1', 'provider': 'chat', 'config': {}}, *components]}


def _group(*components):
    return {'id': 'group_1', 'provider': 'group', 'config': {'pipeline': {'components': list(components)}}}


def _secure(values):
    return {'secureParameters': {'token': json.dumps(values)}}


@pytest.mark.parametrize(
    'pipeline, wants',
    [
        (_pipe(_node()), True),
        (_pipe(_node(config={'profile': 'openai-4o-mini'})), True),
        (_pipe(_node(config={'apikey': 'sk-top-level'})), False),
        (_pipe(_node(config={'profile': 'openai-4o-mini', 'openai-4o-mini': {'apikey': 'sk-block'}})), False),
        (_pipe(_node(config={'profile': 'keyed-default'})), False),
        (_pipe(_node(config={'apikey': '${ROCKETRIDE_OPENAI_KEY}'})), False),
        (_pipe(_node(config={'openai-5-2': _secure({'apikey': 'sk-secure'})})), False),
        (_pipe(_node(config={'openai-5-2': _secure({'apikey': ''})})), True),
        (_pipe(_node('llm_openai_api')), True),
        (_pipe(_node('llm_openai_api', {'custom': {'base_url': 'https://my.endpoint/v1'}})), False),
        (_pipe(_node('llm_nebius')), False),
        (_pipe(_node(config={'apikey': 'sk'}), _node(id='llm_2')), True),
        (_pipe(_group(_group(_node()))), True),
        (_pipe(_node(config={'profile': 'no-such-profile'})), False),
        (_pipe(_node(config='not a dict')), False),
        ('not a pipeline', False),
    ],
)
def test_the_engine_asks_for_a_pass_only_for_a_keyless_openai_node(decoder, pipeline, wants):
    original = copy.deepcopy(pipeline)
    assert wants_hosted_openai(pipeline) is wants
    assert pipeline == original


def test_groups_are_followed_to_a_depth_of_8(decoder):
    inner = _node()
    for _ in range(7):
        inner = _group(inner)
    assert wants_hosted_openai(_pipe(inner)) is True
    assert wants_hosted_openai(_pipe(_group(inner))) is False


def test_a_node_the_engine_serves_but_has_not_unpacked_is_read_from_its_served_definition(decoder, monkeypatch):
    monkeypatch.setattr(config_module, 'getServiceDefinition', lambda name: None)
    served = {'llm_openai': copy.deepcopy(_SERVICES['llm_openai'])}

    assert wants_hosted_openai(_pipe(_node()), served.get) is True
    assert wants_hosted_openai(_pipe(_node())) is False


def test_a_failed_decode_asks_for_no_pass(monkeypatch):
    def broken(_pipeline):
        raise RuntimeError('cannot decode')

    monkeypatch.setattr(sys.modules['rocketlib'], 'resolveSecureParameters', broken, raising=False)
    assert wants_hosted_openai(_pipe(_node())) is False


def test_the_module_imports_nothing_heavy():
    """The task engine imports this module in the server process at load."""
    head = open(model_gateway.__file__, encoding='utf-8').read().split('\ndef ', 1)[0]
    assert 'import ai.' not in head and 'from ai.' not in head and 'import httpx' not in head


# ---------------------------------------------------------------------------
# The sentences
# ---------------------------------------------------------------------------


def _refusal(code, message='', *, param=None):
    request = httpx.Request('POST', f'{BASE_URL}/responses')
    body = {'error': {'message': message or f'refused: {code}', 'type': 'rocketride_gateway_error', 'code': code}}
    if param:
        body['error']['param'] = param
    response = httpx.Response(STATUS.get(code, 400), request=request, json=body)
    return openai.APIStatusError(body['error']['message'], response=response, body=body['error'])


@pytest.mark.parametrize('code', sorted(SENTENCES))
def test_each_refusal_reads_as_its_sentence(code):
    message = "RocketRide-hosted models don't support stored responses. Add your own OpenAI key in the node settings"
    error = _refusal(code, message if code == 'unsupported_parameter' else '', param='previous_response_id')
    assert friendly_gateway_error(error, 'gpt-4o') == SENTENCES[code]
    assert '*' not in SENTENCES[code]


def test_the_names_in_a_sentence_come_from_plain_words_only():
    assert 'previous_response_id' not in friendly_gateway_error(_refusal('unsupported_parameter', param='x'))
    assert 'a feature this request uses' in friendly_gateway_error(_refusal('unsupported_parameter'))
    from_backend = _refusal('model_not_available', "The model gpt-4.5 isn't offered as a RocketRide-hosted model.")
    assert friendly_gateway_error(from_backend).startswith('The model gpt-4.5 ')


def test_other_errors_have_no_sentence():
    response = httpx.Response(400, request=httpx.Request('POST', BASE_URL), json={'error': {'type': 'x'}})
    assert friendly_gateway_error(openai.BadRequestError('x', response=response, body={'type': 'x'})) is None
    assert friendly_gateway_error(ValueError('x')) is None


# ---------------------------------------------------------------------------
# The two nodes on a stand-in backend
# ---------------------------------------------------------------------------

PLAIN = {'model': 'gpt-4o-mini', 'apikey': '', 'modelTotalTokens': 128000, 'modelOutputTokens': 4096}
REASONING = {**PLAIN, 'model': 'gpt-5-nano', 'modelOutputTokens': 32768, 'capabilities': {'reasoning': True}}


def _sse(events) -> bytes:
    return ''.join(f'data: {json.dumps(e)}\n\n' for e in events).encode() + b'data: [DONE]\n\n'


def _chunk(delta, finish=None):
    choice = {'index': 0, 'delta': delta, 'finish_reason': finish}
    return {'id': 'c1', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'm', 'choices': [choice]}


def _completion(content='4'):
    message = {'role': 'assistant', 'content': content}
    usage = {'prompt_tokens': 5, 'completion_tokens': 1, 'total_tokens': 6}
    choice = {'index': 0, 'message': message, 'finish_reason': 'stop'}
    return {'id': 'c1', 'object': 'chat.completion', 'created': 1, 'model': 'm', 'choices': [choice], 'usage': usage}


def _response_events(text='4'):
    base = {'id': 'r1', 'object': 'response', 'created_at': 1, 'model': 'm', 'tools': [], 'parallel_tool_calls': True}
    base['tool_choice'] = 'auto'
    output = [{'id': 'm1', 'type': 'message', 'role': 'assistant', 'status': 'completed', 'content': []}]
    if text:
        output[0]['content'] = [{'type': 'output_text', 'text': text, 'annotations': []}]
    usage = {'input_tokens': 5, 'output_tokens': 1, 'total_tokens': 6}
    usage.update({'input_tokens_details': {'cached_tokens': 0}, 'output_tokens_details': {'reasoning_tokens': 0}})
    events = [{'type': 'response.created', 'sequence_number': 0, 'response': {**base, 'status': 'in_progress'}}]
    if text:
        events.append({'type': 'response.output_text.delta', 'sequence_number': 1, 'item_id': 'm1', 'delta': text})
        events[-1].update({'output_index': 0, 'content_index': 0})
    done = {**base, 'status': 'completed', 'output': output if text else [], 'usage': usage}
    events.append({'type': 'response.completed', 'sequence_number': 2, 'response': done})
    return events


def answer(_request, body):
    """A good answer for whatever was asked."""
    if body.get('input') is not None:
        if body.get('stream'):
            return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=_sse(_response_events()))
        return httpx.Response(200, json=_response_events()[-1]['response'])
    if body.get('stream'):
        chunks = [_chunk({'role': 'assistant', 'content': '4'}), _chunk({}, 'stop')]
        return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=_sse(chunks))
    return httpx.Response(200, json=_completion())


def refused(code, *, charged=True):
    def reply(_request, _body):
        headers = {'x-should-retry': 'false'} if charged else {}
        body = {'error': {'message': f'refused: {code}', 'type': 'rocketride_gateway_error', 'code': code}}
        return httpx.Response(STATUS.get(code, 400), headers=headers, json=body)

    return reply


class _Cut(httpx.SyncByteStream):
    def __iter__(self):
        yield f'data: {json.dumps(_chunk({"role": "assistant"}))}\n\n'.encode()
        raise httpx.RemoteProtocolError('peer closed connection without sending complete message body')


def cut_stream(_request, _body):
    return httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=_Cut())


def responses_without_text(_request, _body):
    return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=_sse(_response_events('')))


class Backend:
    """Records every request and answers from a script; the last entry repeats."""

    def __init__(self, *script):
        self.script, self.requests, self.lock = list(script), [], threading.Lock()

    def __call__(self, request):
        body = json.loads(request.content) if request.content else {}
        with self.lock:
            self.requests.append({'url': str(request.url), 'auth': request.headers.get('authorization'), 'body': body})
            step = self.script[min(len(self.requests), len(self.script)) - 1]
        return step(request, body)


@pytest.fixture
def backend(monkeypatch):
    holder = {}
    monkeypatch.setattr(httpx.HTTPTransport, 'handle_request', lambda self, request: holder['b'](request))

    def install(*script):
        holder['b'] = Backend(*script)
        return holder['b']

    return install


def _driver(monkeypatch, node, config, provider=None):
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    spec = importlib.util.spec_from_file_location(f'_gw_{node}', NODES / node / 'openai_client.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    chat = mod.Chat(provider or node, {}, {})
    chat.getTokens = lambda value: len(value) // 4
    return chat


def _prompt():
    q = Question()
    q.addQuestion('What is 2+2?')
    return q


def _turn():
    return Question(
        role='You are the Rocket agent.',
        tools=[{'name': 'tool_github_1.create_issue', 'description': 'File an issue.'}],
        messages=[UserMessage(content='File an issue about the flaky test.')],
    )


def _ask(chat, question, streamed):
    try:
        if streamed:
            return chat.chat(question, on_chunk=lambda _t: None, on_reasoning_chunk=lambda _t: None), None
        return chat.chat(question), None
    except Exception as e:  # noqa: BLE001 - the test inspects what was raised
        return None, e


# name: (node, config, question)
PATHS = {
    'prompt': ('llm_openai', PLAIN, _prompt),
    'reasoning-prompt': ('llm_openai', REASONING, _prompt),
    'tool-turn': ('llm_openai', PLAIN, _turn),
    'reasoning-tool-turn': ('llm_openai', REASONING, _turn),
    'compatible': ('llm_openai_api', {**PLAIN, 'base_url': ''}, _prompt),
    'compatible-reasoning': ('llm_openai_api', {**REASONING, 'base_url': ''}, _prompt),
}


@pytest.mark.parametrize('streamed', [True, False], ids=['streamed', 'invoked'])
@pytest.mark.parametrize('path', sorted(PATHS))
def test_every_path_answers_on_the_pass(monkeypatch, backend, hosted, path, streamed):
    _with_pass(monkeypatch)
    node, config, question = PATHS[path]
    gateway = backend(answer)

    result, error = _ask(_driver(monkeypatch, node, config), question(), streamed)

    assert error is None, repr(error)
    assert gateway.requests and all(r['url'].startswith(BASE_URL) for r in gateway.requests)
    assert {r['auth'] for r in gateway.requests} == {f'Bearer {TOKEN}'}


@pytest.mark.parametrize('streamed', [True, False], ids=['streamed', 'invoked'])
@pytest.mark.parametrize('path', sorted(PATHS))
@pytest.mark.parametrize('code', ['insufficient_credits', 'rate_limited', 'upstream_unavailable'])
def test_a_refusal_ends_the_call_after_one_request_with_its_sentence(
    monkeypatch, backend, hosted, code, path, streamed
):
    """No engine retry, no fallback, and no SDK retry of a 429 or 503 (max_retries=0)."""
    _with_pass(monkeypatch)
    node, config, question = PATHS[path]
    gateway = backend(refused(code, charged=code != 'upstream_unavailable'))

    _result, error = _ask(_driver(monkeypatch, node, config), question(), streamed)

    assert isinstance(error, HostedModelError), repr(error)
    assert str(error) == SENTENCES[code]
    assert len(gateway.requests) == 1


@pytest.mark.parametrize(
    'path, failure',
    [
        ('prompt', cut_stream),
        ('tool-turn', cut_stream),
        ('compatible-reasoning', cut_stream),
        ('reasoning-prompt', responses_without_text),
        ('reasoning-prompt', cut_stream),
    ],
)
def test_a_failed_stream_is_not_sent_again(monkeypatch, backend, hosted, path, failure):
    """The backend may have charged the stream already, so the call ends instead of a fallback request."""
    _with_pass(monkeypatch)
    node, config, question = PATHS[path]
    gateway = backend(failure, answer)

    _result, error = _ask(_driver(monkeypatch, node, config), question(), True)

    assert isinstance(error, HostedModelError) and str(error) == OTHER, repr(error)
    assert len(gateway.requests) == 1


def responses_out_of_budget(_request, _body):
    """A Responses stream that ends incomplete, its output budget spent before any text."""
    events = _response_events('')
    events[-1] = {
        'type': 'response.incomplete',
        'sequence_number': 2,
        'response': {
            **events[-1]['response'],
            'status': 'incomplete',
            'incomplete_details': {'reason': 'max_output_tokens'},
        },
    }
    return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=_sse(events))


def test_a_reply_that_ran_out_of_output_budget_says_what_to_change(monkeypatch, backend, hosted):
    _with_pass(monkeypatch)
    gateway = backend(responses_out_of_budget, answer)

    _result, error = _ask(_driver(monkeypatch, 'llm_openai', REASONING), _prompt(), True)

    assert 'Raise modelOutputTokens' in str(error), repr(error)
    assert len(gateway.requests) == 1


@pytest.mark.parametrize('node_limit', [32768, 16384], ids=['lowered', 'already-at-the-limit'])
def test_an_output_budget_at_the_pass_limit_is_not_offered_as_the_fix(monkeypatch, backend, hosted, node_limit):
    _with_pass(monkeypatch, max_output_tokens=16384)
    backend(responses_out_of_budget)

    _result, error = _ask(
        _driver(monkeypatch, 'llm_openai', {**REASONING, 'modelOutputTokens': node_limit}), _prompt(), True
    )

    assert '16384 tokens, the most RocketRide-hosted models allow' in str(error), repr(error)
    assert 'Raise modelOutputTokens' not in str(error)


def temperature_refused_by_the_backend(_request, _body):
    error = {
        'message': 'refused',
        'type': 'rocketride_gateway_error',
        'code': 'unsupported_parameter',
        'param': 'temperature',
    }
    return httpx.Response(400, json={'error': error})


def temperature_refused_by_the_provider(_request, _body):
    """A provider's 400, passed through by the backend: released, not charged."""
    error = {
        'message': "Unsupported value: 'temperature' does not support 0 with this model.",
        'type': 'invalid_request_error',
        'param': 'temperature',
        'code': 'unsupported_value',
    }
    return httpx.Response(400, json={'error': error})


@pytest.mark.parametrize('streamed', [True, False], ids=['streamed', 'invoked'])
def test_a_backend_refusal_that_names_the_temperature_stays_final(monkeypatch, backend, hosted, streamed):
    _with_pass(monkeypatch)
    gateway = backend(temperature_refused_by_the_backend, answer)

    _result, error = _ask(_driver(monkeypatch, 'llm_openai_api', {**PLAIN, 'base_url': ''}), _prompt(), streamed)

    assert isinstance(error, HostedModelError), repr(error)
    assert len(gateway.requests) == 1


@pytest.mark.parametrize('streamed', [True, False], ids=['streamed', 'invoked'])
def test_a_temperature_the_provider_rejects_is_dropped_on_the_pass_too(monkeypatch, backend, hosted, streamed):
    _with_pass(monkeypatch)
    gateway = backend(temperature_refused_by_the_provider, answer)

    result, error = _ask(_driver(monkeypatch, 'llm_openai_api', {**PLAIN, 'base_url': ''}), _prompt(), streamed)

    assert error is None and result is not None, repr(error)
    assert [('temperature' in r['body']) for r in gateway.requests] == [True, False]
    assert {r['auth'] for r in gateway.requests} == {f'Bearer {TOKEN}'}


class _TextThenCut(httpx.SyncByteStream):
    """A Responses stream that shows some text, then loses the connection."""

    def __iter__(self):
        for event in _response_events()[:2]:
            yield f'data: {json.dumps(event)}\n\n'.encode()
        raise httpx.RemoteProtocolError('peer closed connection without sending complete message body')


def test_a_hosted_stream_that_breaks_after_text_ends_with_the_sentence(monkeypatch, backend, hosted):
    _with_pass(monkeypatch)
    stream = lambda _r, _b: httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=_TextThenCut())  # noqa: E731
    gateway = backend(stream, answer)

    _result, error = _ask(_driver(monkeypatch, 'llm_openai', REASONING), _prompt(), True)

    assert isinstance(error, HostedModelError) and str(error) == OTHER, repr(error)
    assert len(gateway.requests) == 1


def empty_stream(_request, _body):
    return httpx.Response(200, headers={'content-type': 'text/event-stream'}, content=b'data: [DONE]\n\n')


def test_a_hosted_turn_whose_stream_ends_empty_is_not_sent_again(monkeypatch, backend, hosted):
    """LangChain raises for a stream with no chunks, so the turn takes the failed-stream path."""
    _with_pass(monkeypatch)
    gateway = backend(empty_stream, answer)

    _result, error = _ask(_driver(monkeypatch, 'llm_openai', PLAIN), _turn(), True)

    assert isinstance(error, HostedModelError) and str(error) == OTHER, repr(error)
    assert len(gateway.requests) == 1


def test_a_keyed_node_still_falls_back_after_a_failed_stream(monkeypatch, backend, hosted):
    gateway = backend(cut_stream, answer)
    result, error = _ask(_driver(monkeypatch, 'llm_openai', {**PLAIN, 'apikey': 'sk-user'}), _prompt(), True)
    assert error is None and result is not None
    assert len(gateway.requests) == 2


@pytest.mark.parametrize('path', ['prompt', 'reasoning-prompt', 'compatible'])
def test_the_output_limit_is_lowered_to_the_pass_limit(monkeypatch, backend, hosted, path):
    _with_pass(monkeypatch, max_output_tokens=1000)
    node, config, question = PATHS[path]
    gateway = backend(answer)

    _ask(_driver(monkeypatch, node, config), question(), False)

    body = gateway.requests[0]['body']
    assert (body.get('max_tokens') or body.get('max_completion_tokens') or body.get('max_output_tokens')) == 1000


def test_a_lower_node_limit_is_kept(monkeypatch, backend, hosted):
    _with_pass(monkeypatch, max_output_tokens=16384)
    gateway = backend(answer)
    _ask(_driver(monkeypatch, 'llm_openai', PLAIN), _prompt(), False)
    body = gateway.requests[0]['body']
    assert (body.get('max_tokens') or body.get('max_completion_tokens')) == 4096


def test_close_closes_the_pass_clients(monkeypatch, hosted):
    _with_pass(monkeypatch)
    chat = _driver(monkeypatch, 'llm_openai', REASONING)
    sync = chat._http_clients['http_client']
    assert not sync._trust_env
    chat.close()
    assert sync.is_closed and chat._http_clients == {}


# ---------------------------------------------------------------------------
# The run's limits: one slot per call, and a busy answer tried again
# ---------------------------------------------------------------------------


def test_a_batch_never_has_more_calls_open_than_the_pass_allows(monkeypatch, backend, hosted):
    _with_pass(monkeypatch, max_concurrent_calls=2)
    state = {'open': 0, 'most': 0}
    lock = threading.Lock()

    def slow(request, body):
        with lock:
            state['open'] += 1
            state['most'] = max(state['most'], state['open'])
        time.sleep(0.1)
        with lock:
            state['open'] -= 1
        return answer(request, body)

    gateway = backend(slow)
    chat = _driver(monkeypatch, 'llm_openai', PLAIN)
    results = []
    threads = [threading.Thread(target=lambda: results.append(_ask(chat, _prompt(), True))) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert [error for _r, error in results] == [None] * 8
    assert len(gateway.requests) == 8 and state['most'] == 2
    assert model_gateway._gate._value == 2


def test_a_busy_answer_the_backend_did_not_charge_is_tried_again(monkeypatch, backend, hosted):
    monkeypatch.setattr(model_gateway, '_busy_delay', lambda attempt: 0.0)
    _with_pass(monkeypatch)
    gateway = backend(refused('rate_limited', charged=False), refused('rate_limited', charged=False), answer)

    result, error = _ask(_driver(monkeypatch, 'llm_openai', PLAIN), _prompt(), False)

    assert error is None and result is not None
    assert len(gateway.requests) == 3


def test_a_busy_answer_stops_at_the_deadline(monkeypatch, backend, hosted):
    monkeypatch.setattr(model_gateway, 'RATE_LIMIT_DEADLINE_S', 0.0)
    _with_pass(monkeypatch)
    gateway = backend(refused('rate_limited', charged=False))

    _result, error = _ask(_driver(monkeypatch, 'llm_openai', PLAIN), _prompt(), False)

    assert str(error) == SENTENCES['rate_limited'] and len(gateway.requests) == 1
    assert model_gateway._gate._value == 4


class _Open(httpx.SyncByteStream):
    """A streamed body that is still open when the response is handed back."""

    def __init__(self, chunks):
        self.chunks = chunks

    def __iter__(self):
        yield from self.chunks


def test_a_stream_that_fails_in_a_callback_gives_its_slot_back(monkeypatch, backend, hosted):
    _with_pass(monkeypatch, max_concurrent_calls=1)
    chunks = [_chunk({'role': 'assistant', 'content': 'partial'}), _chunk({}, 'stop')]
    body = ''.join(f'data: {json.dumps(c)}\n\n' for c in chunks).encode() + b'data: [DONE]\n\n'
    backend(lambda _r, _b: httpx.Response(200, headers={'content-type': 'text/event-stream'}, stream=_Open([body])))
    chat = _driver(monkeypatch, 'llm_openai_api', {**REASONING, 'base_url': ''})

    def broken(_text):
        raise RuntimeError('the caller failed')

    with pytest.raises(Exception):
        chat.chat(_prompt(), on_chunk=broken)

    assert model_gateway._gate._value == 1


def _transports(limit, deadline_s):
    gate = model_gateway._run_gate(limit)
    sync, async_ = model_gateway._gated_transport_types()
    return gate, sync(gate, deadline_s), async_(gate, deadline_s)


def test_a_busy_retry_never_waits_for_a_slot_past_the_deadline(monkeypatch, backend):
    monkeypatch.setattr(model_gateway, '_busy_delay', lambda attempt: 0.3)
    gateway = backend(refused('rate_limited', charged=False), answer)
    gate, transport, _ = _transports(1, 1.0)
    taken, done = threading.Event(), threading.Event()

    def hold():
        # Waits while the first request holds the slot, then keeps it past the deadline
        gate.acquire()
        taken.set()
        done.wait(10)
        gate.release()

    holder = threading.Thread(target=hold)

    def hold_the_slot_during_the_backoff(request, body):
        holder.start()
        return refused('rate_limited', charged=False)(request, body)

    gateway.script[0] = hold_the_slot_during_the_backoff
    response = transport.handle_request(httpx.Request('POST', f'{BASE_URL}/chat/completions', json={}))
    done.set()
    holder.join(10)

    assert response.status_code == 429 and len(gateway.requests) == 1
    assert taken.is_set() and gate._value == 1


async def test_a_slot_that_comes_after_the_deadline_is_given_back():
    """A busy retry may take a slot only before its deadline, on both paths."""
    gate = model_gateway._run_gate(1)
    gate.acquire()
    late = threading.Timer(0.04, gate.release)
    late.start()

    assert await model_gateway._acquire_async(gate, time.monotonic() + 0.03) is False
    await asyncio.to_thread(late.join, 10)
    assert gate._value == 1
    assert model_gateway._acquire_by(gate, time.monotonic() - 0.01) is False
    assert gate._value == 1


async def test_a_cancelled_async_wait_for_a_slot_keeps_none(monkeypatch):
    gate, _, transport = _transports(1, 600.0)
    gate.acquire()
    waiting = asyncio.create_task(
        transport.handle_async_request(httpx.Request('POST', f'{BASE_URL}/chat/completions', json={}))
    )
    await asyncio.sleep(0.1)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    gate.release()
    await asyncio.sleep(0.2)

    assert gate._value == 1


# ---------------------------------------------------------------------------
# The task's pass, from issue to revoke
# ---------------------------------------------------------------------------


async def _until(check, timeout=10.0):
    """Wait for check() to hold, a few milliseconds at a time, up to timeout."""
    end = time.monotonic() + timeout
    while not check() and time.monotonic() < end:
        await asyncio.sleep(0.01)


TEAM_REFUSAL = {'error': {'type': 'rocketride_gateway_error', 'code': 'team_deployment_not_supported', 'message': TEAM}}


class _Account:
    def __init__(self):
        self.issued, self.revoked, self.renewed = [], [], []
        self.result, self.renew_result = _pass(max_concurrent_calls=4, max_output_tokens=16384), {'expires_at': 1}

    async def issue(self, identity):
        self.issued.append(dict(identity))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    async def revoke(self, run_id):
        self.revoked.append(run_id)

    async def renew(self, run_id):
        self.renewed.append(run_id)
        return self.renew_result


@pytest.fixture
def account(monkeypatch):
    import ai.account
    import ai.modules.task.task_engine as engine

    recorded = _Account()
    monkeypatch.setattr(ai.account.account, 'issue_model_pass', recorded.issue)
    monkeypatch.setattr(ai.account.account, 'revoke_model_pass', recorded.revoke)
    monkeypatch.setattr(ai.account.account, 'renew_model_pass', recorded.renew)
    monkeypatch.setattr(engine, 'startup_args', lambda: ['--saas'])
    monkeypatch.delenv(GATEWAY_ENV, raising=False)
    return recorded


async def test_a_hosted_run_gets_its_pass_and_renews_it_until_it_is_dropped(monkeypatch, account):
    import ai.modules.task.task_engine as engine

    monkeypatch.setattr(engine, 'PASS_RENEW_INTERVAL_S', 0.01)
    t = _env_task()
    t._model_run_id = 'run-1'

    env = await Task._build_subprocess_env(t, ([], False), True, 'run-1')
    await _until(lambda: len(account.renewed) >= 2)
    renewal = t._model_pass_renewal
    await Task._drop_model_pass(t)
    renewed = len(account.renewed)
    await _until(renewal.done)
    await asyncio.sleep(0.05)

    assert json.loads(env[GATEWAY_ENV]) == account.result
    assert account.issued == [
        {
            'org_id': 'org-1',
            'user_id': 'client-env-test',
            'team_id': 'team-1',
            'run_id': 'run-1',
            'task_id': 'task-test',
        }
    ]
    assert renewed >= 2 and set(account.renewed) == {'run-1'} and len(account.renewed) == renewed
    assert renewal.cancelled() and account.revoked == ['run-1'] and t._model_run_id is None


async def test_renewing_stops_when_the_pass_has_ended(monkeypatch, account):
    import ai.modules.task.task_engine as engine

    monkeypatch.setattr(engine, 'PASS_RENEW_INTERVAL_S', 0.01)
    account.renew_result = None
    t = _env_task()
    t._model_run_id = 'run-1'

    await Task._build_subprocess_env(t, ([], False), True, 'run-1')
    await _until(t._model_pass_renewal.done)
    await asyncio.sleep(0.05)

    assert account.renewed == ['run-1'] and t._model_pass_renewal.done()


async def test_a_team_deployment_gets_the_backends_reason_and_no_pass(account):
    account.result = TEAM_REFUSAL
    t = _env_task()
    t._model_run_id = 'run-1'

    env = await Task._build_subprocess_env(t, ([], False), True, 'run-1')
    await Task._drop_model_pass(t)

    marker = json.loads(env[GATEWAY_ENV])
    assert marker == {'error': {'type': 'rocketride_gateway_error', 'code': 'team_deployment_not_supported'}}
    assert read_pass(env) is None
    assert t._model_pass_renewal is None and account.revoked == []


@pytest.mark.parametrize('case', ['self-hosted', 'keyed', 'no pass', 'account raises', 'inherited'])
async def test_no_pass_reaches_the_task(monkeypatch, account, case):
    import ai.modules.task.task_engine as engine

    if case == 'self-hosted':
        monkeypatch.setattr(engine, 'startup_args', lambda: [])
    account.result = {'no pass': None, 'account raises': RuntimeError('backend unreachable')}.get(case, account.result)
    if case == 'inherited':
        monkeypatch.setenv(GATEWAY_ENV, json.dumps(_pass(token='rrmg_inherited')))
        account.result = None
    t = _env_task()

    env = await Task._build_subprocess_env(t, ([], False), case != 'keyed', 'run-1')

    assert GATEWAY_ENV not in env and t._model_pass_renewal is None
    assert 'rrmg_' not in str(t.debug_message.call_args_list)


async def test_the_pass_reaches_the_task_and_the_platform_secrets_do_not(monkeypatch, account):
    for name in (
        'RR_MODEL_GATEWAY_OPENAI_KEY',
        'RR_DB_BROKER_TOKEN',
        'ROCKETRIDE_DB_BROKER_TOKEN',
        'RR_DATACORE_GRANT_KEY',
    ):
        monkeypatch.setenv(name, 'secret-' + name.lower())
    monkeypatch.setenv('RR_SUBPROCESS_ENV', '*')
    t = _env_task()
    t._model_run_id = 'run-1'

    env = await Task._build_subprocess_env(t, ([], False), True, 'run-1')
    await Task._drop_model_pass(t)

    assert json.loads(env[GATEWAY_ENV])['token'] == TOKEN
    assert not any(value.startswith('secret-') for value in env.values())


async def test_an_engine_that_ends_during_the_start_ends_the_pass_and_its_renewal(monkeypatch, account):
    """The engine exits while the start waits on the run log: its _terminated() runs, and the start returns."""
    import ai.account
    import ai.modules.task.task_engine as engine
    from rocketride import TASK_STATUS

    t, _ = _startable_task(monkeypatch)
    del t._build_subprocess_env
    del t._terminated
    t._wants_hosted_openai = MagicMock(return_value=True)
    t._status = TASK_STATUS()
    t._status.state = TASK_STATE.NONE.value
    t._status.name = ''
    t._run_trigger = 'manual'
    t._server = SimpleNamespace(assign_port=MagicMock(return_value=20001), release_port=MagicMock(), _config={})
    t._server.get_task_control = MagicMock(return_value=None)
    t._debug_stdio = t._data_client = t._task_metrics = None
    t._status_update_task = None
    t._final_events_sent = True
    t._forward_task_event = AsyncMock()
    t._process_exit_code = AsyncMock(return_value=1)
    t._status_update_loop = AsyncMock()
    monkeypatch.setattr(engine.asyncio, 'create_subprocess_exec', AsyncMock(return_value=SimpleNamespace(pid=4321)))
    monkeypatch.setattr(Task, 'TaskDbgStdio', MagicMock(return_value=SimpleNamespace(connect=AsyncMock())))
    monkeypatch.setattr(ai.account.Store, 'file_store', MagicMock())
    seen = {}

    async def open_while_the_engine_ends(**_):
        seen['renewal'] = t._model_pass_renewal
        await Task._terminated(t)

    run_log = SimpleNamespace(open=open_while_the_engine_ends, chapter_begin_seq=1)
    monkeypatch.setattr(engine, 'RunLogWriter', MagicMock(return_value=run_log))
    monkeypatch.setattr(engine, 'TaskMetrics', MagicMock())

    await Task.start_task(t)
    await asyncio.sleep(0)

    assert seen['renewal'] is not None and seen['renewal'].cancelled()
    assert account.revoked == [account.issued[0]['run_id']]
    assert t._model_pass_renewal is None and t._model_run_id is None


async def test_a_start_cancelled_before_the_engine_launches_ends_the_pass(monkeypatch, account):
    import ai.modules.task.task_engine as engine

    t, _ = _startable_task(monkeypatch)
    del t._build_subprocess_env
    t._wants_hosted_openai = MagicMock(return_value=True)
    launching = asyncio.Event()

    async def never_launches(*_argv, **_kwargs):
        launching.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(engine.asyncio, 'create_subprocess_exec', never_launches)
    start = asyncio.create_task(Task.start_task(t))
    await launching.wait()
    renewal = t._model_pass_renewal
    start.cancel()
    with pytest.raises(asyncio.CancelledError):
        await start
    await asyncio.sleep(0)

    assert renewal is not None and renewal.cancelled()
    assert account.revoked == [account.issued[0]['run_id']] and t._model_run_id is None


@pytest.mark.parametrize('opt_in', ['*', 'RR_*', 'RR_MODEL_GATEWAY_OPENAI_KEY', 'rr_model_gateway_openai_key'])
def test_the_backend_model_key_never_reaches_a_task(opt_in):
    src = {'RR_SUBPROCESS_ENV': opt_in, 'RR_MODEL_GATEWAY_OPENAI_KEY': 'sk-platform', 'PATH': '/usr/bin'}
    assert 'RR_MODEL_GATEWAY_OPENAI_KEY' not in filter_subprocess_env(src)


async def test_a_start_mints_a_run_id_only_for_a_run_that_wants_a_pass(monkeypatch):
    for wants in (True, False):
        t, _ = _startable_task(monkeypatch)
        t._wants_hosted_openai = MagicMock(return_value=wants)
        with pytest.raises(_LaunchStop):
            await Task.start_task(t)
        _db, asked, run_id = t._build_subprocess_env.await_args.args
        assert asked is wants and (len(run_id) == 36) is wants and t._model_run_id == (run_id or None)


async def test_every_end_of_a_run_revokes_its_pass_once(monkeypatch, account):
    """The end of a run (twice), a restart, and a start that fails after the pass was issued."""
    ended = _ending_task(0)
    ended._model_run_id = 'run-ended'
    await Task._terminated(ended)
    await Task._terminated(ended)
    assert account.revoked == ['run-ended']

    account.revoked.clear()
    t, _ = _startable_task(monkeypatch)
    del t._build_subprocess_env
    t._wants_hosted_openai = MagicMock(return_value=True)
    with pytest.raises(_LaunchStop):
        await Task.start_task(t)
    first = t._model_run_id
    t._status.state = TASK_STATE.NONE.value
    with pytest.raises(_LaunchStop):
        await Task.start_task(t)
    assert account.revoked == [first] and t._model_run_id not in (None, first)
    await Task._drop_model_pass(t)
    assert [i['run_id'] for i in account.issued] == account.revoked


# ---------------------------------------------------------------------------
# What a turn and a text answer carry
# ---------------------------------------------------------------------------


def test_the_sentence_reaches_a_turn_and_a_text_answer():
    from .test_native_tools import _node as _llm_node
    from .test_native_tools import _turn as _native_turn

    class _Refused:
        supports_tools = True

        def chat(self, question, on_chunk=None, on_finish=None, on_reasoning_chunk=None):
            raise HostedModelError(SENTENCES['rate_limited'])

    node = _llm_node(_Refused())
    node.writeQuestions(_native_turn())
    node.writeQuestions(_prompt())

    turn_answer, text_answer = node.instance.written
    assert (turn_answer.error.code, turn_answer.error.message) == ('provider_error', SENTENCES['rate_limited'])
    assert text_answer.getText() == f'**LLM error** — {SENTENCES["rate_limited"]}'


# ---------------------------------------------------------------------------
# The MCP tools
# ---------------------------------------------------------------------------


TAG = 'hosted-models:openai'
NOTE = (
    "Runs on RocketRide-hosted models without a key of your own, using this workspace's compute credits. "
    'Not for team deployments: a pipeline deployed to a team needs its own key. Otherwise leave apikey empty. '
    'To use your own OpenAI key, first save it in RocketRide under Settings > Environment Variables as '
    'ROCKETRIDE_OPENAI_KEY, then set apikey to ${ROCKETRIDE_OPENAI_KEY}.'
)
TEAM_DEPLOY_WARNING = (
    "This pipeline has an OpenAI node with no API key. Hosted models aren't available for team deployments "
    'yet, so the node will fail when the pipeline runs on this team. Add your own OpenAI key to the node: save '
    'it in RocketRide under Settings > Environment Variables as ROCKETRIDE_OPENAI_KEY, then set apikey to '
    '${ROCKETRIDE_OPENAI_KEY}.'
)
_KEY_FIELD = {'path': 'llm.apikey', 'title': 'API key', 'kind': 'secret', 'required': True}
_CATALOG = {
    'llm_openai': {'title': 'OpenAI', 'fields': [{**_KEY_FIELD, 'suggests': 'ROCKETRIDE_OPENAI_KEY'}]},
    'llm_openai_api': {
        'title': 'OpenAI-Compatible API',
        'fields': [{**_KEY_FIELD, 'suggests': 'ROCKETRIDE_OPENAI_KEY'}],
    },
}
_MCP_SERVICES = {'services': {'llm_openai': {'classType': ['llm']}, 'llm_openai_api': {'classType': ['llm']}}}


def _engine(capabilities=(), env_keys=()):
    return FakeEngineClient(services=_MCP_SERVICES, env_keys=list(env_keys), capabilities=list(capabilities))


async def _tool(module, name, engine, args=None):
    registry = ToolRegistry()
    module.register(registry)
    return await registry.handler(name)(engine, None, args or {})


@pytest.fixture
def catalog(monkeypatch):
    monkeypatch.setattr(creds, 'load_catalog', lambda: creds.catalog_from_dict(_CATALOG))


async def test_on_hosted_models_the_openai_node_needs_nothing_wired(catalog):
    before = await _tool(integrations, 'list_integrations', _engine(), {'name': 'llm_openai'})
    after = await _tool(integrations, 'list_integrations', _engine([TAG]), {'name': 'llm_openai'})
    keyed = await _tool(
        integrations, 'list_integrations', _engine([TAG], ['ROCKETRIDE_OPENAI_KEY']), {'name': 'llm_openai'}
    )
    listed = await _tool(introspection, 'list_components', _engine(['saas', TAG]))

    assert before['status'] == 'available' and 'hosted' not in before
    assert (after['status'], after['hosted'], after['note'], after['wiring']) == ('configured', True, NOTE, {})
    assert keyed['wiring'] == {'llm.apikey': '${ROCKETRIDE_OPENAI_KEY}'}
    assert {c['name'] for c in listed['components']} == {'llm_openai'}
    assert 'rrmg_' not in json.dumps(after) and 'RR_MODEL_GATEWAY' not in json.dumps(after)


async def test_a_capability_lookup_that_never_answers_counts_as_no(monkeypatch):
    from ai.modules.mcp.tools import _common

    class Stuck:
        async def get_capabilities(self):
            await asyncio.Event().wait()

    monkeypatch.setattr(_common, 'DEFAULT_TIMEOUT_SECONDS', 0.05)
    assert await asyncio.wait_for(creds.fetch_hosted_models(Stuck()), timeout=5) is False


@pytest.mark.parametrize(
    'team, capabilities, apikey, warned, fetched',
    [
        ('team-1', [TAG], '', True, True),
        ('@me', [TAG], '', False, False),
        ('team-1', [], '', False, False),
        ('team-1', [TAG], 'sk-user', False, True),
    ],
    ids=['team', 'personal-space', 'no-hosted-models', 'keyed'],
)
async def test_a_deploy_to_a_team_warns_about_an_openai_node_with_no_key(
    decoder, team, capabilities, apikey, warned, fetched
):
    engine = _engine(capabilities)
    engine.deploy_results['artifact'] = _pipe(_node(config={'apikey': apikey}))
    args = {'project_id': 'p1', 'version': 2, 'team_id': team}

    result = await _tool(capability, 'deploy_to_team', engine, args)

    assert result['ok'] is True
    assert result.get('warnings') == ([TEAM_DEPLOY_WARNING] if warned else None)
    assert any(c['op'] == 'artifact' for c in engine.deploy_calls) is fetched


async def test_a_deploy_warning_reads_a_node_the_engine_serves(decoder, monkeypatch):
    from ai.modules.task import node_store

    monkeypatch.setattr(config_module, 'getServiceDefinition', lambda name: None)
    monkeypatch.setattr(node_store, 'served', lambda name: copy.deepcopy(_SERVICES.get(name)))
    engine = _engine([TAG])
    engine.deploy_results['artifact'] = _pipe(_node())

    result = await _tool(capability, 'deploy_to_team', engine, {'project_id': 'p1', 'version': 2, 'team_id': 'team-1'})

    assert result.get('warnings') == [TEAM_DEPLOY_WARNING]


async def test_deploy_add_to_a_team_warns_too(decoder):
    engine = _engine([TAG])
    engine.deploy_results['add'] = {'artifact': {'version': 1}, 'deployment': {'state': 'deployed'}}

    result = await _tool(capability, 'deploy_add', engine, {'pipeline': _pipe(_node()), 'deploy_to': 'team-1'})

    assert result['warnings'] == [TEAM_DEPLOY_WARNING]


# ---------------------------------------------------------------------------
# The account's defaults
# ---------------------------------------------------------------------------


async def test_an_account_without_hosted_models_issues_renews_and_revokes_nothing():
    from ai.account.base import AccountBase

    assert await AccountBase.issue_model_pass(None, {'run_id': 'r'}) is None
    assert await AccountBase.renew_model_pass(None, 'r') is None
    assert await AccountBase.revoke_model_pass(None, 'r') is None
    assert AccountBase.hosted_model_providers == ('openai',)
    for name in ('renew_model_pass', 'revoke_model_pass'):
        assert list(inspect.signature(getattr(AccountBase, name)).parameters) == ['self', 'run_id']
