# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Supabase Vector: store_postgres's pgvector store over a TLS pooler connection.

Drives the REAL ``Config``, ``StoreGlobalBase``, ``StoreInstanceBase``,
``VectorStoreToolMixin``, ``PgVectorStoreBase`` and store_postgres's own
``IGlobal`` / ``postgres.py`` (see ``database/_real_engine.py``); only
``psycopg2.connect`` is faked per test.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

pytest.importorskip('numpy')
pytest.importorskip('json5')

from .._support import (  # noqa: E402
    FAKE_DB_PASSWORD,
    is_prevent_default,
    tool_invoke,
    tool_query,
    FAKE_REF,
    LOGS,
    NODES_SRC,
    PG_CFG,
    FakePgConnection,
    assert_no_secrets,
    cfg_with,
    config_key,
    install_fake_psycopg2,
    load_common_fields,
    load_jsonc,
    load_service,
)
from ..database._real_engine import REGISTERED_VECTOR, real_engine  # noqa: E402

SERVICE = load_service('vector')
STORE_POSTGRES = load_jsonc(NODES_SRC / 'nodes' / 'store_postgres' / 'services.json')
SERVICES = {'supabase_vector': SERVICE, 'postgres': STORE_POSTGRES}

with real_engine(SERVICES, drivers=True):
    from nodes.store_postgres import postgres as store_postgres_driver
    from nodes.store_postgres.IGlobal import IGlobal as PostgresStoreGlobal
    from nodes.store_postgres.IInstance import IInstance as PostgresStoreInstance
    from nodes.supabase import supabase_client as sc
    import nodes.supabase.vector as vector_pkg
    from nodes.supabase.vector.IGlobal import IGlobal
    from nodes.supabase.vector.IInstance import IInstance
    from nodes.supabase.vector.store import Store

# What a node saved from the Supabase Vector panel holds (flat profile fields).
VECTOR_CFG = cfg_with(PG_CFG, table='docs', similarity='l2', score=0.6)

WRITE_TOOLS = {'upsert'}
ADMIN_TOOLS = {'delete', 'soft_delete', 'restore'}
READ_TOOLS = {'search', 'get', 'objdir', 'stats', 'list_documents'}


@pytest.fixture
def engine():
    LOGS.clear()
    REGISTERED_VECTOR.clear()
    with real_engine(SERVICES):
        yield


def _glb(cfg, open_mode='source', begin=True):
    glb = IGlobal()
    glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=open_mode, bag={}))
    glb.glb = SimpleNamespace(logicalType='supabase_vector', connConfig=dict(cfg))
    if begin:
        glb.beginGlobal()
    return glb


def _inst(glb):
    inst = IInstance()
    inst.IGlobal = glb
    inst.IEndpoint = glb.IEndpoint
    inst.instance = SimpleNamespace()
    return inst


# -----------------------------------------------------------------------------
# services.vector.json
# -----------------------------------------------------------------------------


def test_service_registration():
    assert SERVICE['protocol'] == 'supabase_vector://'
    assert SERVICE['classType'] == ['store', 'tool']
    assert SERVICE['capabilities'] == ['invoke']
    assert SERVICE['path'] == 'nodes.supabase.vector'
    assert SERVICE['prefix'] == 'Supabase Vector Store'
    assert SERVICE['lanes'] == STORE_POSTGRES['lanes']
    assert SERVICE['documentation'] == 'https://docs.rocketride.org/nodes/supabase/vector'


def test_service_fields_and_profile():
    profile = SERVICE['preconfig']['profiles'][SERVICE['preconfig']['default']]
    assert profile['access'] == 'read'
    assert 'authType' not in profile
    props = SERVICE['shape'][0]['properties']
    for field in (
        'supabase.pooler.host',
        'supabase.pooler.user',
        'supabase.pooler.password',
        'supabase.pooler.database',
    ):
        assert field in props and field in load_common_fields()
    assert 'supabase.access' in props and 'supabase.authType' not in props
    reserved = {config_key(f) for f in load_common_fields()}
    for field in SERVICE['fields']:
        if field.startswith('supabase_vector.'):
            assert config_key(field) not in reserved, field
            assert config_key(field) in profile, field
    assert SERVICE['fields']['supabase_vector.similarity']['default'] == profile['similarity']


