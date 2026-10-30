# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The save-time probe sends Milvus's token to a cloud server only.

The running store connects to a local server without a token, but the probe used
to pick the cloud path whenever a key was set, so a key left as an unfilled
${ROCKETRIDE_...} reached a local server at save time.
"""

import importlib.util
import os
import sys
import types

import pytest

_MOD_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'nodes', 'store_milvus', 'IGlobal.py'
)


@pytest.fixture
def probe(monkeypatch):
    """Load the node's IGlobal with pymilvus stubbed; return (instance, recorded connect calls)."""
    calls = []
    pymilvus = types.ModuleType('pymilvus')
    pymilvus.connections = types.SimpleNamespace(connect=lambda **kw: calls.append(kw), disconnect=lambda alias: None)
    pymilvus.utility = types.SimpleNamespace(get_server_version=lambda using=None: '2.4')
    pymilvus.exceptions = types.SimpleNamespace(MilvusException=type('MilvusException', (Exception,), {}))
    depends = types.ModuleType('depends')
    depends.depends = lambda *a, **k: None
    monkeypatch.setitem(sys.modules, 'pymilvus', pymilvus)
    monkeypatch.setitem(sys.modules, 'depends', depends)
    spec = importlib.util.spec_from_file_location('_store_milvus_iglobal_probe', _MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    monkeypatch.setattr(mod, 'warning', lambda msg: calls.append({'warning': msg}))
    return mod.IGlobal.__new__(mod.IGlobal), calls


def test_a_local_server_gets_no_token_even_when_a_key_is_set(probe):
    """A leftover key, placeholder or not, is not sent to a local server."""
    glb, calls = probe
    glb._probe_connection(
        {
            'mode': 'local',
            'host': 'localhost',
            'port': 19530,
            'collection': 'docs',
            'apikey': '${ROCKETRIDE_MILVUS_KEY}',
        }
    )

    assert calls == [{'alias': 'validate', 'host': 'localhost', 'port': 19530, 'timeout': 5}]


def test_a_cloud_server_still_gets_its_token(probe):
    """In cloud mode the probe connects by URI with the token, as before."""
    glb, calls = probe
    glb._probe_connection(
        {'mode': 'cloud', 'host': 'https://x.cloud', 'port': 443, 'collection': 'docs', 'apikey': 'tok'}
    )

    assert calls == [{'alias': 'validate', 'uri': 'https://x.cloud:443', 'token': 'tok', 'timeout': 5}]
