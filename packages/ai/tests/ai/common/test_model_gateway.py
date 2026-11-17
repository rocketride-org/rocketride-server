# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Hosted OpenAI models for a node with no key: the pass, the key choice, the keyless check, the sentences.

The sentences are written out here in full, not imported, so a change to what a user
reads has to change this file too.
"""

import copy
import json
import sys
import time

import httpx
import pytest

openai = pytest.importorskip('openai')

import ai.common.config as config_module  # noqa: E402
from ai.common import model_gateway  # noqa: E402
from ai.common.model_gateway import (  # noqa: E402
    GATEWAY_ENV,
    GatewayPass,
    HostedModelError,
    MissingModelKeyError,
    friendly_gateway_error,
    missing_key_message,
    read_pass,
    resolve_openai_credentials,
    wants_hosted_openai,
)

BASE_URL = 'http://127.0.0.1:41873/gateway/openai/v1'
TOKEN = 'rrmg_' + 'a' * 43

NO_KEY_HOSTED = (
    "llm_openai: no API key is set, and RocketRide-hosted models aren't available for this run. "
    'Add your OpenAI key in the node settings, or save it in Settings > Variables as ROCKETRIDE_OPENAI_KEY '
    'and set apikey to ${ROCKETRIDE_OPENAI_KEY}.'
)
NO_KEY_SELF_HOSTED = (
    'llm_openai: no API key is set. Add your OpenAI key in the node settings, or save it in Settings > Variables '
    'as ROCKETRIDE_OPENAI_KEY and set apikey to ${ROCKETRIDE_OPENAI_KEY}.'
)

SENTENCES = {
    'insufficient_credits': (
        "This workspace doesn't have enough compute credits left for this request on RocketRide-hosted models. "
        'Add your own OpenAI key in the node settings, or ask a workspace admin to check compute credits '
        'under Account > Billing in RocketRide.'
    ),
    'rate_limited': 'RocketRide-hosted models are busy with other requests from this run. Try again shortly.',
    'invalid_gateway_pass': "This run's access to RocketRide-hosted models has ended. Start the pipeline again.",
    'gateway_unavailable': (
        'RocketRide-hosted models are unavailable right now. Try again shortly, or add your own OpenAI key '
        'in the node settings.'
    ),
    'upstream_unavailable': (
        'RocketRide-hosted models are unavailable right now. Try again shortly, or add your own OpenAI key '
        'in the node settings.'
    ),
    'request_too_large': (
        'This request is too large for RocketRide-hosted models. Send less text, or add your own OpenAI key '
        'in the node settings.'
    ),
}


def _pass(**overrides):
    value = {'provider': 'openai', 'base_url': BASE_URL, 'token': TOKEN, 'expires_at': time.time() + 3600}
    value.update(overrides)
    return value


def _env(value):
    return {GATEWAY_ENV: value if isinstance(value, str) else json.dumps(value)}


@pytest.fixture
def hosted(monkeypatch):
    """This process is a task of a hosted engine."""
    monkeypatch.setattr(sys, 'argv', [*sys.argv, '--hosted'])


@pytest.fixture
def self_hosted(monkeypatch):
    """This process is a task of a self-hosted engine."""
    monkeypatch.setattr(sys, 'argv', [a for a in sys.argv if a not in ('--hosted', '--saas')])


@pytest.fixture
def no_env_key(monkeypatch):
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.delenv(GATEWAY_ENV, raising=False)


# ---------------------------------------------------------------------------
# read_pass
# ---------------------------------------------------------------------------


def test_read_pass_returns_the_delivered_pass():
    value = _pass()
    got = read_pass(_env(value))
    assert got == GatewayPass('openai', BASE_URL, TOKEN, float(value['expires_at']))


def test_the_token_stays_out_of_repr():
    assert TOKEN not in repr(read_pass(_env(_pass())))


@pytest.mark.parametrize('raw', ['', '   ', 'not json', '[]', '"text"', 'null', '{}'])
def test_read_pass_refuses_missing_or_malformed_values(raw):
    assert read_pass({GATEWAY_ENV: raw}) is None


def test_read_pass_is_none_when_nothing_was_delivered():
    assert read_pass({}) is None


def test_read_pass_refuses_an_expired_pass():
    assert read_pass(_env(_pass(expires_at=time.time() - 1))) is None


@pytest.mark.parametrize('expires_at', [None, 'tomorrow', True, [1]])
def test_read_pass_refuses_an_expiry_that_is_not_a_number(expires_at):
    assert read_pass(_env(_pass(expires_at=expires_at))) is None


@pytest.mark.parametrize('provider', [None, 'anthropic', 'OpenAI', ''])
def test_read_pass_refuses_another_provider(provider):
    assert read_pass(_env(_pass(provider=provider))) is None


@pytest.mark.parametrize('token', [None, '', 'with space', 'line\nbreak', 12])
def test_read_pass_refuses_a_bad_token(token):
    assert read_pass(_env(_pass(token=token))) is None


@pytest.mark.parametrize(
    'base_url',
    [
        None,
        '',
        'https://127.0.0.1:41873/gateway/openai/v1',
        'http://localhost:41873/gateway/openai/v1',
        'http://[::1]:41873/gateway/openai/v1',
        'http://10.0.0.5:41873/gateway/openai/v1',
        'http://api.openai.com/v1',
        'https://api.example.test/v1',
        'http://127.0.0.1/gateway/openai/v1',
        'http://127.0.0.1:notaport/v1',
        'http://user:pw@127.0.0.1:41873/v1',
        'http://127.0.0.1:41873@api.example.test/v1',
        'http://127.0.0.1:41873/v1?next=https://api.example.test',
        'http://127.0.0.1:41873/v1#frag',
        ' http://127.0.0.1:41873/v1',
        'ftp://127.0.0.1:41873/v1',
    ],
)
def test_read_pass_refuses_any_url_but_http_on_loopback_with_a_port(base_url):
    assert read_pass(_env(_pass(base_url=base_url))) is None


def test_read_pass_reads_the_process_environment(monkeypatch):
    monkeypatch.setenv(GATEWAY_ENV, json.dumps(_pass()))
    assert read_pass().token == TOKEN


# ---------------------------------------------------------------------------
# resolve_openai_credentials
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('where', ['hosted', 'self_hosted'])
def test_a_key_of_its_own_is_used_as_it_is(request, monkeypatch, where):
    request.getfixturevalue(where)
    monkeypatch.setenv(GATEWAY_ENV, json.dumps(_pass()))
    assert resolve_openai_credentials('llm_openai', 'sk-user') == ('sk-user', '', False)
    assert resolve_openai_credentials('llm_openai_api', 'sk-user', 'https://api.example.test/v1') == (
        'sk-user',
        'https://api.example.test/v1',
        False,
    )


@pytest.mark.parametrize('apikey', ['', None, '   '])
def test_a_hosted_task_with_no_key_uses_the_pass(hosted, monkeypatch, apikey):
    monkeypatch.setenv(GATEWAY_ENV, json.dumps(_pass()))
    assert resolve_openai_credentials('llm_openai', apikey) == (TOKEN, BASE_URL, True)
    assert resolve_openai_credentials('llm_openai_api', apikey, None) == (TOKEN, BASE_URL, True)
    assert resolve_openai_credentials('llm_openai_api', apikey, '') == (TOKEN, BASE_URL, True)


@pytest.mark.parametrize('with_pass', [True, False])
def test_the_pass_never_goes_to_a_base_url_of_the_node(hosted, monkeypatch, with_pass):
    """A compatible node with its own endpoint and no key gets a message about that endpoint, not the pass."""
    if with_pass:
        monkeypatch.setenv(GATEWAY_ENV, json.dumps(_pass()))
    else:
        monkeypatch.delenv(GATEWAY_ENV, raising=False)
    with pytest.raises(MissingModelKeyError) as caught:
        resolve_openai_credentials('llm_openai_api', '', 'https://api.example.test/v1')
    assert (
        str(caught.value)
        == 'llm_openai_api: no API key is set. Add the API key for your endpoint in the node settings.'
    )


def test_a_hosted_task_with_no_key_and_no_pass_fails_with_the_message(hosted, no_env_key, monkeypatch):
    with pytest.raises(MissingModelKeyError) as caught:
        resolve_openai_credentials('llm_openai', '')
    assert str(caught.value) == NO_KEY_HOSTED


def test_a_hosted_task_never_falls_back_to_a_key_in_the_environment(hosted, monkeypatch):
    """OPENAI_API_KEY can reach a task; without a pass it must still not be used."""
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-canary-environment')
    monkeypatch.delenv(GATEWAY_ENV, raising=False)
    with pytest.raises(MissingModelKeyError):
        resolve_openai_credentials('llm_openai', '')
    with pytest.raises(MissingModelKeyError):
        resolve_openai_credentials('llm_openai_api', '', None)


def test_a_hosted_task_with_an_expired_pass_fails_with_the_message(hosted, monkeypatch):
    monkeypatch.setenv(GATEWAY_ENV, json.dumps(_pass(expires_at=time.time() - 5)))
    with pytest.raises(MissingModelKeyError) as caught:
        resolve_openai_credentials('llm_openai', '')
    assert str(caught.value) == NO_KEY_HOSTED


def test_a_self_hosted_openai_node_with_no_key_anywhere_fails_with_the_message(self_hosted, no_env_key):
    with pytest.raises(MissingModelKeyError) as caught:
        resolve_openai_credentials('llm_openai', '')
    assert str(caught.value) == NO_KEY_SELF_HOSTED


def test_a_self_hosted_openai_node_with_the_environment_key_is_unchanged(self_hosted, monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-env')
    assert resolve_openai_credentials('llm_openai', '') == ('', '', False)


def test_a_self_hosted_engine_ignores_a_pass(self_hosted, monkeypatch):
    """Only a hosted task uses a pass, whatever its environment holds."""
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.setenv(GATEWAY_ENV, json.dumps(_pass()))
    with pytest.raises(MissingModelKeyError):
        resolve_openai_credentials('llm_openai', '')
    assert resolve_openai_credentials('llm_openai_api', '', None) == ('', None, False)


def test_a_self_hosted_compatible_node_is_unchanged(self_hosted, no_env_key):
    assert resolve_openai_credentials('llm_openai_api', '', None) == ('', None, False)
    assert resolve_openai_credentials('llm_openai_api', '', 'http://127.0.0.1:11434/v1') == (
        '',
        'http://127.0.0.1:11434/v1',
        False,
    )


def test_the_missing_key_errors_are_not_hosted_refusals():
    """Raised at construction, before any request; a ValueError like the unresolved-key error."""
    assert issubclass(MissingModelKeyError, ValueError)
    assert not issubclass(HostedModelError, ValueError)


# ---------------------------------------------------------------------------
# missing_key_message (save-time check)
# ---------------------------------------------------------------------------


def test_a_save_time_check_on_a_self_hosted_engine_names_the_fix(self_hosted, no_env_key):
    assert missing_key_message('llm_openai') == NO_KEY_SELF_HOSTED
    assert missing_key_message('llm_openai_api') is None


def test_a_save_time_check_with_the_environment_key_says_nothing(self_hosted, monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-env')
    assert missing_key_message('llm_openai') is None


@pytest.mark.parametrize('flag', ['--hosted', '--saas'])
def test_a_save_time_check_on_a_hosted_engine_says_nothing(monkeypatch, no_env_key, flag):
    """The check can run in a task (--hosted) or in the hosted server itself (--saas)."""
    monkeypatch.setattr(sys, 'argv', [*sys.argv, flag])
    assert missing_key_message('llm_openai') is None


# ---------------------------------------------------------------------------
# friendly_gateway_error: one case per row of the table
# ---------------------------------------------------------------------------


def _refusal(status, code, message='', *, param=None, wrapped=False, error_type='rocketride_gateway_error'):
    """What the openai SDK raises for a hosted backend's error reply."""
    err = {'message': message, 'type': error_type, 'code': code}
    if param is not None:
        err['param'] = param
    request = httpx.Request('POST', f'{BASE_URL}/responses')
    response = httpx.Response(status, request=request, json={'error': err})
    return openai.APIStatusError(f'Error code: {status}', response=response, body={'error': err} if wrapped else err)


