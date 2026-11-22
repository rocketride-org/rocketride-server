# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the shared SupabaseGlobalBase / SupabaseInstanceBase.

A tiny dummy service (one tool per access level) is built on the bases the
same way a real service is, so this file doubles as the reference example.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from ._support import (
    API_CFG,
    FAKE_DB_PASSWORD,
    FAKE_SECRET_KEY,
    LOGS,
    PG_CFG,
    FakeHttpClient,
    FakePgConnection,
    FakeResponse,
    FakeSupabaseClient,
    assert_no_secrets,
    cfg_with,
    engine_stubs,
    install_fake_psycopg2,
    is_prevent_default,
    make_global,
    make_instance,
    require_supabase_py,
    tool_invoke,
    tool_levels,
    tool_query,
)

with engine_stubs():
    from rocketlib import IInstanceBase, tool_function

    from ai.common.utils import require_str
    from nodes.supabase import supabase_client as sc
    from nodes.supabase.IGlobal import API, POSTGRES, SupabaseGlobalBase
    from nodes.supabase.IInstance import ADMIN, READ, WRITE, SupabaseInstanceBase, requires_access, tool_access_level


# -----------------------------------------------------------------------------
# Dummy services
# -----------------------------------------------------------------------------


class DemoGlobal(SupabaseGlobalBase):
    SERVICE = 'supabase_demo'
    PRODUCT = 'Supabase Demo'
    CONNECTION = API

    LIMITS = {'limit': ('limit', 10, 1, 50)}
    limit: int = 0
    doubled: int = 0

    def _after_begin(self, cfg):
        self.doubled = self.limit * 2


class DemoInstance(SupabaseInstanceBase):
    IGlobal: DemoGlobal

    @tool_function(input_schema={'type': 'object', 'properties': {'user_id': {'type': 'string'}}}, description='Read.')
    @requires_access(READ)
    def get_thing(self, args):
        user_id = require_str(args, 'user_id', tool_name=self._tool('get_thing'))
        return self._output(self._client().auth.admin.get_user_by_id(user_id))

    @tool_function(input_schema={'type': 'object', 'properties': {}}, description='Write.')
    @requires_access(WRITE)
    def make_thing(self, args):
        return self._api().request('POST', '/rest/v1/things', json=args, what='make_thing').body

    @tool_function(input_schema={'type': 'object', 'properties': {}}, description='Admin.')
    @requires_access(ADMIN)
    def drop_thing(self, args):
        return {'ok': True, 'echo': args}

    @tool_function(input_schema={'type': 'object', 'properties': {}}, description='Leaks.')
    @requires_access(READ)
    def leaky(self, args):
        raise Exception(f'upstream said key={FAKE_SECRET_KEY}')

    @tool_function(input_schema={'type': 'object', 'properties': {}}, description='Echo.')
    @requires_access(READ)
    def echo_key(self, args):
        return {'text': f'the key is {FAKE_SECRET_KEY}'}


class CronLikeGlobal(SupabaseGlobalBase):
    SERVICE = 'supabase_pgdemo'
    PRODUCT = 'Supabase PG Demo'
    CONNECTION = POSTGRES


class CronLikeInstance(SupabaseInstanceBase):
    IGlobal: CronLikeGlobal

    @tool_function(input_schema={'type': 'object', 'properties': {}}, description='List.')
    @requires_access(READ)
    def list_rows(self, args):
        with self._postgres() as conn:
            with conn.cursor() as cur:
                cur.execute('select jobname from cron.job')
                return {'rows': [r[0] for r in cur.fetchall()]}

    @tool_function(input_schema={'type': 'object', 'properties': {}}, description='Fail.')
    @requires_access(ADMIN)
    def fail(self, args):
        with self._postgres() as conn:
            conn.cursor().execute('select boom')
            return {}


def _api_instance(access='read', client=None, http=None):
    glb = make_global(DemoGlobal, cfg_with(API_CFG, access=access), client=client or FakeSupabaseClient(), http=http)
    return make_instance(DemoInstance, glb)


# -----------------------------------------------------------------------------
# Global lifecycle
# -----------------------------------------------------------------------------


def test_begin_global_resolves_access_and_connection():
    glb = make_global(DemoGlobal, cfg_with(API_CFG, access='write', limit=5))
    assert glb.access == 'write'
    assert glb.connection.url == API_CFG['url']
    assert glb.limit == 5 and glb.doubled == 10
    assert all(FAKE_SECRET_KEY not in msg for _lvl, msg in LOGS)


