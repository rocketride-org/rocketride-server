# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Network-free unit tests for the db_hydradb node (stub-import pattern).

Stubs rocketlib, ai.common.config, and ai.common.utils.post_with_retry, then loads
the node package via spec_from_file_location so relative imports resolve. Asserts
request building (URL / auth header / body), response parsing, and error paths.
"""

import importlib.util
import json
import os
import sys
import types
from types import SimpleNamespace

import pytest

NODE_DIR = os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes', 'graph_hydradb')
NODE_DIR = os.path.abspath(NODE_DIR)

# ---------------------------------------------------------------------------
# Capture-and-replay stub for the shared HTTP helper
# ---------------------------------------------------------------------------
_POST = SimpleNamespace(calls=[], return_body={}, side_effect=None)


def _stub_post_with_retry(url, *, headers=None, json=None, data=None, files=None, timeout=None, **_kw):
    _POST.calls.append({'url': url, 'headers': headers, 'json': json, 'data': data, 'files': files, 'timeout': timeout})
    if _POST.side_effect is not None:
        raise _POST.side_effect
    resp = SimpleNamespace()
    resp.json = lambda: _POST.return_body
    return resp


_GET = SimpleNamespace(calls=[], return_body={}, bodies_by_path=None, side_effect=None)


def _stub_get(url, *, headers=None, params=None, timeout=None, **_kw):
    _GET.calls.append({'url': url, 'headers': headers, 'params': params, 'timeout': timeout})
    if _GET.side_effect is not None:
        raise _GET.side_effect
    body = _GET.return_body
    if _GET.bodies_by_path:
        for frag, candidate in _GET.bodies_by_path.items():
            if frag in url:
                body = candidate
                break
    resp = SimpleNamespace()
    resp.json = lambda: body
    resp.raise_for_status = lambda: None
    return resp


_WARNINGS = []


def _install_stubs():
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda *_a, **_k: lambda fn: fn
    rocketlib.warning = lambda *a, **_k: _WARNINGS.append(' '.join(str(x) for x in a))
    rocketlib.debug = lambda *_a, **_k: None
    rocketlib.error = lambda *_a, **_k: None
    sys.modules['rocketlib'] = rocketlib

    requests_stub = types.ModuleType('requests')
    requests_stub.exceptions = SimpleNamespace(
        Timeout=TimeoutError, ConnectionError=ConnectionError, HTTPError=Exception, RequestException=Exception
    )
    requests_stub.get = _stub_get
    sys.modules['requests'] = requests_stub

    ai = types.ModuleType('ai')
    ai_common = types.ModuleType('ai.common')
    ai_common_config = types.ModuleType('ai.common.config')
    ai_common_utils = types.ModuleType('ai.common.utils')

    class _Config:
        node_config = {}

        @staticmethod
        def getNodeConfig(_logical_type, _conn_config):
            return dict(_Config.node_config)

    ai_common_config.Config = _Config
    ai_common_utils.post_with_retry = _stub_post_with_retry
    ai_common_utils.get_with_retry = _stub_get

    ai.common = ai_common
    ai_common.config = ai_common_config
    ai_common.utils = ai_common_utils
    sys.modules['ai'] = ai
    sys.modules['ai.common'] = ai_common
    sys.modules['ai.common.config'] = ai_common_config
    sys.modules['ai.common.utils'] = ai_common_utils
    return _Config


def _load_package():
    """Load the node package's modules so relative imports resolve."""
    pkg = types.ModuleType('db_hydradb')
    pkg.__path__ = [NODE_DIR]
    sys.modules['db_hydradb'] = pkg

    def _load(name):
        spec = importlib.util.spec_from_file_location(f'db_hydradb.{name}', os.path.join(NODE_DIR, f'{name}.py'))
        mod = importlib.util.module_from_spec(spec)
        sys.modules[f'db_hydradb.{name}'] = mod
        spec.loader.exec_module(mod)
        return mod

    client_mod = _load('hydradb_client')
    iglobal_mod = _load('IGlobal')
    iinstance_mod = _load('IInstance')
    return client_mod, iglobal_mod, iinstance_mod


