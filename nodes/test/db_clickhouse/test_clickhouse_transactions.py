# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The ClickHouse node tells agents an ``execute`` call is not a transaction.

clickhouse-sqlalchemy's native connector makes ``commit`` and ``rollback``
no-ops and ClickHouse has no savepoints, so ``IInstance`` overrides the shared
``_callsAreTransactions`` hook. The shared ``execute`` description reads it;
its wording is covered by ``packages/ai/tests/database/test_execute_one_transaction.py``.
This pins that the real node opts out, so an agent reading the ClickHouse
tool is never told a failed statement undoes the ones before it.
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


def test_clickhouse_calls_are_not_transactions(IInstance):
    """The node overrides the hook the shared description reads."""
    inst = IInstance.__new__(IInstance)

    assert inst._callsAreTransactions() is False


def test_clickhouse_execute_promises_no_rollback(IInstance):
    """``execute`` says a failed statement undoes nothing, and there is no session tool to say otherwise."""
    inst = IInstance.__new__(IInstance)

    description = _describe(inst, 'execute')
    assert 'ClickHouse has no transactions' in description
    assert 'rolls back' not in description
    for name in ('begin', 'commit', 'rollback'):
        assert not hasattr(IInstance, name)