def test_begin_global_config_mode_does_nothing():
    glb = make_global(DemoGlobal, API_CFG, open_mode='config')
    assert glb.connection is None


def test_begin_global_fails_loudly_on_bad_settings():
    with pytest.raises(ValueError, match='^supabase_demo: Access level'):
        make_global(DemoGlobal, cfg_with(API_CFG, access='root'))
    with pytest.raises(ValueError, match='^supabase_demo: Secret key is required'):
        make_global(DemoGlobal, cfg_with(API_CFG, secretKey='   '))
    with pytest.raises(ValueError, match='^supabase_demo: Project URL is required'):
        make_global(DemoGlobal, cfg_with(API_CFG, url=' '))
    with pytest.raises(ValueError, match='Pooler host is required'):
        make_global(CronLikeGlobal, cfg_with(PG_CFG, host=' '))
    with pytest.raises(ValueError, match='password'):
        make_global(CronLikeGlobal, cfg_with(PG_CFG, password=''))


def test_validate_config_warns_without_raising():
    LOGS.clear()
    glb = make_global(DemoGlobal, {'access': 'nope', 'limit': -1}, begin=False)
    glb.validateConfig()
    warnings = [m for lvl, m in LOGS if lvl == 'warning']
    assert any('Access level' in w for w in warnings)
    assert any('Project URL' in w for w in warnings)
    assert any('Secret key' in w for w in warnings)
    assert all(w.startswith('Supabase Demo: ') for w in warnings)


def test_validate_config_clean():
    LOGS.clear()
    make_global(DemoGlobal, API_CFG, begin=False).validateConfig()
    make_global(CronLikeGlobal, PG_CFG, begin=False).validateConfig()
    assert [m for lvl, m in LOGS if lvl == 'warning'] == []


def test_end_global_clears_state_and_closes_http():
    http = FakeHttpClient()
    glb = make_global(DemoGlobal, API_CFG, client=FakeSupabaseClient(), http=http)
    glb.get_api()
    glb.endGlobal()
    assert http.closed and glb.connection is None and glb._client is None and glb.redactor is None


def test_end_global_closes_the_supabase_py_sessions():
    """Auth, PostgREST, Storage and Functions each hold an httpx session; all are closed."""
    closed = []

    def closer(name):
        return SimpleNamespace(close=lambda: closed.append(name))

    client = SimpleNamespace(
        auth=SimpleNamespace(close=lambda: closed.append('auth')),
        _postgrest=SimpleNamespace(aclose=lambda: closed.append('postgrest')),
        _storage=SimpleNamespace(session=closer('storage')),
        _functions=SimpleNamespace(_client=closer('functions')),
    )
    glb = make_global(DemoGlobal, API_CFG, client=client)
    glb.endGlobal()
    assert closed == ['auth', 'postgrest', 'storage', 'functions'] and glb._client is None


def test_end_global_skips_sub_clients_never_built_and_ignores_close_errors():
    def boom():
        raise RuntimeError('already closed')

    client = SimpleNamespace(auth=SimpleNamespace(close=boom), _postgrest=None, _storage=None, _functions=None)
    glb = make_global(DemoGlobal, API_CFG, client=client)
    glb.endGlobal()
    assert glb._client is None and glb.connection is None


def test_close_client_on_a_real_supabase_py_client():
    """The attribute names close_client relies on exist on supabase-py's client."""
    supabase = require_supabase_py()
    from supabase.lib.client_options import SyncClientOptions

    client = supabase.create_client(API_CFG['url'], FAKE_SECRET_KEY, options=SyncClientOptions())
    client.postgrest, client.storage, client.functions  # build the lazy sub-clients (no network)
    assert {'auth', '_postgrest', '_storage', '_functions'} <= set(vars(client))
    sc.close_client(client)
    assert client.auth._http_client.is_closed
    assert client._postgrest.session.is_closed and client._storage.session.is_closed
    assert client._functions._client.is_closed


@pytest.mark.parametrize(
    'cls, base, field',
    [
        (DemoGlobal, API_CFG, 'url'),
        (DemoGlobal, API_CFG, 'secretKey'),
        (CronLikeGlobal, PG_CFG, 'host'),
        (CronLikeGlobal, PG_CFG, 'user'),
        (CronLikeGlobal, PG_CFG, 'password'),
    ],
)
def test_unresolved_placeholder_stops_start_up_with_the_variable_name(cls, base, field):
    with pytest.raises(ValueError, match=r'no variable named ROCKETRIDE_SUPABASE_X was found'):
        make_global(cls, cfg_with(base, **{field: '${ROCKETRIDE_SUPABASE_X}'}))