@pytest.fixture()
def node():
    _POST.calls.clear()
    _POST.return_body = {}
    _POST.side_effect = None
    _GET.calls.clear()
    _GET.return_body = {}
    _GET.bodies_by_path = None
    _GET.side_effect = None
    _WARNINGS.clear()
    # Snapshot the modules we stub so teardown restores the prior state, not just
    # pops it — a real rocketlib/requests already loaded is put back, not deleted.
    _managed = [
        'db_hydradb',
        'db_hydradb.hydradb_client',
        'db_hydradb.IGlobal',
        'db_hydradb.IInstance',
        'rocketlib',
        'ai',
        'ai.common',
        'ai.common.config',
        'ai.common.utils',
        'requests',
    ]
    _saved = {name: sys.modules.get(name) for name in _managed}
    try:
        Config = _install_stubs()
        client_mod, iglobal_mod, iinstance_mod = _load_package()
        yield SimpleNamespace(
            Config=Config, client_mod=client_mod, iglobal_mod=iglobal_mod, iinstance_mod=iinstance_mod
        )
    finally:
        for name in _managed:
            if _saved[name] is not None:
                sys.modules[name] = _saved[name]
            else:
                sys.modules.pop(name, None)


def _make_instance(iinstance_mod, client):
    inst = iinstance_mod.IInstance()
    inst.IGlobal = SimpleNamespace(client=client, max_results=10, database='acme')
    return inst


# ---------------------------------------------------------------------------
# hydradb_client
# ---------------------------------------------------------------------------


def test_store_memory_builds_ingest_request(node):
    client = node.client_mod.HydraDBClient('secret-key', 'acme', collection='team')
    _POST.return_body = {'ingested': 1}
    out = client.store_memory('hello world', metadata={'k': 'v'})

    assert out == {'ingested': 1}
    call = _POST.calls[-1]
    assert call['url'] == 'https://api.hydradb.com/context/ingest'
    assert call['headers']['Authorization'] == 'Bearer secret-key'
    # Ingest is multipart/form-data: no JSON body, and no Content-Type override
    # (requests sets the multipart boundary itself).
    assert call['json'] is None
    assert 'Content-Type' not in call['headers']
    form = {k: value for k, (_filename, value) in call['files'].items()}
    assert form['type'] == 'memory'
    assert form['database'] == 'acme'
    assert form['collection'] == 'team'
    assert form['infer'] == 'true' and form['upsert'] == 'true'
    memories = json.loads(form['memories'])
    assert memories == [{'text': 'hello world', 'metadata': {'k': 'v'}}]


def test_query_builds_unified_request(node):
    client = node.client_mod.HydraDBClient('k', 'acme', collection='team')
    _POST.return_body = {'chunks': [{'chunk_content': 'x', 'relevancy_score': 0.9}]}
    client.query('who owns billing?', type='all', max_results=7)

    call = _POST.calls[-1]
    assert call['url'] == 'https://api.hydradb.com/query'
    body = call['json']
    assert body['database'] == 'acme'
    assert body['query'] == 'who owns billing?'
    assert body['type'] == 'all'
    assert body['max_results'] == 7
    assert body['collection'] == 'team'


def test_client_errors_map_to_hydradberror(node):
    client = node.client_mod.HydraDBClient('k', 'acme')
    _POST.side_effect = ConnectionError('boom')
    with pytest.raises(node.client_mod.HydraDBError):
        client.query('anything')


def test_extract_results_handles_shapes(node):
    HydraDBClient = node.client_mod.HydraDBClient
    assert HydraDBClient.extract_results({'chunks': [1, 2]}) == [1, 2]
    assert HydraDBClient.extract_results({'results': [3]}) == [3]
    assert HydraDBClient.extract_results({'nope': 1}) == []
    assert HydraDBClient.extract_results('bad') == []


# ---------------------------------------------------------------------------
# IInstance tool surface
# ---------------------------------------------------------------------------


def test_store_memory_tool_happy_path(node):
    client = node.client_mod.HydraDBClient('k', 'acme')
    inst = _make_instance(node.iinstance_mod, client)
    _POST.return_body = {'ingested': 1}
    out = inst.store_memory({'text': 'remember this'})
    assert out['status'] == 'ok'
    assert _POST.calls[-1]['url'].endswith('/context/ingest')