@pytest.mark.parametrize('code,sentence', sorted(SENTENCES.items()))
@pytest.mark.parametrize('wrapped', [False, True])
def test_each_refusal_code_reads_as_its_sentence(code, sentence, wrapped):
    assert friendly_gateway_error(_refusal(402, code, 'raw text', wrapped=wrapped), 'gpt-5-nano') == sentence


def test_a_model_not_offered_names_the_model():
    sentence = (
        "The model gpt-9 isn't offered as a RocketRide-hosted model. Choose another model, "
        'or add your own OpenAI key in the node settings.'
    )
    assert friendly_gateway_error(_refusal(400, 'model_not_available'), 'gpt-9') == sentence
    from_backend = _refusal(
        400, 'model_not_available', "The model gpt-9 isn't offered as a RocketRide-hosted model. Choose another."
    )
    assert friendly_gateway_error(from_backend) == sentence
    assert friendly_gateway_error(_refusal(400, 'model_not_available')) == (
        "The model isn't offered as a RocketRide-hosted model. Choose another model, "
        'or add your own OpenAI key in the node settings.'
    )


def test_an_unsupported_field_is_named():
    def sentence(field):
        return f"RocketRide-hosted models don't support {field}. Add your own OpenAI key in the node settings to run this request."

    assert friendly_gateway_error(_refusal(400, 'unsupported_parameter', param='previous_response_id')) == sentence(
        'previous_response_id'
    )
    from_backend = _refusal(400, 'unsupported_parameter', sentence('tools[0].type=web_search'))
    assert friendly_gateway_error(from_backend) == sentence('tools[0].type=web_search')
    assert friendly_gateway_error(_refusal(400, 'unsupported_parameter', 'nope')) == sentence('part of this request')


