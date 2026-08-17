# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for the introspection tools (`tools/introspection.py`):
`list_components`, `describe_component`, `validate_pipeline`,
`describe_pipeline`.
"""

import json

import pytest

from ai.modules.mcp import credentials as credentials_mod
from ai.modules.mcp.tooling import ToolRegistry
from ai.modules.mcp.tools import introspection
from ai.modules.mcp.tools import register_all


# A small, self-contained catalog -- must not depend on the shipped
# credentials.json's 55 real nodes/83 fields.
_CATALOG_RAW = {
    'store_qdrant': {
        'title': 'Qdrant',
        'docs': 'https://qdrant.tech/documentation/',
        'fields': [
            {
                'path': 'qdrant.url',
                'title': 'Cluster URL',
                'kind': 'endpoint',
                'required': True,
                'suggests': 'ROCKETRIDE_QDRANT_URL',
            },
            {
                'path': 'qdrant.apikey',
                'title': 'API key',
                'kind': 'secret',
                'required': True,
                'suggests': 'ROCKETRIDE_QDRANT_APIKEY',
            },
        ],
    },
}


def _fake_catalog():
    return credentials_mod.catalog_from_dict(_CATALOG_RAW)


def _services_with_catalog_node():
    return {
        'services': {
            'ocr': {
                'title': 'OCR',
                'protocol': 'ocr',
                'classType': ['source'],
                'description': 'Optical character recognition component',
            },
            'store_qdrant': {
                'title': 'Qdrant',
                'protocol': 'qdrant',
                'classType': ['store'],
                'description': 'Vector store',
            },
        },
        'version': 'x',
    }


# --- registration -------------------------------------------------------


def test_register_all_registers_all_four_introspection_tools():
    registry = ToolRegistry()

    register_all(registry)

    # register_all also wires other tool groups (execution, ...) as later
    # tasks land; only assert the introspection tools are present here.
    assert {
        'list_components',
        'describe_component',
        'validate_pipeline',
        'describe_pipeline',
    } <= set(registry.names())


def test_introspection_register_binds_handlers_directly():
    registry = ToolRegistry()

    introspection.register(registry)

    for name in ('list_components', 'describe_component', 'validate_pipeline', 'describe_pipeline'):
        assert registry.handler(name) is not None


# --- list_components -----------------------------------------------------


@pytest.mark.asyncio
async def test_list_components_slims_services(fake_engine):
    registry = ToolRegistry()
    introspection.register(registry)

    result = await registry.handler('list_components')(fake_engine, None, {})

    assert result['ok'] is True
    assert fake_engine.get_services_calls == 1
    by_name = {c['name']: c for c in result['components']}
    assert by_name['ocr'] == {
        'name': 'ocr',
        'category': ['source'],
        'summary': 'Optical character recognition component',
    }
    # No config schema or other engine metadata leaked into the slim menu:
    # the exact key set fails if a future change widens it.
    for comp in result['components']:
        assert set(comp) == {'name', 'category', 'summary'}


@pytest.mark.asyncio
async def test_list_components_skips_env_call_when_no_catalog_overlap(fake_engine, monkeypatch):
    """Default fixture services ('ocr', 'anthropic') don't collide with any
    catalog entry -- the extra get_environment_keys round trip must not fire.
    """
    monkeypatch.setattr(introspection.credentials_mod, 'load_catalog', _fake_catalog)
    registry = ToolRegistry()
    introspection.register(registry)

    result = await registry.handler('list_components')(fake_engine, None, {})

    assert result['ok'] is True
    assert 'note' not in result
    assert fake_engine.get_environment_keys_calls == 0
    assert {c['name'] for c in result['components']} == {'ocr', 'anthropic'}


@pytest.mark.asyncio
async def test_list_components_configured_catalog_node_carries_wiring(monkeypatch):
    from .conftest import FakeEngineClient

    monkeypatch.setattr(introspection.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(
        services=_services_with_catalog_node(),
        env_keys=['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY'],
    )
    registry = ToolRegistry()
    introspection.register(registry)

    result = await registry.handler('list_components')(engine, None, {})

    assert result['ok'] is True
    assert 'note' not in result
    assert engine.get_environment_keys_calls == 1
    by_name = {c['name']: c for c in result['components']}
    assert by_name['store_qdrant']['wiring'] == {
        'qdrant.url': '${ROCKETRIDE_QDRANT_URL}',
        'qdrant.apikey': '${ROCKETRIDE_QDRANT_APIKEY}',
    }
    # Zero-config entry stays unchanged -- no `wiring` key at all.
    assert 'wiring' not in by_name['ocr']


@pytest.mark.asyncio
async def test_list_components_unconfigured_catalog_node_omitted_with_note(monkeypatch):
    from .conftest import FakeEngineClient

    monkeypatch.setattr(introspection.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(
        services=_services_with_catalog_node(),
        env_keys=[],  # nothing set -> 'available', not 'configured'
    )
    registry = ToolRegistry()
    introspection.register(registry)

    result = await registry.handler('list_components')(engine, None, {})

    assert result['ok'] is True
    names = {c['name'] for c in result['components']}
    assert 'store_qdrant' not in names
    assert 'ocr' in names
    assert result['note'] == '1 integrations need setup - call list_integrations.'


@pytest.mark.asyncio
async def test_list_components_env_read_error_omits_catalog_node_not_zero_config(monkeypatch):
    """CRITICAL: an env-keys read failure must degrade credentialed nodes to
    'not configured' (omitted) -- it must never crash the tool, and it must
    never suppress a zero-config node.
    """
    from .conftest import FakeEngineClient

    monkeypatch.setattr(introspection.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(
        services=_services_with_catalog_node(),
        env_keys=RuntimeError('scope denied'),
    )
    registry = ToolRegistry()
    introspection.register(registry)

    result = await registry.handler('list_components')(engine, None, {})

    assert result['ok'] is True
    names = {c['name'] for c in result['components']}
    assert 'store_qdrant' not in names
    assert 'ocr' in names
    assert result['note'] == '1 integrations need setup - call list_integrations.'


# --- describe_component ---------------------------------------------------


@pytest.mark.asyncio
async def test_describe_component_requires_name(fake_engine):
    registry = ToolRegistry()
    introspection.register(registry)

    result = await registry.handler('describe_component')(fake_engine, None, {})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert fake_engine.get_service_calls == []


@pytest.mark.asyncio
async def test_describe_component_returns_full_definition(fake_engine):
    registry = ToolRegistry()
    introspection.register(registry)

    result = await registry.handler('describe_component')(fake_engine, None, {'name': 'ocr'})

    assert result['ok'] is True
    assert result['name'] == 'ocr'
    assert result['title'] == 'OCR'
    assert result['classType'] == ['source']
    assert fake_engine.get_service_calls == ['ocr']


@pytest.mark.asyncio
async def test_describe_component_unknown_name_returns_bad(fake_engine):
    registry = ToolRegistry()
    introspection.register(registry)

    result = await registry.handler('describe_component')(fake_engine, None, {'name': 'nope'})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert 'nope' in result['message']


@pytest.mark.asyncio
async def test_describe_component_zero_config_node_has_no_credentials_key(fake_engine, monkeypatch):
    monkeypatch.setattr(introspection.credentials_mod, 'load_catalog', _fake_catalog)
    registry = ToolRegistry()
    introspection.register(registry)

    result = await registry.handler('describe_component')(fake_engine, None, {'name': 'ocr'})

    assert result['ok'] is True
    assert 'credentials' not in result
    assert fake_engine.get_environment_keys_calls == 0


@pytest.mark.asyncio
async def test_describe_component_configured_catalog_node_has_credentials_with_wiring(monkeypatch):
    from .conftest import FakeEngineClient

    monkeypatch.setattr(introspection.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(
        services=_services_with_catalog_node(),
        env_keys=['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY'],
    )
    registry = ToolRegistry()
    introspection.register(registry)

    result = await registry.handler('describe_component')(engine, None, {'name': 'store_qdrant'})

    assert result['ok'] is True
    assert result['credentials'] == {
        'status': 'configured',
        'missing': [],
        'candidates': [],
        'wiring': {
            'qdrant.url': '${ROCKETRIDE_QDRANT_URL}',
            'qdrant.apikey': '${ROCKETRIDE_QDRANT_APIKEY}',
        },
    }
    assert 'setup' not in result['credentials']


@pytest.mark.asyncio
async def test_describe_component_available_catalog_node_has_credentials_with_setup(monkeypatch):
    from .conftest import FakeEngineClient

    monkeypatch.setattr(introspection.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(
        services=_services_with_catalog_node(),
        env_keys=[],  # nothing set, no candidates -> 'available'
    )
    registry = ToolRegistry()
    introspection.register(registry)

    result = await registry.handler('describe_component')(engine, None, {'name': 'store_qdrant'})

    assert result['ok'] is True
    assert result['credentials']['status'] == 'available'
    assert result['credentials']['setup'] == {
        'variables': ['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY'],
        'how': credentials_mod.SETUP_HOW,
        'docs': 'https://qdrant.tech/documentation/',
    }
    assert 'wiring' not in result['credentials']


# --- validate_pipeline -----------------------------------------------------


@pytest.mark.asyncio
async def test_validate_pipeline_ok_true_when_no_errors(fake_engine):
    registry = ToolRegistry()
    introspection.register(registry)
    pipeline = {'source': 'a', 'components': []}

    result = await registry.handler('validate_pipeline')(fake_engine, None, {'pipeline': pipeline})

    assert result == {'ok': True, 'errors': [], 'warnings': []}
    assert fake_engine.validate_calls == [{'pipeline': pipeline, 'source': None}]


@pytest.mark.asyncio
async def test_validate_pipeline_ok_false_when_errors(fake_engine):
    fake_engine._validate_result = {'errors': [{'type': 'x', 'message': 'bad', 'id': '1'}], 'warnings': []}
    registry = ToolRegistry()
    introspection.register(registry)
    pipeline = {'source': 'a', 'components': []}

    result = await registry.handler('validate_pipeline')(fake_engine, None, {'pipeline': pipeline})

    assert result['ok'] is False
    assert result['errors'] == [{'type': 'x', 'message': 'bad', 'id': '1'}]


@pytest.mark.asyncio
async def test_validate_pipeline_raises_value_error_when_no_input(fake_engine):
    registry = ToolRegistry()
    introspection.register(registry)

    with pytest.raises(ValueError):
        await registry.handler('validate_pipeline')(fake_engine, None, {})


# --- describe_pipeline -----------------------------------------------------


@pytest.mark.asyncio
async def test_describe_pipeline_parses_source_and_components(fake_engine):
    registry = ToolRegistry()
    introspection.register(registry)
    pipeline = {
        'source': 'my-pipe',
        'components': [
            {'id': 'c1', 'provider': 'ocr', 'input': ['c0']},
        ],
    }

    result = await registry.handler('describe_pipeline')(fake_engine, None, {'pipeline': pipeline})

    assert result['ok'] is True
    assert result['source'] == 'my-pipe'
    assert result['components'] == [
        {
            'id': 'c1',
            'provider': 'ocr',
            'title': 'OCR',
            'classType': ['source'],
            'inputs': ['c0'],
        }
    ]
    assert fake_engine.get_service_calls == ['ocr']


@pytest.mark.asyncio
async def test_describe_pipeline_tolerates_unknown_provider(fake_engine):
    registry = ToolRegistry()
    introspection.register(registry)
    pipeline = {
        'source': 'my-pipe',
        'components': [
            {'id': 'c1', 'provider': 'not_a_real_provider', 'input': []},
        ],
    }

    result = await registry.handler('describe_pipeline')(fake_engine, None, {'pipeline': pipeline})

    assert result['ok'] is True
    assert result['components'] == [
        {
            'id': 'c1',
            'provider': 'not_a_real_provider',
            'title': None,
            'classType': None,
            'inputs': [],
        }
    ]


@pytest.mark.asyncio
async def test_describe_pipeline_caches_get_service_per_provider(fake_engine):
    registry = ToolRegistry()
    introspection.register(registry)
    pipeline = {
        'source': 'my-pipe',
        'components': [
            {'id': 'c1', 'provider': 'ocr', 'input': []},
            {'id': 'c2', 'provider': 'ocr', 'input': ['c1']},
        ],
    }

    result = await registry.handler('describe_pipeline')(fake_engine, None, {'pipeline': pipeline})

    assert len(result['components']) == 2
    assert fake_engine.get_service_calls == ['ocr']  # called once, cached for the 2nd component


@pytest.mark.asyncio
async def test_describe_pipeline_raises_value_error_when_no_input(fake_engine):
    registry = ToolRegistry()
    introspection.register(registry)

    with pytest.raises(ValueError):
        await registry.handler('describe_pipeline')(fake_engine, None, {})


# --- real dispatch (build_mcp_server) --------------------------------------


@pytest.mark.asyncio
async def test_list_components_via_real_dispatch(fake_engine):
    import ai.modules.mcp.handlers as handlers_mod
    from mcp.client import Client

    server = handlers_mod.build_mcp_server(lambda: fake_engine)
    async with Client(server) as client:
        result = await client.call_tool('list_components', {})

    assert result.is_error is False
    payload = json.loads(result.content[0].text)
    assert payload['ok'] is True
    assert {c['name'] for c in payload['components']} == {'ocr', 'anthropic'}


@pytest.mark.asyncio
async def test_describe_pipeline_skips_lookup_when_provider_absent(fake_engine):
    """A component with no `provider` skips the get_service lookup and still
    emits its entry with provider None.
    """
    registry = ToolRegistry()
    introspection.register(registry)
    pipeline = {'source': 'my-pipe', 'components': [{'id': 'c1', 'input': []}]}

    result = await registry.handler('describe_pipeline')(fake_engine, None, {'pipeline': pipeline})

    assert result['ok'] is True
    assert result['components'] == [{'id': 'c1', 'provider': None, 'title': None, 'classType': None, 'inputs': []}]
    assert fake_engine.get_service_calls == []


@pytest.mark.asyncio
async def test_describe_pipeline_caches_unknown_provider_lookup(fake_engine):
    """Negative lookups are cached too: two components with the same
    unresolvable provider must cost exactly one seam call.
    """
    registry = ToolRegistry()
    introspection.register(registry)
    pipeline = {
        'source': 'my-pipe',
        'components': [
            {'id': 'c1', 'provider': 'nope', 'input': []},
            {'id': 'c2', 'provider': 'nope', 'input': ['c1']},
        ],
    }

    result = await registry.handler('describe_pipeline')(fake_engine, None, {'pipeline': pipeline})

    assert len(result['components']) == 2
    assert fake_engine.get_service_calls == ['nope']


@pytest.mark.asyncio
async def test_validate_pipeline_timeout_returns_timeout_envelope(fake_engine, monkeypatch):
    """Pins the shared `engine_call` wait_for wrap for the introspection group:
    a regression that drops the wrap from `_common.engine_call` must fail here,
    not just in the logs group (which carries its own wrap).
    """
    import asyncio

    from ai.modules.mcp.tools import _common

    async def _hang(*args, **kwargs):
        await asyncio.sleep(60)

    monkeypatch.setattr(fake_engine, 'validate', _hang)
    monkeypatch.setattr(_common, 'DEFAULT_TIMEOUT_SECONDS', 0.01)

    registry = ToolRegistry()
    introspection.register(registry)

    result = await registry.handler('validate_pipeline')(fake_engine, None, {'pipeline': {'components': []}})

    assert result['ok'] is False
    assert result['error_type'] == 'Timeout'