def test_recall_memory_tool_extracts_results(node):
    client = node.client_mod.HydraDBClient('k', 'acme')
    inst = _make_instance(node.iinstance_mod, client)
    _POST.return_body = {'chunks': [{'chunk_content': 'a'}, {'chunk_content': 'b'}]}
    out = inst.recall_memory({'query': 'ping'})
    assert out['results'] == [{'chunk_content': 'a'}, {'chunk_content': 'b'}]
    assert _POST.calls[-1]['json']['type'] == 'all'


def test_store_memory_requires_text(node):
    inst = _make_instance(node.iinstance_mod, node.client_mod.HydraDBClient('k', 'acme'))
    with pytest.raises(ValueError):
        inst.store_memory({'text': '   '})
    with pytest.raises(ValueError):
        inst.store_memory('not a dict')


def test_recall_memory_requires_query(node):
    inst = _make_instance(node.iinstance_mod, node.client_mod.HydraDBClient('k', 'acme'))
    with pytest.raises(ValueError):
        inst.recall_memory({})
    with pytest.raises(ValueError):
        inst.recall_memory({'query': 'ok', 'max_results': True})


def test_iglobal_validate_warns_without_key(node):
    node.Config.node_config = {'database': 'acme'}  # no api_key
    os.environ.pop('HYDRA_DB_API_KEY', None)
    g = node.iglobal_mod.IGlobal()
    g.glb = SimpleNamespace(logicalType='db_hydradb', connConfig={})
    g.validateConfig()
    assert any('API key' in w for w in _WARNINGS)


def test_iglobal_endglobal_clears_key(node):
    node.Config.node_config = {'api_key': 'topsecret', 'database': 'acme'}
    g = node.iglobal_mod.IGlobal()
    g.glb = SimpleNamespace(logicalType='db_hydradb', connConfig={})
    g.beginGlobal()
    assert g.client is not None and g.client.api_key == 'topsecret'
    g.endGlobal()
    assert g.client is None


# ---------------------------------------------------------------------------
# Phase 2: query_graph + get_schema (GET endpoints)
# ---------------------------------------------------------------------------


def test_query_graph_builds_relations_get(node):
    client = node.client_mod.HydraDBClient('k', 'acme', collection='team')
    inst = _make_instance(node.iinstance_mod, client)
    _GET.return_body = {'data': {'entities': [{'entity_id': 'e1'}], 'relationships': []}}
    out = inst.query_graph({'source_id': 'doc_1'})

    call = _GET.calls[-1]
    assert call['url'] == 'https://api.hydradb.com/context/relations'
    assert call['params']['database'] == 'acme'
    assert call['params']['id'] == 'doc_1'
    assert call['params']['collection'] == 'team'
    assert out['relations'] == {'entities': [{'entity_id': 'e1'}], 'relationships': []}


def test_get_schema_combines_collections_and_status(node):
    client = node.client_mod.HydraDBClient('k', 'acme')
    inst = _make_instance(node.iinstance_mod, client)
    _GET.bodies_by_path = {
        '/databases/collections': {'data': {'collections': ['user_alex', 'workspace_42']}},
        '/databases/status': {'data': {'infra': {'ready_for_ingestion': True}}},
    }
    out = inst.get_schema({})

    assert out['database'] == 'acme'
    assert out['collections'] == ['user_alex', 'workspace_42']
    assert out['infra'] == {'ready_for_ingestion': True}
    urls = [c['url'] for c in _GET.calls]
    assert any(u.endswith('/databases/collections') for u in urls)
    assert any(u.endswith('/databases/status') for u in urls)


def test_get_requests_map_errors(node):
    client = node.client_mod.HydraDBClient('k', 'acme')
    _GET.side_effect = ConnectionError('down')
    with pytest.raises(node.client_mod.HydraDBError):
        client.collections()


def test_unwrap_envelope(node):
    HydraDBClient = node.client_mod.HydraDBClient
    assert HydraDBClient.unwrap({'data': {'x': 1}}) == {'x': 1}
    assert HydraDBClient.unwrap({'x': 1}) == {'x': 1}
    assert HydraDBClient.unwrap('bad') == {}


def test_query_graph_rejects_bad_source_id(node):
    inst = _make_instance(node.iinstance_mod, node.client_mod.HydraDBClient('k', 'acme'))
    with pytest.raises(ValueError):
        inst.query_graph({'source_id': 123})
