# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The ClickHouse node tells agents its sessions are not transactions.

clickhouse-sqlalchemy's native connector makes ``commit`` and ``rollback``
no-ops and ClickHouse has no savepoints, so ``IInstance`` overrides the shared
``_sessionsAreTransactions`` hook. The shared tool descriptions and errors read
it; their wording is covered by ``packages/ai/tests/database/test_execute_session.py``.
This pins that the real node opts out, so an agent reading the ClickHouse
tools is never told its work can be rolled back.
"""

import importlib
import sys
import types
from pathlib import Path

import pytest

from ai.common.database import DatabaseInstanceBase

NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'db_clickhouse'


@pytest.fixture(scope='module')
def IInstance():
    """Load db_clickhouse/IInstance.py without running the package ``__init__``.

    The ``__init__`` calls ``depends()``, which installs the node's driver
    requirements; this test needs none of them. A bare package module with the
    node directory as its path lets ``IInstance``'s relative import of
    ``IGlobal`` resolve, and ``sys.modules`` is restored afterwards.
    """
    names = ('db_clickhouse', 'db_clickhouse.IGlobal', 'db_clickhouse.IInstance')
    saved = {name: sys.modules.get(name) for name in names}
    package = types.ModuleType('db_clickhouse')
    package.__path__ = [str(NODE_DIR)]
    sys.modules['db_clickhouse'] = package
    try:
        yield importlib.import_module('db_clickhouse.IInstance').IInstance
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def _describe(inst, name):
    """The description an agent reads for one of the node's tools."""
    return getattr(DatabaseInstanceBase, name).__tool_meta__['description'](inst)


def test_clickhouse_sessions_are_not_transactions(IInstance):
    """The node overrides the hook the shared descriptions read."""
    inst = IInstance.__new__(IInstance)

    assert inst._sessionsAreTransactions() is False


def test_clickhouse_tools_promise_no_rollback(IInstance):
    """``execute``, ``begin``, ``commit`` and ``rollback`` all say what a session really is."""
    inst = IInstance.__new__(IInstance)

    assert 'A session on ClickHouse opens no transaction' in _describe(inst, 'execute')
    assert 'rollback to savepoint' not in _describe(inst, 'execute')
    assert _describe(inst, 'begin').startswith('Reserve a connection on this ClickHouse database')
    assert _describe(inst, 'commit').startswith('Close a session.')
    assert _describe(inst, 'rollback').startswith('Close a session. This undoes nothing')
