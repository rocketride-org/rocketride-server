# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Supabase Database: the former db_postgres Supabase preset, moved unchanged.

Decision 1: a pipeline saved with today's preset (only ``postgresdb.*``
values, shape ``{profile: 'default', default: {...}}``) must load through the
new service and build the same connection. These tests drive the REAL
``Config.getNodeConfig`` and the REAL ``DatabaseGlobalBase`` /
``DatabaseInstanceBase`` (see ``_real_engine``); only SQLAlchemy's
``create_engine`` is replaced, by an in-memory SQLite engine, so ``execute``
really runs a statement. ``legacy_services.supabase.json`` is a verbatim copy
of ``db_postgres/services.supabase.json`` as it was on develop (84b24014b)
before it was removed.
"""

from __future__ import annotations

import urllib.parse
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip('sqlalchemy')
pytest.importorskip('json5')

import sqlalchemy  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from .._support import FAKE_DB_PASSWORD, FAKE_REF, LOGS, NODES_SRC, assert_no_secrets, load_jsonc, load_service  # noqa: E402
from ._real_engine import real_engine  # noqa: E402

LEGACY = load_jsonc(Path(__file__).with_name('legacy_services.supabase.json'))
NEW = load_service('database')

# What getServiceDefinition answers for logical type 'db_supabase'; tests swap it.
SERVICES = {'db_supabase': NEW}

with real_engine(SERVICES):
    import nodes.db_postgres as database_pkg
    from nodes.db_postgres.IGlobal import IGlobal as PostgresGlobal
    from nodes.db_postgres.IInstance import IInstance

# The service's path is nodes.db_postgres: the engine runs these very classes.
IGlobal = PostgresGlobal

HOST = 'aws-0-eu-west-1.pooler.supabase.com:6543'
USER = f'postgres.{FAKE_REF}'

#: A node exactly as today's preset saves it: the hidden profile selector plus
#: the postgresdb.default object, no supabase.* key anywhere.
SAVED = {
    'profile': 'default',
    'default': {
        'host': HOST,
        'user': USER,
        'password': FAKE_DB_PASSWORD,
        'database': 'postgres',
        'table': 'orders',
        'db_description': 'Orders and customers of the web shop.',
        'max_attempts': 7,
        'allow_execute': False,
    },
}

EXPECTED_URL = (
    f'postgresql+psycopg2://{urllib.parse.quote_plus(USER)}:{urllib.parse.quote_plus(FAKE_DB_PASSWORD)}@{HOST}/postgres'
)

TOOLS = {'get_data', 'get_schema', 'get_sql', 'execute', 'begin', 'commit', 'rollback', 'dialect', 'refresh_schema'}


@pytest.fixture
def engine(monkeypatch):
    """Real ai.common modules for the runtime imports, and create_engine -> SQLite."""
    created = []

    def create_engine(url, **kwargs):
        created.append((url, kwargs))
        db = sqlalchemy.create_engine('sqlite://', poolclass=StaticPool, connect_args={'check_same_thread': False})
        with db.begin() as conn:
            conn.execute(sqlalchemy.text('CREATE TABLE orders (id INTEGER PRIMARY KEY, item TEXT)'))
            conn.execute(sqlalchemy.text("INSERT INTO orders (item) VALUES ('tea'), ('cake')"))
        return db

    # The module globals of the real db_global_base, which beginGlobal reads create_engine from.
    monkeypatch.setitem(PostgresGlobal.beginGlobal.__globals__, 'create_engine', create_engine)
    LOGS.clear()
    with real_engine(SERVICES):
        yield created


def _begin(global_cls, conn_config):
    glb = global_cls()
    glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode='source', bag={}))
    glb.glb = SimpleNamespace(logicalType='db_supabase', connConfig=conn_config)
    glb.beginGlobal()
    return glb


def _saved(**overrides):
    out = {'profile': 'default', 'default': dict(SAVED['default'])}
    out['default'].update(overrides)
    return out


# -----------------------------------------------------------------------------
# services.database.json
# -----------------------------------------------------------------------------


def test_service_is_the_old_preset_with_only_documentation_and_description_changed():
    # description: the old last sentence promised TLS, which db_postgres's DSN
    # (no sslmode, so "prefer") does not enforce. Text only: saved pipelines
    # do not store it.
    changed = {'documentation', 'description'}
    assert {k: v for k, v in NEW.items() if k not in changed} == {k: v for k, v in LEGACY.items() if k not in changed}
    assert NEW['path'] == LEGACY['path'] == 'nodes.db_postgres'
    assert NEW['description'][:-1] == LEGACY['description'][:-1]
    assert 'TLS is not forced (sslmode=prefer)' in NEW['description'][-1]
    assert 'encrypted over TLS' not in ''.join(NEW['description'])
    assert NEW['documentation'] == 'https://docs.rocketride.org/nodes/supabase/database'
    assert NEW['protocol'] == 'db_supabase://'


def test_service_has_no_supabase_fields_and_no_access_level():
    assert all(field.startswith('postgresdb.') for field in NEW['fields'])
    assert NEW['shape'][0]['properties'] == ['postgresdb.profile']
    assert NEW['preconfig'] == {'default': 'default', 'profiles': {'default': {'database': 'postgres'}}}
    assert NEW['fields']['postgresdb.allow_execute']['default'] is False
    assert NEW['fields']['postgresdb.password']['secure'] is True


def test_old_preset_is_removed_and_the_protocol_is_declared_once():
    nodes_dir = NODES_SRC / 'nodes'
    assert not (nodes_dir / 'db_postgres' / 'services.supabase.json').exists()
    assert not (nodes_dir / 'db_postgres' / 'supabase.svg').exists()
    assert (nodes_dir / 'supabase' / 'supabase.svg').exists()
    # Two files with one protocol: the engine silently keeps the last one loaded.
    declaring = [
        str(path.relative_to(nodes_dir))
        for path in nodes_dir.rglob('services*.json')
        if '"db_supabase://"' in path.read_text(encoding='utf-8')
    ]
    assert declaring == ['supabase/services.database.json']


# -----------------------------------------------------------------------------
# Code reuse
# -----------------------------------------------------------------------------


def test_the_service_runs_db_postgres_itself():
    # No wrapper package: the engine imports the path, and the path is db_postgres.
    assert database_pkg.IGlobal is IGlobal and database_pkg.IInstance is IInstance
    assert not (NODES_SRC / 'nodes' / 'supabase' / 'database' / '__init__.py').exists()


def test_tools_are_the_nine_db_postgres_tools():
    tools = {name for name in dir(IInstance) if hasattr(getattr(IInstance, name), '__tool_meta__')}
    assert tools == TOOLS


# -----------------------------------------------------------------------------
# Backward compatibility: a pipeline saved with today's preset
# -----------------------------------------------------------------------------


@pytest.mark.parametrize('allow_execute, expected', [(False, False), (True, True), ('true', True), ('false', False)])
def test_saved_preset_config_loads_and_builds_the_same_connection(engine, allow_execute, expected):
    glb = _begin(IGlobal, _saved(allow_execute=allow_execute))

    assert engine[-1][0] == EXPECTED_URL
    assert glb.database == 'postgres'
    assert glb.table == 'orders'
    assert glb.db_description == 'Orders and customers of the web shop.'
    assert glb.max_validation_attempts == 7
    assert glb.allow_execute is expected
    # No login, no secret key, no unknown-key warning from the real Config.
    assert not [m for _, m in LOGS if 'unknown config key' in m]
    assert_no_secrets([m for _, m in LOGS])


def test_new_service_connects_exactly_like_the_old_preset(engine, monkeypatch):
    new = _begin(IGlobal, _saved(allow_execute=True))
    monkeypatch.setitem(SERVICES, 'db_supabase', LEGACY)
    old = _begin(PostgresGlobal, _saved(allow_execute=True))

    assert engine[0] == engine[1]  # same DSN and pool settings
    for attr in ('database', 'table', 'db_description', 'max_validation_attempts', 'allow_execute'):
        assert getattr(new, attr) == getattr(old, attr), attr


def test_preset_defaults_fill_a_saved_node_without_database(engine):
    saved = _saved()
    del saved['default']['database']
    glb = _begin(IGlobal, saved)
    assert glb.database == 'postgres'
    assert engine[-1][0].endswith('/postgres')


def test_execute_runs_when_the_saved_node_has_allow_execute_on(engine):
    glb = _begin(IGlobal, _saved(allow_execute=True))
    inst = IInstance()
    inst.IGlobal = glb
    result = inst.execute({'sql': 'SELECT item FROM orders ORDER BY id'})
    assert result['rows'] == [{'item': 'tea'}, {'item': 'cake'}]
    glb.endGlobal()


def test_execute_is_refused_when_allow_execute_is_off(engine):
    glb = _begin(IGlobal, _saved(allow_execute=False))
    inst = IInstance()
    inst.IGlobal = glb
    with pytest.raises(ValueError, match='execute tool is disabled'):
        inst.execute({'sql': 'DELETE FROM orders'})
    glb.endGlobal()