def test_limits_are_read_with_their_bounds():
    assert make_global(DemoGlobal, cfg_with(API_CFG, limit=500)).limit == 50
    # config_int treats 0 as "not set" and uses the default.
    assert make_global(DemoGlobal, cfg_with(API_CFG, limit=0)).limit == 10
    assert make_global(DemoGlobal, API_CFG).limit == 10


def test_get_client_is_built_once(monkeypatch):
    glb = make_global(DemoGlobal, API_CFG)
    built = []
    monkeypatch.setattr(sc, 'build_client', lambda conn, timeout=0: built.append(conn) or SimpleNamespace())
    first = glb.get_client()
    assert glb.get_client() is first and len(built) == 1


def test_wrong_connection_kind_is_refused():
    glb = make_global(CronLikeGlobal, PG_CFG)
    with pytest.raises(RuntimeError, match='no api connection'):
        glb.get_client()


# -----------------------------------------------------------------------------
# requires_access
# -----------------------------------------------------------------------------


def test_every_tool_declares_a_level():
    assert tool_levels(DemoInstance) == {
        'get_thing': 'read',
        'make_thing': 'write',
        'drop_thing': 'admin',
        'leaky': 'read',
        'echo_key': 'read',
    }
    assert tool_access_level(DemoInstance.drop_thing) == 'admin'


def test_base_class_exposes_no_tools():
    assert tool_levels(SupabaseInstanceBase) == {}


# -----------------------------------------------------------------------------
# The level decides what the engine offers (tool.query / tool.invoke)
# -----------------------------------------------------------------------------


def test_the_engine_stub_runs_rocketlib_s_own_tool_dispatch():
    """tool.query / tool.invoke below go through filters.py's real code, not a copy in the tests."""
    for name in ('invoke', '_dispatch_tool', '_collect_tool_methods', '_build_tool_descriptors'):
        assert getattr(IInstanceBase, name).__code__.co_filename.endswith('rocketlib/filters.py'), name
    # The decorator that stamps a tool is filters.py's own too, so a change to it shows here.
    assert tool_function.__code__.co_filename.endswith('rocketlib/filters.py')


@pytest.mark.parametrize(
    'access, offered',
    [
        ('read', {'get_thing', 'leaky', 'echo_key'}),
        ('write', {'get_thing', 'leaky', 'echo_key', 'make_thing'}),
        ('admin', {'get_thing', 'leaky', 'echo_key', 'make_thing', 'drop_thing'}),
    ],
)
def test_tool_query_lists_only_the_tools_the_level_allows(access, offered):
    assert {d['name'] for d in tool_query(_api_instance(access))} == offered


@pytest.mark.parametrize('access, tool', [('read', 'make_thing'), ('read', 'drop_thing'), ('write', 'drop_thing')])
def test_tool_invoke_above_the_level_is_not_dispatched(access, tool):
    """The engine does not find the tool on this node at all, so the body never runs."""
    http = FakeHttpClient({'POST /rest/v1/things': FakeResponse(201, {'id': 1})})
    with pytest.raises(Exception) as err:
        tool_invoke(_api_instance(access, http=http), tool, {})
    assert is_prevent_default(err.value), err.value
    assert http.requests == []


def test_tool_invoke_within_the_level_runs_through_the_shared_checks():
    assert tool_invoke(_api_instance('admin'), 'drop_thing', '{"a": 1}') == {'ok': True, 'echo': {'a': 1}}
    # The result scrubbing of @requires_access still applies on the engine path.
    assert tool_invoke(_api_instance('read'), 'echo_key', {}) == {'text': 'the key is ***'}


def test_a_tool_without_a_level_stops_the_service_from_loading():
    with pytest.raises(TypeError, match=r'tool\(s\) forgot declare no access level'):

        class Forgetful(SupabaseInstanceBase):
            @tool_function(input_schema={'type': 'object', 'properties': {}}, description='No level.')
            def forgot(self, args):
                return {'ran': True}


def test_a_tool_attached_without_a_level_fails_closed():
    """A tool added after the class was built (so __init_subclass__ never saw it) is not offered."""

    class Patched(DemoInstance):
        pass

    @tool_function(input_schema={'type': 'object', 'properties': {}}, description='Bolted on.')
    def bolted(self, args):
        return {'ran': True}

    Patched.bolted = bolted
    LOGS.clear()
    inst = make_instance(Patched, make_global(DemoGlobal, cfg_with(API_CFG, access='admin')))
    assert 'bolted' not in {d['name'] for d in tool_query(inst)}
    with pytest.raises(Exception) as err:
        tool_invoke(inst, 'bolted', {})
    assert is_prevent_default(err.value)
    assert (
        'warning',
        'supabase_demo.bolted: not offered, because it declares no access level (@requires_access)',
    ) in LOGS


