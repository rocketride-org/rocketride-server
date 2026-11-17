# Copyright 2026 Aparavi Software AG. MIT License.
"""``llm_openai`` with no key of the caller's, on an engine that runs it on hosted models.

The engine's sign-in result carries the capability tag ``hosted-models:openai`` when
its backend runs the OpenAI node with no key. The integration tools then list
``llm_openai`` as usable with nothing to wire and a short note. A saved key still wins,
every other integration is unchanged, and no output names anything the platform holds.
"""

import json

import pytest

from ai.modules.mcp import credentials as creds
from ai.modules.mcp.tooling import ToolRegistry
from ai.modules.mcp.tools import integrations, introspection

from .conftest import FakeEngineClient

TAG = 'hosted-models:openai'
NOTE = (
    "Runs on RocketRide-hosted models without a key of your own, using this workspace's compute credits. "
    'Leave apikey empty, or save your OpenAI key in Settings > Variables as ROCKETRIDE_OPENAI_KEY and set '
    'apikey to ${ROCKETRIDE_OPENAI_KEY}.'
)
PLATFORM_NAMES = ('ROCKETRIDE_MODEL_GATEWAY', 'RR_MODEL_GATEWAY', 'rrmg_')

RAW = {
    'llm_openai': {
        'title': 'OpenAI',
        'docs': 'https://platform.openai.com/docs/api-reference',
        'fields': [
            {
                'path': 'llm.apikey',
                'title': 'OpenAI API key',
                'kind': 'secret',
                'required': True,
                'suggests': 'ROCKETRIDE_OPENAI_KEY',
            }
        ],
    },
    'llm_openai_api': {
        'title': 'OpenAI-Compatible API',
        'docs': 'https://platform.openai.com/docs/api-reference',
        'fields': [
            {
                'path': 'llm.apikey',
                'title': 'OpenAI (or compatible endpoint) API key',
                'kind': 'secret',
                'required': True,
                'suggests': 'ROCKETRIDE_OPENAI_KEY',
            }
        ],
    },
}


def _catalog():
    return creds.catalog_from_dict(RAW)


def _services():
    return {
        'services': {
            'llm_openai': {'classType': ['llm'], 'description': 'OpenAI chat models'},
            'llm_openai_api': {'classType': ['llm'], 'description': 'OpenAI-compatible chat models'},
            'ocr': {'classType': ['source'], 'description': 'Optical character recognition'},
        },
        'version': 'x',
    }


@pytest.fixture(autouse=True)
def catalog(monkeypatch):
    monkeypatch.setattr(creds, 'load_catalog', _catalog)


def _engine(*, capabilities=(), env_keys=()):
    return FakeEngineClient(services=_services(), env_keys=list(env_keys), capabilities=list(capabilities))


def _assert_no_platform_names(result):
    text = json.dumps(result)
    for name in PLATFORM_NAMES:
        assert name not in text


# ---------------------------------------------------------------------------
# evaluate / describe_state
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('env_keys', [[], ['ROCKETRIDE_OTHER'], None])
def test_with_hosted_models_the_openai_node_needs_nothing_wired(env_keys):
    state = creds.evaluate(_catalog()['llm_openai'], env_keys, hosted_models=True)

    assert (state['status'], state['wiring'], state['missing'], state['candidates']) == ('configured', {}, [], [])
    assert state['hosted'] is True
    block = creds.describe_state(_catalog()['llm_openai'], state)
    assert block == {
        'status': 'configured',
        'missing': [],
        'candidates': [],
        'wiring': {},
        'hosted': True,
        'note': NOTE,
    }


def test_a_saved_key_still_wins_and_wires_as_before():
    state = creds.evaluate(_catalog()['llm_openai'], ['ROCKETRIDE_OPENAI_KEY'], hosted_models=True)

    assert state['wiring'] == {'llm.apikey': '${ROCKETRIDE_OPENAI_KEY}'}
    assert 'hosted' not in state
    assert 'note' not in creds.describe_state(_catalog()['llm_openai'], state)


def test_without_hosted_models_nothing_changes():
    hosted_off = creds.evaluate(_catalog()['llm_openai'], [], hosted_models=False)
    assert hosted_off == creds.evaluate(_catalog()['llm_openai'], [])
    assert hosted_off['status'] == 'available'
    assert 'hosted' not in hosted_off


def test_only_the_openai_node_runs_on_hosted_models():
    """The compatible node can point anywhere, so it still needs a key the caller saved."""
    state = creds.evaluate(_catalog()['llm_openai_api'], [], hosted_models=True)
    assert state['status'] == 'available'
    assert 'hosted' not in state


# ---------------------------------------------------------------------------
# fetch_hosted_models
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'capabilities,expected',
    [
        (['saas', TAG], True),
        ([TAG], True),
        (['saas'], False),
        ([], False),
        (['hosted-models:anthropic'], False),
        (RuntimeError('not connected'), False),
    ],
)
async def test_hosted_models_come_from_the_capability_tag(capabilities, expected):
    assert await creds.fetch_hosted_models(FakeEngineClient(capabilities=capabilities)) is expected