def test_package_exports_store_entry_points():
    assert vector_pkg.getStore() is Store
    assert issubclass(IGlobal, PostgresStoreGlobal) and issubclass(IInstance, PostgresStoreInstance)
    assert issubclass(Store, store_postgres_driver.Store)


# -----------------------------------------------------------------------------
# Connection: TLS, split host, store_postgres unchanged
# -----------------------------------------------------------------------------


def test_begin_connects_with_tls_and_split_host(engine, monkeypatch):
    conn = FakePgConnection()
    state = install_fake_psycopg2(monkeypatch, conn)
    glb = _glb(cfg_with(VECTOR_CFG, host='aws-0-eu-west-1.pooler.supabase.com:6543'))

    kwargs = state.connect_kwargs[-1]
    assert kwargs['sslmode'] == 'require'
    assert kwargs['host'] == 'aws-0-eu-west-1.pooler.supabase.com' and kwargs['port'] == 6543
    assert kwargs['user'] == f'postgres.{FAKE_REF}' and kwargs['dbname'] == 'postgres'
    store = glb.store
    assert isinstance(store, Store)
    assert store.collection == 'docs' and store.similarity == '<->' and store.threshold_search == 0.6
    assert store.client is conn and conn.autocommit is True
    assert REGISTERED_VECTOR == [conn]
    assert glb._sub_key() == 'aws-0-eu-west-1.pooler.supabase.com/6543/docs'
    assert glb.transform_key == glb._sub_key()


def test_host_without_port_uses_5432(engine, monkeypatch):
    state = install_fake_psycopg2(monkeypatch)
    _glb(cfg_with(VECTOR_CFG, host='aws-0-eu-west-1.pooler.supabase.com'))
    assert state.connect_kwargs[-1]['port'] == 5432


def test_store_postgres_still_connects_as_before(engine, monkeypatch):
    """The reuse must not change store_postgres: no sslmode, separate host and port."""
    calls = []
    monkeypatch.setattr(store_postgres_driver.psycopg2, 'connect', lambda **kw: calls.append(kw) or FakePgConnection())
    store_postgres_driver.Store(
        'postgres', {'host': 'db.example.com', 'port': 5433, 'password': 'pw', 'collection': 'c'}, {}
    )
    assert calls == [
        {'dbname': 'rocketride', 'user': 'postgres', 'password': 'pw', 'host': 'db.example.com', 'port': 5433}
    ]


def test_store_attributes_match_store_postgres(engine, monkeypatch):
    """Vector re-implements store_postgres's constructor; a drift between the two fails here.

    Both stores are built from the same settings. Every attribute store_postgres
    sets must be set by Supabase Vector to the same value, except the password
    (deliberately not kept on the Supabase store) and the connection object.
    """
    monkeypatch.setattr(store_postgres_driver.psycopg2, 'connect', lambda **kw: FakePgConnection())
    install_fake_psycopg2(monkeypatch)
    shared = {
        'user': f'postgres.{FAKE_REF}',
        'password': FAKE_DB_PASSWORD,
        'database': 'postgres',
        'table': 'docs',
        'similarity': 'l2',
        'score': 0.7,
        'renderChunkSize': 4096,
    }
    plain = store_postgres_driver.Store('postgres', dict(shared, host='pooler.example.com', port=6543), {})
    tls = Store('supabase_vector', dict(shared, host='pooler.example.com:6543'), {})
    ignored = {'client', 'password'}

    def attrs(store):
        # Locks are per object: compare their kind, not their identity.
        return {
            k: (type(v) if 'lock' in type(v).__name__.lower() else v)
            for k, v in vars(store).items()
            if k not in ignored
        }

    assert attrs(tls) == attrs(plain)
    assert 'password' not in vars(tls)


@pytest.mark.parametrize(
    'missing, message',
    [
        ('host', 'Pooler host is required'),
        ('user', 'Database user is required'),
        ('password', 'Database password is required'),
    ],
)
def test_blank_required_field_stops_start_up(engine, monkeypatch, missing, message):
    state = install_fake_psycopg2(monkeypatch)
    with pytest.raises(sc.SupabaseConfigError, match=f'^supabase_vector: {message}'):
        _glb(cfg_with(VECTOR_CFG, **{missing: '  ' if missing != 'password' else ''}))
    assert state.connect_kwargs == []