class WriteOnlyInstance(SupabaseInstanceBase):
    IGlobal: DemoGlobal

    @tool_function(input_schema={'type': 'object', 'properties': {}}, description='Write.')
    @requires_access(WRITE)
    def send(self, args):
        return {}


def _no_tools_warnings():
    return [m for level, m in LOGS if level == 'warning' and 'offers the agent no tools' in m]


def test_a_level_with_no_tools_is_said_once_at_start():
    LOGS.clear()
    glb = make_global(DemoGlobal, cfg_with(API_CFG, access='read'))
    for _ in range(3):  # one instance per pipeline thread, one message per node
        make_instance(WriteOnlyInstance, glb).beginInstance()
    assert _no_tools_warnings() == [
        'Supabase Demo: the access level is "read", which offers the agent no tools. '
        'Set "Access level" on the node to "write" to turn them on.'
    ]


def test_a_level_with_tools_says_nothing():
    LOGS.clear()
    make_instance(WriteOnlyInstance, make_global(DemoGlobal, cfg_with(API_CFG, access='write'))).beginInstance()
    make_instance(DemoInstance, make_global(DemoGlobal, cfg_with(API_CFG, access='read'))).beginInstance()
    assert _no_tools_warnings() == []


def test_the_no_tools_message_is_said_again_after_a_restart():
    glb = make_global(DemoGlobal, cfg_with(API_CFG, access='read'))
    make_instance(WriteOnlyInstance, glb).beginInstance()
    glb.endGlobal()
    LOGS.clear()
    glb.beginGlobal()
    make_instance(WriteOnlyInstance, glb).beginInstance()
    assert len(_no_tools_warnings()) == 1


def test_requires_access_rejects_unknown_level():
    with pytest.raises(ValueError):
        requires_access('owner')


@pytest.mark.parametrize(
    'access,tool,allowed',
    [
        ('read', 'drop_thing', False),
        ('write', 'drop_thing', False),
        ('admin', 'drop_thing', True),
        ('read', 'make_thing', False),
    ],
)
def test_access_is_enforced(access, tool, allowed):
    http = FakeHttpClient({'POST /rest/v1/things': FakeResponse(201, {'id': 1})})
    inst = _api_instance(access, http=http)
    if allowed:
        getattr(inst, tool)({})
    else:
        with pytest.raises(PermissionError, match=f'supabase_demo.{tool} needs the'):
            getattr(inst, tool)({})
        assert http.requests == []


def test_access_checked_before_input_validation():
    inst = _api_instance('read')
    with pytest.raises(PermissionError):
        inst.drop_thing('not even a dict')


def test_input_is_normalized():
    inst = _api_instance('admin')
    assert inst.drop_thing('{"input": {"a": 1}}')['echo'] == {'a': 1}
    assert inst.drop_thing(None)['echo'] == {}


def test_value_error_passes_through():
    inst = _api_instance()
    with pytest.raises(ValueError, match='supabase_demo.get_thing: "user_id" is required'):
        inst.get_thing({})


def test_client_call_and_output_shaping():
    user = SimpleNamespace(id='u1', email='a@b.c', encrypted_password='hash', app_metadata={'x': 1})
    client = FakeSupabaseClient({'auth.admin.get_user_by_id': user})
    out = _api_instance(client=client).get_thing({'user_id': 'u1'})
    assert out == {'id': 'u1', 'email': 'a@b.c', 'app_metadata': {'x': 1}}
    assert client.calls_to('auth.admin.get_user_by_id') == [(('u1',), {})]


def test_backend_error_becomes_runtime_error_redacted():
    with pytest.raises(RuntimeError) as err:
        _api_instance().leaky({})
    assert str(err.value).startswith('supabase_demo.leaky: upstream said key=***')
    # `from None`: the original exception (whose args hold the secret) is not chained.
    assert err.value.__cause__ is None and err.value.__suppress_context__
    assert_no_secrets(str(err.value))