@pytest.mark.asyncio
async def test_a_client_without_capabilities_has_no_hosted_models():
    class Older:
        pass

    assert await creds.fetch_hosted_models(Older()) is False


# ---------------------------------------------------------------------------
# list_components / describe_component
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_components_lists_the_openai_node_with_no_key_on_hosted_models():
    registry = ToolRegistry()
    introspection.register(registry)

    before = await registry.handler('list_components')(_engine(), None, {})
    after = await registry.handler('list_components')(_engine(capabilities=['saas', TAG]), None, {})

    assert {c['name'] for c in before['components']} == {'ocr'}
    assert before['note'] == '2 integrations need setup - call list_integrations.'
    by_name = {c['name']: c for c in after['components']}
    assert set(by_name) == {'ocr', 'llm_openai'}
    assert by_name['llm_openai']['wiring'] == {}
    assert after['note'] == '1 integrations need setup - call list_integrations.'
    _assert_no_platform_names(after)


@pytest.mark.asyncio
async def test_list_components_asks_for_capabilities_only_when_the_node_is_there():
    engine = FakeEngineClient(services={'services': {'ocr': {'classType': ['source']}}}, capabilities=[TAG])
    registry = ToolRegistry()
    introspection.register(registry)

    await registry.handler('list_components')(engine, None, {})

    assert engine.get_capabilities_calls == 0


@pytest.mark.asyncio
async def test_describe_component_carries_the_hosted_note():
    engine = _engine(capabilities=[TAG])
    registry = ToolRegistry()
    introspection.register(registry)

    result = await registry.handler('describe_component')(engine, None, {'name': 'llm_openai'})

    assert result['credentials']['hosted'] is True
    assert result['credentials']['note'] == NOTE
    assert result['credentials']['wiring'] == {}
    _assert_no_platform_names(result)


# ---------------------------------------------------------------------------
# list_integrations
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_integrations_marks_the_openai_node_as_hosted():
    registry = ToolRegistry()
    integrations.register(registry)

    before = await registry.handler('list_integrations')(_engine(), None, {})
    after = await registry.handler('list_integrations')(_engine(capabilities=[TAG]), None, {})

    rows_before = {r['name']: r for r in before['integrations']}
    rows_after = {r['name']: r for r in after['integrations']}
    assert rows_before['llm_openai'] == {
        'name': 'llm_openai',
        'title': 'OpenAI',
        'status': 'available',
        'missing_count': 1,
    }
    assert rows_after['llm_openai'] == {
        'name': 'llm_openai',
        'title': 'OpenAI',
        'status': 'configured',
        'missing_count': 0,
        'hosted': True,
    }
    assert rows_after['llm_openai_api'] == rows_before['llm_openai_api']
    _assert_no_platform_names(after)


@pytest.mark.asyncio
async def test_list_integrations_by_name_explains_the_hosted_state():
    engine = _engine(capabilities=[TAG], env_keys=['ROCKETRIDE_SLACK_TOKEN'])
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {'name': 'llm_openai'})

    assert (result['status'], result['wiring'], result['hosted'], result['note']) == ('configured', {}, True, NOTE)
    assert 'setup' not in result
    # Only names the caller saved, never a name the platform holds
    assert result['caller_variables'] == ['ROCKETRIDE_SLACK_TOKEN']
    _assert_no_platform_names(result)


@pytest.mark.asyncio
async def test_list_integrations_by_name_with_a_saved_key_wires_it():
    engine = _engine(capabilities=[TAG], env_keys=['ROCKETRIDE_OPENAI_KEY'])
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {'name': 'llm_openai'})

    assert result['wiring'] == {'llm.apikey': '${ROCKETRIDE_OPENAI_KEY}'}
    assert 'hosted' not in result


@pytest.mark.asyncio
async def test_a_self_hosted_engine_is_unchanged():
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(_engine(capabilities=['oss']), None, {'name': 'llm_openai'})

    assert result['status'] == 'available'
    assert result['setup']['variables'] == ['ROCKETRIDE_OPENAI_KEY']
    assert 'hosted' not in result and 'note' not in result


# ---------------------------------------------------------------------------
# The engine client
# ---------------------------------------------------------------------------


class _Sdk:
    def __init__(self, info):
        self.info = info
        self.connect_calls = 0

    async def connect(self):
        self.connect_calls += 1

    def get_account_info(self):
        return self.info


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'info,expected',
    [
        ({'capabilities': ['saas', TAG]}, ['saas', TAG]),
        ({'capabilities': ['saas', 3, None]}, ['saas']),
        ({'capabilities': 'saas'}, []),
        ({}, []),
        (None, []),
    ],
)
async def test_the_engine_client_reads_capabilities_from_the_sign_in_result(info, expected):
    from ai.modules.mcp.engine import WsEngineClient

    client = WsEngineClient(uri='ws://localhost:5565', auth='test-auth')
    client._client = _Sdk(info)

    assert await client.get_capabilities() == expected
    assert client._client.connect_calls == 1