@pytest.mark.parametrize('field', ['host', 'user', 'password'])
def test_unresolved_placeholder_stops_start_up_with_the_variable_name(engine, monkeypatch, field):
    """Every catalog-wired field is checked, not only the password store_postgres checks."""
    state = install_fake_psycopg2(monkeypatch)
    with pytest.raises(ValueError, match=r'no variable named ROCKETRIDE_SUPABASE_X was found'):
        _glb(cfg_with(VECTOR_CFG, **{field: '${ROCKETRIDE_SUPABASE_X}'}))
    assert state.connect_kwargs == []


def test_invalid_table_and_access_are_refused(engine, monkeypatch):
    install_fake_psycopg2(monkeypatch)
    with pytest.raises(ValueError, match='Invalid table name'):
        _glb(cfg_with(VECTOR_CFG, table='docs; drop table x'))
    with pytest.raises(sc.SupabaseConfigError, match='^supabase_vector: Access level'):
        _glb(cfg_with(VECTOR_CFG, access='owner'))


def test_connect_failure_never_shows_the_password(engine, monkeypatch):
    install_fake_psycopg2(monkeypatch, error=Exception(f'password authentication failed for {FAKE_DB_PASSWORD}'))
    with pytest.raises(sc.SupabaseError) as info:
        _glb(VECTOR_CFG)
    assert 'Could not connect' in str(info.value)
    assert_no_secrets(str(info.value))


def test_config_mode_opens_nothing(engine, monkeypatch):
    state = install_fake_psycopg2(monkeypatch)
    glb = _glb(VECTOR_CFG, open_mode='config')
    assert glb.store is None and state.connect_kwargs == []


# -----------------------------------------------------------------------------
# Access level -> write tools
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    'access, offered',
    [
        ('read', READ_TOOLS),
        (None, READ_TOOLS),
        ('write', READ_TOOLS | WRITE_TOOLS),
        ('admin', READ_TOOLS | WRITE_TOOLS | ADMIN_TOOLS),
    ],
)
def test_access_level_decides_the_tools(engine, monkeypatch, access, offered):
    """Reading at read, upsert (which may replace stored documents) at write, delete/soft_delete/restore at admin."""
    install_fake_psycopg2(monkeypatch)
    cfg = cfg_with(VECTOR_CFG, access=access) if access else {k: v for k, v in VECTOR_CFG.items() if k != 'access'}
    glb = _glb(cfg)
    assert glb.allow_write is (access in ('write', 'admin'))
    inst = _inst(glb)
    assert set(inst._collect_tool_methods()) == offered
    # The engine's own tool.query lists the same set.
    assert {d['name'] for d in tool_query(inst)} == offered


def test_admin_tools_keep_the_mixin_s_schema_and_description(engine):
    for name in ADMIN_TOOLS:
        assert getattr(IInstance, name).__tool_meta__ is getattr(PostgresStoreInstance, name).__tool_meta__, name


@pytest.mark.parametrize('access', ['read', 'write'])
def test_deleting_below_admin_is_refused_and_touches_nothing(engine, monkeypatch, access):
    install_fake_psycopg2(monkeypatch)
    inst = _inst(_glb(cfg_with(VECTOR_CFG, access=access)))
    calls = []
    inst.IGlobal.store = SimpleNamespace(
        remove=lambda ids: calls.append(('remove', ids)),
        markDeleted=lambda ids: calls.append(('markDeleted', ids)),
        markActive=lambda ids: calls.append(('markActive', ids)),
    )
    for tool in sorted(ADMIN_TOOLS):
        # Through the engine: this node does not own the tool at this level.
        with pytest.raises(Exception) as err:
            tool_invoke(inst, tool, {'object_ids': ['a']})
        assert is_prevent_default(err.value), err.value
        # Called directly: refused in the mixin's shape, naming the level to set.
        result = getattr(inst, tool)({'object_ids': ['a']})
        assert result == {
            'success': False,
            'error': f'supabase_vector.{tool} needs the "admin" access level, but this node is set to "{access}". '
            'Set "Access level" on the node to "admin" or higher to allow it.',
        }
    assert calls == []