def test_library_error_is_described():
    class AuthApiError(Exception):
        def __init__(self):
            super().__init__('User not allowed')
            self.message, self.status, self.code = 'User not allowed', 403, 'not_admin'

    client = FakeSupabaseClient({'auth.admin.get_user_by_id': AuthApiError()})
    with pytest.raises(RuntimeError, match=r'supabase_demo.get_thing: \(HTTP 403, not_admin\) User not allowed'):
        _api_instance(client=client).get_thing({'user_id': 'u1'})


def test_supabase_error_keeps_status_and_gets_tool_prefix():
    http = FakeHttpClient({'POST /rest/v1/things': FakeResponse(409, {'message': 'duplicate'})})
    with pytest.raises(sc.SupabaseError) as err:
        _api_instance('write', http=http).make_thing({})
    assert err.value.status == 409
    assert str(err.value) == 'supabase_demo.make_thing: make_thing failed (HTTP 409): duplicate'
    assert isinstance(err.value, RuntimeError)


def test_result_is_scrubbed_of_configured_secrets():
    out = _api_instance().echo_key({})
    assert out == {'text': 'the key is ***'}


def test_tool_on_closed_node():
    inst = _api_instance()
    inst.IGlobal.endGlobal()
    with pytest.raises(RuntimeError, match='node is not open'):
        inst.get_thing({'user_id': 'u1'})


# -----------------------------------------------------------------------------
# Postgres services
# -----------------------------------------------------------------------------


def test_postgres_session_commits_and_closes(monkeypatch):
    conn = FakePgConnection([(r'from cron\.job', [('nightly',), ('hourly',)])])
    state = install_fake_psycopg2(monkeypatch, conn)
    inst = make_instance(CronLikeInstance, make_global(CronLikeGlobal, PG_CFG))
    assert inst.list_rows({}) == {'rows': ['nightly', 'hourly']}
    assert conn.committed == 1 and conn.closed
    assert state.connect_kwargs[0]['sslmode'] == 'require'


def test_postgres_session_rolls_back_and_redacts(monkeypatch):
    conn = FakePgConnection([(r'boom', Exception(f'syntax error near {FAKE_DB_PASSWORD}'))])
    install_fake_psycopg2(monkeypatch, conn)
    inst = make_instance(CronLikeInstance, make_global(CronLikeGlobal, cfg_with(PG_CFG, access='admin')))
    with pytest.raises(RuntimeError) as err:
        inst.fail({})
    assert conn.rolled_back == 1 and conn.committed == 0 and conn.closed
    assert_no_secrets(str(err.value))


def test_postgres_connect_failure(monkeypatch):
    install_fake_psycopg2(monkeypatch, error=Exception('could not translate host name'))
    inst = make_instance(CronLikeInstance, make_global(CronLikeGlobal, PG_CFG))
    with pytest.raises(sc.SupabaseError, match='supabase_pgdemo.list_rows: Could not connect'):
        inst.list_rows({})


# -----------------------------------------------------------------------------
# The fake client is held to supabase-py's real signatures
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    'call',
    [
        lambda c: c.auth.admin.delete_user('id', soft=True),
        lambda c: c.storage.create_bucket('b', public=True),
        lambda c: c.storage.from_('b').list('p', limit=5),
        lambda c: c.auth.admin.no_such_method(),
        lambda c: c.realtime.channel('x'),
    ],
)
def test_fake_client_refuses_calls_supabase_py_would_refuse(call):
    require_supabase_py()
    with pytest.raises(AssertionError):
        call(FakeSupabaseClient())


def test_fake_client_accepts_real_signatures():
    require_supabase_py()
    client = FakeSupabaseClient()
    client.auth.admin.delete_user('id', should_soft_delete=True)
    client.storage.create_bucket('b', options={'public': False})
    client.storage.from_('b').list('p', {'limit': 5, 'offset': 0})
    client.schema('pgmq_public').rpc('send', {'queue_name': 'q'}).execute()
    assert len(client.calls) == 7  # storage.from_ is a call too


def test_bounded_str():
    bounded = SupabaseInstanceBase._bounded_str
    assert bounded({'k': ' abc '}, 'k', tool_name='t.x', max_len=3) == 'abc'
    with pytest.raises(ValueError, match=r'^t\.x: "k" must be at most 2 characters'):
        bounded({'k': 'abc'}, 'k', tool_name='t.x', max_len=2)
    with pytest.raises(ValueError, match='t.x'):
        bounded({}, 'k', tool_name='t.x', max_len=2)
    assert bounded({'k': '  '}, 'k', tool_name='t.x', max_len=2, required=False) is None
    assert bounded({}, 'k', tool_name='t.x', max_len=2, required=False) is None