def test_any_other_code_reads_as_the_general_sentence():
    """The code stays out of the sentence: a code can name internals (the log has it)."""
    expected = (
        "RocketRide-hosted models couldn't run this request. Try again later, or add your own OpenAI key in the "
        'node settings.'
    )
    for code in ('something_new', 'gateway_local_only', 'invalid_request', None):
        assert friendly_gateway_error(_refusal(418, code)) == expected


def test_no_sentence_contains_a_star():
    """The engine splits error text on '*', so nothing a backend sends may add one."""
    values = [
        friendly_gateway_error(_refusal(400, 'model_not_available'), 'gpt*5'),
        friendly_gateway_error(_refusal(400, 'unsupported_parameter', param='a*b')),
        friendly_gateway_error(_refusal(400, 'odd*code')),
        *[friendly_gateway_error(_refusal(400, code)) for code in SENTENCES],
        NO_KEY_HOSTED,
        NO_KEY_SELF_HOSTED,
    ]
    assert all('*' not in v for v in values)


def test_other_errors_have_no_sentence():
    assert friendly_gateway_error(_refusal(400, 'unsupported_parameter', error_type='invalid_request_error')) is None
    assert friendly_gateway_error(ValueError('rocketride_gateway_error')) is None
    assert friendly_gateway_error(openai.APIConnectionError(request=httpx.Request('POST', BASE_URL))) is None


