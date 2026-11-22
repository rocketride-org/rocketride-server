# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The Firestore node's collection is a per-call parameter (plan 4.1 rule 4).

The tools take a ``collection`` argument and fall back to the call's
``collection`` setting, never to a value the IGlobal snapshotted. The node's
``IGlobal`` installs and imports the Google client, so these tests load
``IInstance.py`` against a stand-in ``IGlobal`` module and a fake client.
"""

import importlib
import sys
import types
from pathlib import Path

import pytest

NODE_DIR = Path(__file__).resolve().parents[1] / 'src' / 'nodes' / 'db_firestore'


@pytest.fixture(scope='module')
def IInstance():
    """Load db_firestore/IInstance.py with a stand-in IGlobal module (no Google client install)."""
    names = ('db_firestore', 'db_firestore.IGlobal', 'db_firestore.IInstance')
    saved = {name: sys.modules.get(name) for name in names}
    package = types.ModuleType('db_firestore')
    package.__path__ = [str(NODE_DIR)]
    iglobal = types.ModuleType('db_firestore.IGlobal')
    iglobal.IGlobal = type('IGlobal', (), {})
    sys.modules['db_firestore'] = package
    sys.modules['db_firestore.IGlobal'] = iglobal
    try:
        yield importlib.import_module('db_firestore.IInstance').IInstance
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


class _FakeClient:
    """Records the collection each document call names."""

    def __init__(self):
        self.collections = []

    def collection(self, name):
        self.collections.append(name)
        document = types.SimpleNamespace(set=lambda data, merge: None, get=lambda: types.SimpleNamespace(exists=False))
        return types.SimpleNamespace(document=lambda _id: document)


def _instance(IInstance, iglobal, collection):
    inst = IInstance.__new__(IInstance)
    inst.IGlobal = iglobal
    inst._settings = {'collection': collection}
    return inst


def test_two_calls_on_one_global_use_their_own_collection(IInstance):
    iglobal = types.SimpleNamespace(client=_FakeClient())
    orders = _instance(IInstance, iglobal, 'orders')
    invoices = _instance(IInstance, iglobal, 'invoices')

    orders.set_document({'document_id': 'd1', 'data': {'a': 1}})
    invoices.set_document({'document_id': 'd2', 'data': {'a': 2}})
    orders.get_document({'document_id': 'd1'})

    assert iglobal.client.collections == ['orders', 'invoices', 'orders']


def test_a_tool_argument_overrides_the_calls_collection(IInstance):
    iglobal = types.SimpleNamespace(client=_FakeClient())
    inst = _instance(IInstance, iglobal, 'orders')

    inst.get_document({'collection': 'audit', 'document_id': 'd1'})

    assert iglobal.client.collections == ['audit']
