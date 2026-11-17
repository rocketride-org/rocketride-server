# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Load the REAL shared bases Database and Vector reuse, without the engine.

Database is db_postgres's IGlobal / IInstance on ``ai.common.database``, and
Vector is store_postgres's on ``ai.common.store``. Stubbing those bases would
test nothing, so this helper executes the real files from ``packages/ai``:

* ``ai/common/config.py`` (the real ``Config.getNodeConfig`` profile merge),
  with ``rocketlib.getServiceDefinition`` answering from a dict of parsed
  services files the test controls;
* ``ai/common/database/`` (``DatabaseGlobalBase``, ``DatabaseInstanceBase``,
  ``tx_registry``, ``sql_safety``); needs SQLAlchemy;
* ``ai/common/store/`` (``StoreGlobalBase``, ``StoreInstanceBase``,
  ``VectorStoreToolMixin``, ``PgVectorStoreBase``); needs numpy.

Only engine-side modules are stand-ins: ``rocketlib`` (from ``engine_stubs``,
plus the few names these files import), ``ai.common.schema`` /
``ai.common.table`` (plain classes), ``ai.common.transform`` (the transform
key is engine state) and, when ``drivers=True``, ``psycopg2`` / ``pgvector``
(placeholders bound at import; each test fakes ``psycopg2.connect`` itself).

Everything is undone on exit: ``ai.*``, ``rocketlib*`` and the
``nodes.db_postgres*`` / ``nodes.store_postgres*`` modules return to what
``sys.modules`` held before, so other tests import their own fresh copies.
"""

from __future__ import annotations

import contextlib
import importlib.util
import sys
import types
from pathlib import Path
from typing import Any, Dict, Iterator, List

from .._support import engine_stubs

_AI_COMMON = Path(__file__).resolve().parents[4] / 'packages' / 'ai' / 'src' / 'ai' / 'common'

#: Connections ``pgvector.psycopg2.register_vector`` was called with (drivers=True placeholder).
REGISTERED_VECTOR: List[Any] = []

_NODE_PREFIXES = ('nodes.db_postgres', 'nodes.store_postgres')


def _owned(name: str, drivers: bool) -> bool:
    if name in ('ai', 'rocketlib', 'rocketlib.types') or name.startswith('ai.'):
        return True
    if drivers and (name == 'psycopg2' or name == 'pgvector' or name.startswith('pgvector.')):
        return True
    return any(name == p or name.startswith(p + '.') for p in _NODE_PREFIXES)


def _exec(name: str, path: Path, *, package_dir: Path = None) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(
        name, path, submodule_search_locations=[str(package_dir)] if package_dir else None
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


class _IJson:
    """Test configs are plain dicts already; the engine's IJson normalizes its own values."""

    @staticmethod
    def toDict(value: Any) -> Any:
        return value


def _schema_module() -> types.ModuleType:
    module = types.ModuleType('ai.common.schema')
    for name in ('Doc', 'DocFilter', 'DocMetadata', 'Question', 'QuestionText', 'Answer'):
        setattr(module, name, type(name, (), {}))
    module.QuestionType = type('QuestionType', (), {'SEMANTIC': 'semantic', 'KEYWORD': 'keyword'})
    return module


def _transform_module(rocketlib: types.ModuleType) -> types.ModuleType:
    module = types.ModuleType('ai.common.transform')

    class IGlobalTransform(rocketlib.IGlobalBase):
        transform_key = None

        def beginGlobal(self, subKey: str = '') -> None:
            self.transform_key = subKey

        def endGlobal(self) -> None:
            self.transform_key = None

        def getConnConfig(self):
            return self.glb.connConfig

    class IInstanceTransform(rocketlib.IInstanceBase):
        def open(self, object: Any) -> None:
            return None

    module.IGlobalTransform = IGlobalTransform
    module.IInstanceTransform = IInstanceTransform
    module.IEndpointTransform = type('IEndpointTransform', (rocketlib.IEndpointBase,), {})
    return module


def _install_drivers() -> None:
    psycopg2 = types.ModuleType('psycopg2')

    def connect(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError('psycopg2.connect was not faked by the test')

    psycopg2.connect = connect
    pgvector = types.ModuleType('pgvector')
    pgvector.__path__ = []
    pgvector_psycopg2 = types.ModuleType('pgvector.psycopg2')
    pgvector_psycopg2.register_vector = REGISTERED_VECTOR.append
    sys.modules.update({'psycopg2': psycopg2, 'pgvector': pgvector, 'pgvector.psycopg2': pgvector_psycopg2})


@contextlib.contextmanager
def real_engine(services: Dict[str, Dict[str, Any]], *, drivers: bool = False) -> Iterator[Dict[str, Any]]:
    """Install the real ai.common config/database/store over engine stubs; restore sys.modules after.

    ``services`` maps a logical type (the test's ``glb.logicalType``) to its
    parsed services file; it is read at call time, so a test may change it.
    """
    saved = {name: module for name, module in sys.modules.items() if _owned(name, drivers)}
    for name in list(saved):
        if name.startswith(_NODE_PREFIXES):
            del sys.modules[name]
    try:
        with engine_stubs() as stubs:
            rocketlib = stubs['rocketlib']
            rocketlib.IJson = _IJson
            rocketlib.getServiceDefinition = lambda logical_type: services.get(logical_type)
            rocketlib.Entry = type('Entry', (), {})
            rocketlib.SERVICE_MODE = type('SERVICE_MODE', (), {})
            rocketlib.OPEN_MODE.TRANSFORM = 'transform'
            rocketlib_types = types.ModuleType('rocketlib.types')
            rocketlib_types.IInvokeLLM = type('IInvokeLLM', (), {})
            sys.modules['rocketlib.types'] = rocketlib_types

            stubs['ai.common'].config = _exec('ai.common.config', _AI_COMMON / 'config.py')
            sys.modules['ai.common.schema'] = _schema_module()
            sys.modules['ai.common.table'] = types.ModuleType('ai.common.table')
            sys.modules['ai.common.table'].Table = type('Table', (), {})
            sys.modules['ai.common.transform'] = _transform_module(rocketlib)
            _exec('ai.common.database', _AI_COMMON / 'database' / '__init__.py', package_dir=_AI_COMMON / 'database')
            _exec('ai.common.store', _AI_COMMON / 'store' / '__init__.py', package_dir=_AI_COMMON / 'store')
            if drivers:
                _install_drivers()
            yield stubs
    finally:
        for name in [name for name in sys.modules if _owned(name, drivers)]:
            del sys.modules[name]
        sys.modules.update(saved)