# ---------------------------------------------------------------------------
# wants_hosted_openai
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
        'preconfig': {
            'default': 'custom',
            'profiles': {'custom': {'model': '', 'base_url': '', 'apikey': ''}},
        }
    },
}


@pytest.fixture(autouse=True)
def services(monkeypatch):
    """Serve the two nodes' profiles to Config.getNodeConfig, the resolver the node uses."""
    monkeypatch.setattr(config_module, 'getServiceDefinition', lambda name: copy.deepcopy(_SERVICES.get(name)))


@pytest.fixture
def decoder(monkeypatch):
    """Stand in for the engine's secure parameter decoder. It edits its argument in
    place, so a test can tell whether it was handed the caller's pipeline or a copy.
    """
    calls = []

    def resolve(pipeline):
        calls.append(pipeline)
        for component in pipeline.get('components') or []:
            for block in (component.get('config') or {}).values():
                if isinstance(block, dict) and 'secureParameters' in block:
                    block.update(json.loads(block.pop('secureParameters')['token']))
        return pipeline

    monkeypatch.setattr(sys.modules['rocketlib'], 'resolveSecureParameters', resolve, raising=False)
    return calls


def _node(provider='llm_openai', config=None, id='llm_1'):
    return {'id': id, 'provider': provider, 'config': {} if config is None else config}


def _pipe(*components):
    return {'source': 'chat_1', 'components': [{'id': 'chat_1', 'provider': 'chat', 'config': {}}, *components]}


def _group(*components):
    return {'id': 'group_1', 'provider': 'group', 'config': {'pipeline': {'components': list(components)}}}


@pytest.mark.parametrize(
    'config',
    [
        {'apikey': 'sk-top-level'},
        {'profile': 'openai-4o-mini', 'openai-4o-mini': {'apikey': 'sk-in-profile-block'}},
        {'openai-5-2': {'apikey': 'sk-in-default-profile-block'}},
        {'profile': 'keyed-default'},
        {'apikey': 'sk-resolved-from-a-variable'},
        {'apikey': '${ROCKETRIDE_OPENAI_KEY}'},
    ],
    ids=['top-level', 'profile-block', 'default-profile-block', 'profile-defaults', 'resolved-variable', 'unresolved'],
)
def test_a_node_with_a_key_wants_no_pass(decoder, config):
    assert wants_hosted_openai(_pipe(_node(config=config))) is False


@pytest.mark.parametrize(
    'config',
    [{}, {'apikey': ''}, {'apikey': '  '}, {'profile': 'openai-4o-mini'}, {'openai-5-2': {'apikey': ''}}],
)
def test_a_node_with_no_key_wants_a_pass(decoder, config):
    assert wants_hosted_openai(_pipe(_node(config=config))) is True


