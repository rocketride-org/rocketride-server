# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for the integration-discovery tool (`tools/integrations.py`):
`list_integrations`.
"""

import pytest

from ai.modules.mcp import credentials as credentials_mod
from ai.modules.mcp.tooling import ToolRegistry
from ai.modules.mcp.tools import integrations
from ai.modules.mcp.tools import register_all

from .conftest import FakeEngineClient

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
    'store_pinecone': {
        'title': 'Pinecone',
        'docs': 'https://docs.pinecone.io/',
        'fields': [
            {
                'path': 'pinecone.apikey',
                'title': 'API key',
                'kind': 'secret',
                'required': True,
                'suggests': 'ROCKETRIDE_PINECONE_APIKEY',
            },
        ],
    },
}


def _fake_catalog():
    return credentials_mod.catalog_from_dict(_CATALOG_RAW)


def _services_with_catalog_nodes():
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
            # store_pinecone deliberately absent from this engine's
            # get_services() -- proves the bare list intersects, not just
            # dumps the whole catalog.
        },
        'version': 'x',
    }


# --- registration -----------------------------------------------------------


def test_register_all_registers_list_integrations_last():
    registry = ToolRegistry()

    register_all(registry)

    assert 'list_integrations' in registry.names()
    assert registry.names()[-1] == 'list_integrations'


def test_integrations_register_binds_handler_directly():
    registry = ToolRegistry()

    integrations.register(registry)

    assert registry.handler('list_integrations') is not None


def test_list_integrations_description_mentions_setup_and_variable_relay():
    registry = ToolRegistry()

    integrations.register(registry)

    description = next(t.description for t in registry.tools() if t.name == 'list_integrations')
    assert (
        'Entries include setup instructions you can relay to the user; unconfirmed entries list the '
        "caller's variable names so you can propose a binding and confirm with the user before using it." in description
    )


# --- bare call: compact list --------------------------------------------------


@pytest.mark.asyncio
async def test_list_integrations_bare_intersects_engine_and_sorts(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(
        services=_services_with_catalog_nodes(),
        env_keys=['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY'],
    )
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {})

    assert result['ok'] is True
    assert 'note' in result
    # store_pinecone is in the catalog but not in this engine's services --
    # must be excluded from the bare list entirely.
    names = [row['name'] for row in result['integrations']]
    assert names == ['store_qdrant']
    assert result['integrations'] == [
        {'name': 'store_qdrant', 'title': 'Qdrant', 'status': 'configured', 'missing_count': 0}
    ]


@pytest.mark.asyncio
async def test_list_integrations_bare_sorted_by_name(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    services = {
        'services': {
            'store_qdrant': {'title': 'Qdrant', 'protocol': 'qdrant', 'classType': ['store']},
            'store_pinecone': {'title': 'Pinecone', 'protocol': 'pinecone', 'classType': ['store']},
        },
        'version': 'x',
    }
    engine = FakeEngineClient(services=services, env_keys=[])
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {})

    names = [row['name'] for row in result['integrations']]
    assert names == sorted(names)
    assert names == ['store_pinecone', 'store_qdrant']


@pytest.mark.asyncio
async def test_list_integrations_bare_skips_env_call_when_no_catalog_overlap(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    # Default fixture services ('ocr', 'anthropic') don't collide with the
    # fake catalog -- the extra get_environment_keys round trip must not fire.
    engine = FakeEngineClient()
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {})

    assert result['ok'] is True
    assert result['integrations'] == []
    assert engine.get_environment_keys_calls == 0


@pytest.mark.asyncio
async def test_list_integrations_bare_env_error_marks_every_row_unconfirmed(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(
        services=_services_with_catalog_nodes(),
        env_keys=RuntimeError('scope denied'),
    )
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {})

    assert result['ok'] is True
    assert len(result['integrations']) == 1
    assert result['integrations'][0]['status'] == 'unconfirmed'


# --- name detail --------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_integrations_detail_configured_has_wiring_no_setup(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(env_keys=['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY'])
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {'name': 'store_qdrant'})

    assert result['ok'] is True
    assert result['name'] == 'store_qdrant'
    assert result['title'] == 'Qdrant'
    assert result['status'] == 'configured'
    assert result['missing'] == []
    assert result['candidates'] == []
    assert result['caller_variables'] == ['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY']
    assert result['wiring'] == {
        'qdrant.url': '${ROCKETRIDE_QDRANT_URL}',
        'qdrant.apikey': '${ROCKETRIDE_QDRANT_APIKEY}',
    }
    assert 'setup' not in result
    assert result['fields'] == [
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
    ]


@pytest.mark.asyncio
async def test_list_integrations_detail_available_has_setup_block(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(env_keys=[])  # nothing set, no candidates -> 'available'
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {'name': 'store_qdrant'})

    assert result['ok'] is True
    assert result['status'] == 'available'
    assert result['missing'] == ['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY']
    assert result['candidates'] == []
    assert result['caller_variables'] == []
    assert 'wiring' not in result
    assert result['setup'] == {
        'variables': ['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY'],
        'how': credentials_mod.SETUP_HOW,
        'docs': 'https://qdrant.tech/documentation/',
    }


@pytest.mark.asyncio
async def test_list_integrations_detail_unconfirmed_has_candidates_and_caller_variables(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    # A near-miss variable name (token match on QDRANT) but not the exact
    # suggested name -> 'unconfirmed' with a surfaced candidate.
    engine = FakeEngineClient(env_keys=['MY_QDRANT_KEY'])
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {'name': 'store_qdrant'})

    assert result['ok'] is True
    assert result['status'] == 'unconfirmed'
    assert result['candidates'] == ['MY_QDRANT_KEY']
    assert result['caller_variables'] == ['MY_QDRANT_KEY']
    assert 'wiring' not in result
    assert 'setup' in result


@pytest.mark.asyncio
async def test_list_integrations_detail_env_error_is_unconfirmed_with_empty_caller_variables(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(env_keys=RuntimeError('scope denied'))
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {'name': 'store_qdrant'})

    assert result['ok'] is True
    assert result['status'] == 'unconfirmed'
    assert result['caller_variables'] == []
    assert 'setup' in result
    assert 'wiring' not in result


@pytest.mark.asyncio
async def test_list_integrations_unknown_name_is_bad_request(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient()
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {'name': 'nope'})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert 'nope' in result['message']
    assert result['hint']