def test_deleting_at_admin_reaches_the_store(engine, monkeypatch):
    install_fake_psycopg2(monkeypatch)
    inst = _inst(_glb(cfg_with(VECTOR_CFG, access='admin')))
    calls = []
    inst.IGlobal.store = SimpleNamespace(
        remove=lambda ids: calls.append(('remove', ids)),
        markDeleted=lambda ids: calls.append(('markDeleted', ids)) or 2,
        markActive=lambda ids: calls.append(('markActive', ids)) or 2,
    )
    assert tool_invoke(inst, 'delete', {'object_ids': ['a']}) == {
        'success': True,
        'deleted_count': 1,
        'object_ids': ['a'],
    }
    assert inst.soft_delete({'object_ids': ['b']})['matched_chunks'] == 2
    assert inst.restore({'object_ids': ['b']})['success'] is True
    assert calls == [('remove', ['a']), ('markDeleted', ['b']), ('markActive', ['b'])]


def test_direct_write_at_read_names_the_access_level(engine, monkeypatch):
    install_fake_psycopg2(monkeypatch)
    inst = _inst(_glb(VECTOR_CFG))
    result = inst.upsert({'documents': [{'content': 'x', 'object_id': 'a'}]})
    assert result['success'] is False
    assert 'supabase_vector.upsert needs the "write" access level' in result['error']
    assert 'allow_write' not in result['error']


@pytest.mark.parametrize('access', ['read', 'write', 'admin'])
def test_pipeline_lanes_work_at_every_level(engine, monkeypatch, access):
    """The documents and questions lanes are pipeline wiring, not agent calls: no level gates them."""
    install_fake_psycopg2(monkeypatch)
    inst = _inst(_glb(cfg_with(VECTOR_CFG, access=access)))
    calls = []
    inst.IGlobal.store = SimpleNamespace(
        addChunks=lambda docs: calls.append(('addChunks', docs)),
        dispatchSearch=lambda pself, question: calls.append(('dispatchSearch', question)),
    )
    inst.open(SimpleNamespace())
    inst.writeDocuments([])
    inst.writeQuestions('q')
    assert calls == [('addChunks', []), ('dispatchSearch', 'q')]


# -----------------------------------------------------------------------------
# Save-time probe
# -----------------------------------------------------------------------------


def _probe(cfg):
    LOGS.clear()
    _glb(cfg, begin=False)._probe_connection(dict(cfg))
    return [m for level, m in LOGS if level == 'warning']


def test_probe_reports_settings_problems_without_connecting(engine, monkeypatch):
    state = install_fake_psycopg2(monkeypatch)
    warnings = _probe(cfg_with(VECTOR_CFG, host='', table='bad-name', access='owner'))
    assert any('Pooler host is required' in w for w in warnings)
    assert any('Table must be a plain PostgreSQL name' in w for w in warnings)
    assert any('Access level' in w for w in warnings)
    assert state.connect_kwargs == []


def test_probe_uses_tls_and_checks_the_vector_type(engine, monkeypatch):
    conn = FakePgConnection()
    state = install_fake_psycopg2(monkeypatch, conn)
    assert _probe(VECTOR_CFG) == []
    assert state.connect_kwargs[-1]['sslmode'] == 'require'
    assert [sql for sql, _ in conn.executed] == ['SELECT 1', 'SELECT NULL::vector']
    assert conn.closed


def test_probe_explains_a_missing_vector_extension(engine, monkeypatch):
    class UndefinedObject(Exception):
        pgcode = '42704'

    conn = FakePgConnection([(r'NULL::vector', UndefinedObject('type "vector" does not exist'))])
    install_fake_psycopg2(monkeypatch, conn)
    warnings = _probe(VECTOR_CFG)
    assert len(warnings) == 1 and 'Database -> Extensions -> vector' in warnings[0]


def test_probe_never_shows_the_password(engine, monkeypatch):
    conn = FakePgConnection([(r'SELECT 1', Exception(f'boom {FAKE_DB_PASSWORD}'))])
    install_fake_psycopg2(monkeypatch, conn)
    warnings = _probe(VECTOR_CFG)
    assert warnings and 'boom' in warnings[0]
    assert_no_secrets(warnings)