def test_a_component_with_no_config_wants_a_pass(decoder):
    assert wants_hosted_openai(_pipe({'id': 'llm_1', 'provider': 'llm_openai'})) is True


def test_a_key_in_a_secure_parameter_is_decoded_on_a_copy(decoder):
    """Without the deployment secret the token is still encoded when the engine asks; a key in it counts."""
    pipeline = _pipe(
        _node(
            config={
                'openai-5-2': {'secureParameters': {'secure': ['apikey'], 'token': json.dumps({'apikey': 'sk-sealed'})}}
            }
        )
    )
    before = copy.deepcopy(pipeline)
    assert wants_hosted_openai(pipeline) is False
    assert pipeline == before
    assert decoder and decoder[0] is not pipeline


def test_a_key_the_engine_already_decoded_counts(decoder):
    """With the deployment secret set the engine decoded the tokens first; decoding again changes nothing."""
    assert wants_hosted_openai(_pipe(_node(config={'openai-5-2': {'apikey': 'sk-decoded'}}))) is False


def test_an_empty_secure_parameter_still_wants_a_pass(decoder):
    pipeline = _pipe(
        _node(config={'openai-5-2': {'secureParameters': {'secure': ['apikey'], 'token': json.dumps({'apikey': ''})}}})
    )
    assert wants_hosted_openai(pipeline) is True


def test_a_failed_decode_wants_no_pass(monkeypatch):
    def broken(pipeline):
        raise RuntimeError('cannot decode')

    monkeypatch.setattr(sys.modules['rocketlib'], 'resolveSecureParameters', broken, raising=False)
    assert wants_hosted_openai(_pipe(_node())) is False


def test_one_keyed_and_one_keyless_node_want_a_pass(decoder):
    assert wants_hosted_openai(_pipe(_node(config={'apikey': 'sk-a'}), _node(id='llm_2'))) is True


def test_two_keyed_nodes_want_no_pass(decoder):
    pipeline = _pipe(_node(config={'apikey': 'sk-a'}), _node('llm_openai_api', {'apikey': 'sk-b'}, id='llm_2'))
    assert wants_hosted_openai(pipeline) is False


def test_a_compatible_node_with_its_own_endpoint_wants_no_pass(decoder):
    assert wants_hosted_openai(_pipe(_node('llm_openai_api', {'base_url': 'http://127.0.0.1:11434/v1'}))) is False
    assert wants_hosted_openai(_pipe(_node('llm_openai_api', {'model': 'gpt-4o-mini'}))) is True


def test_a_keyless_node_in_a_group_wants_a_pass(decoder):
    assert wants_hosted_openai(_pipe(_group(_node()))) is True


def test_groups_are_followed_to_a_depth_of_8(decoder):
    """The top-level list and seven nested groups are read; an eighth group is not."""

    def nested(levels):
        inner = _node()
        for _ in range(levels):
            inner = _group(inner)
        return _pipe(inner)

    assert wants_hosted_openai(nested(7)) is True
    assert wants_hosted_openai(nested(8)) is False


def test_a_pipeline_with_no_openai_node_wants_no_pass(decoder):
    assert wants_hosted_openai(_pipe(_node('llm_anthropic'))) is False
    assert wants_hosted_openai({'components': []}) is False
    assert wants_hosted_openai({}) is False


@pytest.mark.parametrize('config', [['apikey'], 'sk-text', 42])
def test_settings_that_are_not_a_dict_want_no_pass(decoder, config):
    assert wants_hosted_openai(_pipe({'id': 'llm_1', 'provider': 'llm_openai', 'config': config})) is False


@pytest.mark.parametrize('pipeline', [None, [], 'pipe', {'components': 'x'}, {'components': [None, 3, 'x']}])
def test_malformed_pipelines_want_no_pass(decoder, pipeline):
    assert wants_hosted_openai(pipeline) is False


def test_an_unknown_profile_counts_as_keyed(decoder):
    """A node the resolver cannot read fails when it starts; it does not get a pass."""
    assert wants_hosted_openai(_pipe(_node(config={'profile': 'no-such-profile'}))) is False


def test_the_module_imports_nothing_heavy():
    """The task engine imports this module in the server process at load."""
    source = open(model_gateway.__file__, encoding='utf-8').read()
    head = source.split('\ndef ', 1)[0]
    assert 'import ai.' not in head and 'from ai.' not in head
