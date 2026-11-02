"""Shared fixtures for the rocketride_vector unit tests (#2587)."""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, Mock

import pytest

from .._store_base_stubs import store_base_stubs

NODE_DIR = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'rocketride_vector'


@pytest.fixture
def node_modules(monkeypatch: pytest.MonkeyPatch):
    """Load the node's IGlobal and IInstance with small engine-runtime stubs.

    Returns ``(IGlobal module, IInstance module, stubs)``. ``stubs`` carries the
    mocks a test can inspect or program: ``warning``, ``resolve_dsn``, the
    driver ``Store`` class, ``depends`` and the psycopg2 ``connect``. The shared
    store base is stood in for by ``_store_base_stubs`` (the hook contract and
    the switch defaults); the base itself is covered in packages/ai.
    """
    package_name = f'_rocketride_vector_test_{id(monkeypatch)}'
    package = types.ModuleType(package_name)
    package.__path__ = [str(NODE_DIR)]
    monkeypatch.setitem(sys.modules, package_name, package)

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.warning = Mock()
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG='config')
    rocketlib.Entry = object
    rocketlib.IGlobalBase = object
    rocketlib.IInstanceBase = object
    rocketlib.tool_function = lambda **_kwargs: lambda function: function
    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)

    store_module = store_base_stubs()
    StoreInstanceBase = store_module.StoreInstanceBase
    db_spec = importlib.util.spec_from_file_location(
        'ai.common.rocketride_db', NODE_DIR.parents[3] / 'packages/ai/src/ai/common/rocketride_db.py'
    )
    db_module = importlib.util.module_from_spec(db_spec)
    db_spec.loader.exec_module(db_module)
    db_module.resolve_rocketride_dsn = Mock(return_value='postgresql://u:p@pool:5432/tenant_db')
    depends_module = types.ModuleType('depends')
    depends_module.depends = Mock()
    psycopg2 = types.ModuleType('psycopg2')
    # MagicMock: the probe uses the cursor as a context manager.
    psycopg2.connect = MagicMock()
    psycopg2.OperationalError = type('OperationalError', (Exception,), {})
    psycopg2.ProgrammingError = type('ProgrammingError', (Exception,), {})
    for name, module in {
        'ai': types.ModuleType('ai'),
        'ai.common': types.ModuleType('ai.common'),
        'ai.common.store': store_module,
        'ai.common.rocketride_db': db_module,
        'depends': depends_module,
        'psycopg2': psycopg2,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)

    # The driver module is imported lazily inside _open_store; stand it in so
    # the test never needs a database.
    store_cls = Mock(name='Store')
    driver = types.ModuleType(f'{package_name}.rocketride_vector')
    driver.Store = store_cls
    monkeypatch.setitem(sys.modules, f'{package_name}.rocketride_vector', driver)

    def load(name: str):
        qualified_name = f'{package_name}.{name}'
        spec = importlib.util.spec_from_file_location(qualified_name, NODE_DIR / f'{name}.py')
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, qualified_name, module)
        spec.loader.exec_module(module)
        return module

    iglobal = load('IGlobal')
    iinstance = load('IInstance')
    stubs = types.SimpleNamespace(
        warning=rocketlib.warning,
        resolve_dsn=db_module.resolve_rocketride_dsn,
        DsnNotDelivered=db_module.DsnNotDelivered,
        Store=store_cls,
        depends=depends_module.depends,
        connect=psycopg2.connect,
        StoreInstanceBase=StoreInstanceBase,
    )
    return iglobal, iinstance, stubs
