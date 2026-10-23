# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""EaaS registers the nodes the server does not carry, and serves them to tasks."""

import json
import os
import sys

import pytest

from ai.constants import CONST_NODES_CONTRACT
from ai.modules.task import node_store

ON_DISK = {'protocol': 'webhook://', 'icon': 'webhook.svg'}
PACKAGED = {'protocol': 'provider_x://', 'icon': 'x.svg', 'maximum': 1.0}


def _index(contract=CONST_NODES_CONTRACT):
    return {
        'contract': contract,
        'nodes': {
            'webhook': {
                'sha256': 'w',
                'services': {'services.json': json.dumps(ON_DISK)},
                'icons': {'webhook.svg': '<svg/>'},
            },
            'llm_x': {
                'sha256': 'x',
                'services': {'services.json': json.dumps(PACKAGED)},
                'icons': {'x.svg': '<svg id="x"/>'},
            },
        },
    }


@pytest.fixture
def server(tmp_path, monkeypatch):
    calls = {'registered': [], 'commands': [], 'warnings': [], 'cache': str(tmp_path)}
    monkeypatch.setattr(node_store, 'engine_cache_dir', lambda create=False: str(tmp_path))
    monkeypatch.setattr(node_store.node_packages, 'serve', lambda source: calls.setdefault('served', []).append(source))
    monkeypatch.setattr(node_store, '_nodes', {})
    monkeypatch.setattr(node_store, '_providers', {})
    monkeypatch.setattr(sys, 'path', list(sys.path))
    monkeypatch.setattr(sys, 'meta_path', list(sys.meta_path))
    monkeypatch.setattr(node_store, 'getServiceDefinition', lambda p: {} if p == 'webhook' else None)
    monkeypatch.setattr(node_store.engLib, 'registerServices', calls['registered'].append, raising=False)
    monkeypatch.setattr(node_store, 'register_channel_command', lambda name, handler: calls['commands'].append(name))
    monkeypatch.setattr(node_store, 'warning', calls['warnings'].append)
    monkeypatch.setattr(node_store.account, 'node_index', lambda: _index())
    monkeypatch.setattr(node_store.account, 'node_package', lambda name, sha256: f'{name}:{sha256}'.encode())
    return calls


def test_only_the_nodes_not_on_disk_are_registered_with_their_icons(server):
    node_store.start()

    icon_dir = os.path.join(server['cache'], 'node-icons', 'x', 'llm_x')
    assert server['registered'] == [[(PACKAGED, os.path.join(icon_dir, 'services.json'))]]
    assert isinstance(server['registered'][0][0][0]['maximum'], float)
    assert open(os.path.join(icon_dir, 'x.svg')).read() == '<svg id="x"/>'
    assert server['commands'] == ['node.fetch'] and server['served'] == [node_store._package]


@pytest.mark.parametrize('broken', ['contract', 'unavailable', 'malformed', 'refused'])
def test_an_index_it_cannot_use_registers_nothing(server, monkeypatch, broken):
    if broken == 'contract':
        monkeypatch.setattr(node_store.account, 'node_index', lambda: _index(CONST_NODES_CONTRACT + 1))
    elif broken == 'unavailable':

        def unavailable():
            raise OSError('offline')

        monkeypatch.setattr(node_store.account, 'node_index', unavailable)
    elif broken == 'malformed':
        index = _index()
        del index['nodes']['llm_x']['services']
        monkeypatch.setattr(node_store.account, 'node_index', lambda: index)
    else:

        def refuse(definitions):
            raise RuntimeError('Protocol missing or invalid')

        monkeypatch.setattr(node_store.engLib, 'registerServices', refuse, raising=False)

    node_store.start()

    assert server['registered'] == [] and server['commands'] == [] and 'served' not in server
    assert len(server['warnings']) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('asked', ['llm_x', 'provider_x'])
async def test_a_task_gets_a_package_by_node_or_provider_name(server, asked):
    node_store.start()

    reply = await node_store._fetch(None, {'name': asked}, None)

    assert reply.body == {'name': 'llm_x', 'sha256': 'x', 'services': {'services.json': PACKAGED}}
    assert reply.data == b'llm_x:x'


@pytest.mark.asyncio
async def test_a_name_this_server_does_not_serve_gets_an_empty_answer(server):
    node_store.start()

    reply = await node_store._fetch(None, {'name': 'filesys'}, None)

    assert reply.body == {} and reply.data is None


def test_the_source_serves_a_node_by_node_or_provider_name_and_nothing_else(server):
    node_store.start()

    assert node_store._package('provider_x') == ('llm_x', b'llm_x:x', 'x', {'services.json': PACKAGED})
    assert node_store._package('llm_x') == node_store._package('provider_x')
    assert node_store._package('filesys') is None


def test_a_provider_two_nodes_claim_is_served_by_the_first_and_warned_about(server, monkeypatch):
    index = _index()
    index['nodes']['llm_y'] = {**index['nodes']['llm_x'], 'sha256': 'y'}
    monkeypatch.setattr(node_store.account, 'node_index', lambda: index)

    node_store.start()

    assert node_store._providers['provider_x'] == 'llm_x'
    assert len(server['warnings']) == 1 and 'provider_x' in server['warnings'][0]
