# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""EaaS keeps the nodes the server does not carry: their definitions for the engine's calls, their packages for a run."""

import base64
import json
import pathlib
import re

import pytest

from ai.constants import CONST_NODES_CONTRACT
from ai.modules.task import node_store

ON_DISK = {'protocol': 'webhook://', 'icon': 'webhook.svg'}
PACKAGED = {'protocol': 'provider_x://', 'icon': 'x.svg', 'maximum': 1.0}
X_ICON = 'data:image/svg+xml;base64,' + base64.b64encode(b'<svg id="x"/>').decode()


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
    calls = {'parsed': [], 'unpacked': [], 'warnings': [], 'nodes': str(tmp_path)}
    monkeypatch.setattr(node_store, '_nodes', {})
    monkeypatch.setattr(node_store, '_providers', {})
    monkeypatch.setattr(node_store, '_definitions', {})
    monkeypatch.setattr(node_store, 'getServiceDefinition', lambda p: {'on': 'disk'} if p == 'webhook' else None)
    monkeypatch.setattr(node_store, 'getServiceDefinitions', calls['parsed'].append)
    monkeypatch.setattr(node_store, 'warning', calls['warnings'].append)
    monkeypatch.setattr(node_store.account, 'node_index', lambda: _index())
    monkeypatch.setattr(node_store.account, 'node_package', lambda name, sha256: f'{name}:{sha256}'.encode())
    monkeypatch.setattr(node_store.node_release, 'nodes_dir', lambda: str(tmp_path))
    monkeypatch.setattr(
        node_store.node_packages, 'unpack', lambda *args: calls['unpacked'].append(args) or f'{args[3]}/{args[0]}'
    )
    return calls


def test_only_the_nodes_not_on_disk_are_kept_with_their_icon_inline(server):
    node_store.start()

    expected = {**PACKAGED, 'icon': X_ICON}
    assert node_store.custom() == [expected]
    assert isinstance(node_store.custom()[0]['maximum'], float)
    # The engine parsed them once, at start
    assert server['parsed'] == [[expected]]
    assert server['warnings'] == []


def test_only_a_node_eaas_serves_has_a_served_definition(server):
    node_store.start()

    assert node_store.served('provider_x') == {**PACKAGED, 'icon': X_ICON}
    assert node_store.served('webhook') is None and node_store.served('filesys') is None


def test_an_icon_the_index_does_not_hold_is_dropped(server, monkeypatch):
    index = _index()
    index['nodes']['llm_x']['icons'] = {}
    monkeypatch.setattr(node_store.account, 'node_index', lambda: index)

    node_store.start()

    assert node_store.custom() == [{'protocol': 'provider_x://', 'maximum': 1.0}]


@pytest.mark.parametrize('broken', ['contract', 'unavailable', 'malformed', 'refused'])
def test_an_index_it_cannot_use_serves_nothing(server, monkeypatch, broken):
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
            raise RuntimeError('The icon of provider_x must be inline (a data: URL)')

        monkeypatch.setattr(node_store, 'getServiceDefinitions', refuse)

    node_store.start()

    assert node_store.custom() == [] and node_store.place({'components': [{'provider': 'provider_x'}]}) == []
    assert len(server['warnings']) == 1


def test_a_run_gets_on_disk_only_the_nodes_its_pipeline_names_that_the_server_lacks(server):
    node_store.start()

    placed = node_store.place({'components': [{'provider': 'webhook'}, {'provider': 'provider_x'}]})

    assert placed == ['llm_x']
    assert server['unpacked'] == [('llm_x', b'llm_x:x', 'x', server['nodes'])]


def test_a_pipeline_that_names_no_served_node_unpacks_nothing(server):
    node_store.start()

    assert node_store.place({'components': [{'provider': 'webhook'}, {'provider': 'filesys'}]}) == []
    assert server['unpacked'] == []


def test_the_filters_autopipe_inserts_are_on_disk_before_the_run(server, monkeypatch):
    index = _index()
    for provider in ('ocr', 'embedding_y'):
        index['nodes'][provider] = {
            'sha256': provider,
            'services': {'services.json': json.dumps({'protocol': f'{provider}://'})},
            'icons': {},
        }
    monkeypatch.setattr(node_store.account, 'node_index', lambda: index)
    node_store.start()

    autopipe = {'provider': 'autopipe', 'config': {'embedding': {'provider': 'embedding_y'}}}
    placed = node_store.place({'components': [autopipe]})

    assert placed == ['embedding_y', 'ocr']


def test_a_package_that_cannot_be_read_fails_the_launch(server, monkeypatch):
    node_store.start()

    def offline(name, sha256):
        raise FileNotFoundError('llm_x.rrnode is not in releases server-v1')

    monkeypatch.setattr(node_store.account, 'node_package', offline)

    with pytest.raises(FileNotFoundError):
        node_store.place({'components': [{'provider': 'provider_x'}]})


def test_a_provider_two_nodes_claim_is_served_by_the_first_and_warned_about(server, monkeypatch):
    index = _index()
    index['nodes']['llm_y'] = {**index['nodes']['llm_x'], 'sha256': 'y'}
    monkeypatch.setattr(node_store.account, 'node_index', lambda: index)

    node_store.start()

    assert node_store._providers['provider_x'] == 'llm_x'
    assert node_store.custom() == [{**PACKAGED, 'icon': X_ICON}]
    assert len(server['warnings']) == 1 and 'provider_x' in server['warnings'][0]


def test_a_read_only_install_serves_nothing_and_says_so_once(server, monkeypatch):
    def read_only(dir=None, **kwargs):
        # What a read-only mount answers; a chmod cannot make a folder read-only on Windows
        raise OSError(30, 'Read-only file system', dir)

    monkeypatch.setattr(node_store.tempfile, 'NamedTemporaryFile', read_only)

    node_store.start()

    assert node_store.custom() == [] and node_store.place({'components': [{'provider': 'provider_x'}]}) == []
    assert len(server['warnings']) == 1
    assert 'not writable' in server['warnings'][0] and 'llm_x' in server['warnings'][0]


def test_the_autopipe_filters_are_the_ones_autopipe_inserts():
    source = pathlib.Path(__file__).resolve().parents[6] / 'nodes' / 'src' / 'nodes' / 'autopipe' / 'IGlobal.py'
    inserted = set(re.findall(r"getFilter\('[^']+', '([^']+)'", source.read_text(encoding='utf-8')))

    assert inserted and inserted == set(node_store._AUTOPIPE_FILTERS)
