# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Supabase Cron: pg_cron tools over the TLS pooler connection (fake psycopg2)."""

from __future__ import annotations

import datetime

import pytest

from .._support import (
    FAKE_DB_PASSWORD,
    LOGS,
    PG_CFG,
    FakePgConnection,
    assert_no_secrets,
    cfg_with,
    config_key,
    engine_stubs,
    install_fake_psycopg2,
    load_common_fields,
    load_service,
    make_global,
    make_instance,
    tool_levels,
)

with engine_stubs():
    from nodes.supabase import supabase_client as sc
    from nodes.supabase.cron import IGlobal as PackageGlobal, IInstance as PackageInstance
    from nodes.supabase.cron.IGlobal import IGlobal
    from nodes.supabase.cron.IInstance import IInstance, PG_CRON_MISSING, mask_sql_literals

SERVICE = load_service('cron')

EXTENSION = (r'FROM pg_extension', [('1.6',)])
TIMEOUT = (r'set_config\(.statement_timeout', [('30000',)])
JOB_ROW = (3, 'nightly', '0 3 * * *', 'CALL refresh_stats()', True, 'postgres', 'postgres')
STARTED = datetime.datetime(2026, 11, 16, 3, 0, tzinfo=datetime.timezone.utc)


def _cron(monkeypatch, results, access='read', **cfg):
    conn = FakePgConnection([EXTENSION, TIMEOUT, *results])
    state = install_fake_psycopg2(monkeypatch, conn)
    inst = make_instance(IInstance, make_global(IGlobal, cfg_with(PG_CFG, access=access, **cfg)))
    return inst, conn, state


def _user_sql(conn):
    """Statements after the extension check and the timeout."""
    return conn.executed[2:]


# -----------------------------------------------------------------------------
# Registration
# -----------------------------------------------------------------------------


def test_tool_levels():
    assert tool_levels(IInstance) == {
        'list_jobs': 'read',
        'job_runs': 'read',
        'schedule_job': 'admin',
        'unschedule_job': 'admin',
    }


def test_package_re_exports():
    assert PackageGlobal is IGlobal and PackageInstance is IInstance


def test_service_json():
    assert SERVICE['protocol'] == 'tool_supabase_cron://'
    assert SERVICE['prefix'] == 'supabase_cron'
    assert SERVICE['classType'] == ['tool'] and SERVICE['capabilities'] == ['invoke'] and SERVICE['lanes'] == {}
    assert SERVICE['path'] == 'nodes.supabase.cron'
    profile = SERVICE['preconfig']['profiles'][SERVICE['preconfig']['default']]
    assert profile == {
        'title': 'Supabase Cron',
        'host': '',
        'user': '',
        'password': '',
        'database': 'postgres',
        'access': 'read',
        'maxRows': 100,
    }
    props = SERVICE['shape'][0]['properties']
    assert props[:5] == [
        'supabase.pooler.host',
        'supabase.pooler.user',
        'supabase.pooler.password',
        'supabase.pooler.database',
        'supabase.access',
    ]
    assert 'supabase.authType' not in props
    common = load_common_fields()
    for field in props:
        assert field in common or field in SERVICE['fields'], field
    max_rows = SERVICE['fields']['supabase_cron.maxRows']
    assert (max_rows['default'], max_rows['minimum'], max_rows['maximum']) == (100, 1, 1000)
    assert config_key('supabase_cron.maxRows') not in {config_key(f) for f in common}


# -----------------------------------------------------------------------------
# Settings
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    'field, message',
    [
        ('host', 'Pooler host is required'),
        ('user', 'Database user is required'),
        ('password', 'Database password is required'),
    ],
)
def test_blank_required_field_stops_start_up(field, message):
    with pytest.raises(sc.SupabaseConfigError, match=f'^supabase_cron: {message}'):
        make_global(IGlobal, cfg_with(PG_CFG, **{field: '   ' if field != 'password' else ''}))


@pytest.mark.parametrize('value, expected', [(None, 100), (5, 5), (0, 100), (50000, 1000), ('abc', 100)])
def test_max_rows_is_clamped(value, expected):
    assert make_global(IGlobal, cfg_with(PG_CFG, maxRows=value)).max_rows == expected


def test_connection_requires_tls_and_splits_the_host(monkeypatch):
    inst, _, state = _cron(
        monkeypatch, [(r'FROM cron\.job ORDER', [])], host='aws-0-eu-west-1.pooler.supabase.com:6543'
    )
    inst.list_jobs({})
    kwargs = state.connect_kwargs[-1]
    assert kwargs['sslmode'] == 'require'
    assert (kwargs['host'], kwargs['port']) == ('aws-0-eu-west-1.pooler.supabase.com', 6543)


# -----------------------------------------------------------------------------
# Access levels: refusal at every boundary
# -----------------------------------------------------------------------------


@pytest.mark.parametrize('access', ['read', None])
@pytest.mark.parametrize(
    'tool, args',
    [('schedule_job', {'name': 'n', 'schedule': '* * * * *', 'sql': 'SELECT 1'}), ('unschedule_job', {'name': 'n'})],
)
def test_admin_tools_are_refused_below_admin(monkeypatch, access, tool, args):
    inst, conn, state = _cron(monkeypatch, [], access=access)
    assert tool not in inst._collect_tool_methods()  # not offered to the agent either
    with pytest.raises(sc.SupabaseAccessError, match=f'supabase_cron.{tool} needs the "admin" access level'):
        getattr(inst, tool)(args)
    assert state.connect_kwargs == []  # refused before any connection


@pytest.mark.parametrize('access', ['read', 'admin'])
def test_read_tools_run_at_every_level(monkeypatch, access):
    inst, _, _ = _cron(monkeypatch, [(r'FROM cron\.job ORDER', [JOB_ROW])], access=access)
    assert inst.list_jobs({})['count'] == 1


def test_only_read_and_admin_are_offered():
    """No Cron tool needs write, so the panel offers read and admin only, and the code agrees."""
    assert [value for value, _label in SERVICE['fields']['supabase.access']['enum']] == ['read', 'admin']
    assert IGlobal.ACCESS_LEVELS == ('read', 'admin')


@pytest.mark.parametrize('value', ['write', ' Write '])
def test_a_stray_write_level_stops_start_up(value):
    """A "write" typed into a .pipe file is refused naming the two levels, not read as read or admin."""
    with pytest.raises(
        sc.SupabaseConfigError, match=r"^supabase_cron: Access level must be one of \['read', 'admin'\]"
    ):
        make_global(IGlobal, cfg_with(PG_CFG, access=value))


def test_a_stray_write_level_is_reported_while_editing():
    LOGS.clear()
    make_global(IGlobal, cfg_with(PG_CFG, access='write'), begin=False).validateConfig()
    assert [m for level, m in LOGS if level == 'warning'] == [
        "Supabase Cron: Access level must be one of ['read', 'admin'], got 'write'"
    ]


# -----------------------------------------------------------------------------
# pg_cron missing
# -----------------------------------------------------------------------------


def test_missing_pg_cron_gets_an_instruction(monkeypatch):
    conn = FakePgConnection([(r'FROM pg_extension', [])])
    install_fake_psycopg2(monkeypatch, conn)
    inst = make_instance(IInstance, make_global(IGlobal, PG_CFG))
    with pytest.raises(sc.SupabaseError) as info:
        inst.list_jobs({})
    assert PG_CRON_MISSING in str(info.value)
    assert conn.executed == [('SELECT extversion FROM pg_extension WHERE extname = %s', ('pg_cron',))]
    assert conn.rolled_back == 1 and conn.closed


# -----------------------------------------------------------------------------
# list_jobs / job_runs
# -----------------------------------------------------------------------------


def test_list_jobs(monkeypatch):
    inst, conn, _ = _cron(monkeypatch, [(r'FROM cron\.job ORDER', [JOB_ROW])])
    out = inst.list_jobs({})
    assert out == {
        'jobs': [
            {
                'job_id': 3,
                'name': 'nightly',
                'schedule': '0 3 * * *',
                'command': 'CALL refresh_stats()',
                'active': True,
                'database': 'postgres',
                'username': 'postgres',
            }
        ],
        'count': 1,
        'truncated': False,
    }
    assert _user_sql(conn)[0][1] == (101,)
    assert conn.executed[1][1] == ('30000',)  # statement timeout, bound
    assert conn.committed == 1 and conn.closed


def test_list_jobs_is_capped_and_says_so(monkeypatch):
    rows = [(i, f'job{i}', '* * * * *', 'SELECT 1', True, 'postgres', 'postgres') for i in range(3)]
    inst, conn, _ = _cron(monkeypatch, [(r'FROM cron\.job ORDER', rows)], maxRows=2)
    out = inst.list_jobs({})
    assert out['count'] == 2 and out['truncated'] is True
    assert _user_sql(conn)[0][1] == (3,)


def test_job_runs(monkeypatch):
    run = (11, 'succeeded', '1 row', STARTED, STARTED + datetime.timedelta(seconds=2))
    inst, conn, _ = _cron(monkeypatch, [(r'WHERE jobname = %s', [(3,)]), (r'FROM cron\.job_run_details', [run, run])])
    out = inst.job_runs({'job_name': 'nightly', 'limit': 1})
    assert out['job_id'] == 3 and out['count'] == 1 and out['truncated'] is True
    assert out['runs'][0] == {
        'run_id': 11,
        'status': 'succeeded',
        'return_message': '1 row',
        'start_time': '2026-11-16T03:00:00+00:00',
        'end_time': '2026-11-16T03:00:02+00:00',
    }
    assert [params for _, params in _user_sql(conn)] == [('nightly',), (3, 2)]


def test_job_runs_limit_default_and_clamp(monkeypatch):
    inst, conn, _ = _cron(monkeypatch, [(r'WHERE jobname = %s', [(3,)]), (r'job_run_details', [])], maxRows=5)
    inst.job_runs({'job_name': 'nightly'})
    inst.job_runs({'job_name': 'nightly', 'limit': 999})
    limits = [params[1] for sql, params in conn.executed if 'job_run_details' in sql]
    assert limits == [6, 6]  # default 20 and 999 both clamp to maxRows (5), +1 to detect truncation


def test_job_runs_unknown_job(monkeypatch):
    inst, _, _ = _cron(monkeypatch, [(r'WHERE jobname = %s', [])])
    with pytest.raises(ValueError, match="supabase_cron.job_runs: no cron job named 'nope'"):
        inst.job_runs({'job_name': 'nope'})


@pytest.mark.parametrize('args', [{}, {'job_name': ''}, {'job_name': 'x' * 256}, {'job_name': 'a', 'limit': 'ten'}])
def test_job_runs_bad_input(monkeypatch, args):
    inst, _, _ = _cron(monkeypatch, [])
    with pytest.raises(ValueError, match='supabase_cron.job_runs'):
        inst.job_runs(args)


# -----------------------------------------------------------------------------
# schedule_job / unschedule_job
# -----------------------------------------------------------------------------


def test_schedule_job_binds_every_value(monkeypatch):
    name = "x'); DROP TABLE users; --"
    sql = 'DELETE FROM sessions WHERE expires_at < now()'
    inst, conn, _ = _cron(monkeypatch, [(r'WHERE jobname = %s', []), (r'cron\.schedule', [(42,)])], access='admin')
    out = inst.schedule_job({'name': name, 'schedule': '*/5 * * * *', 'sql': sql})
    assert out == {'job_id': 42, 'name': name, 'schedule': '*/5 * * * *', 'replaced': False}
    statement, params = _user_sql(conn)[1]
    assert statement == 'SELECT cron.schedule(%s, %s, %s)'
    assert params == (name, '*/5 * * * *', sql)
    assert all(name not in s and sql not in s for s, _ in conn.executed)
    assert conn.committed == 1


def test_schedule_job_reports_a_replaced_job(monkeypatch):
    inst, _, _ = _cron(monkeypatch, [(r'WHERE jobname = %s', [(7,)]), (r'cron\.schedule', [(7,)])], access='admin')
    assert inst.schedule_job({'name': 'nightly', 'schedule': '0 3 * * *', 'sql': 'SELECT 1'})['replaced'] is True


def test_schedule_job_invalid_schedule_rolls_back(monkeypatch):
    inst, conn, _ = _cron(
        monkeypatch,
        [(r'WHERE jobname = %s', []), (r'cron\.schedule', Exception('invalid schedule: every tuesday'))],
        access='admin',
    )
    with pytest.raises(RuntimeError, match='supabase_cron.schedule_job: invalid schedule'):
        inst.schedule_job({'name': 'n', 'schedule': 'every tuesday', 'sql': 'SELECT 1'})
    assert conn.rolled_back == 1 and conn.committed == 0


@pytest.mark.parametrize(
    'args',
    [
        {'schedule': '* * * * *', 'sql': 'SELECT 1'},
        {'name': 'n', 'sql': 'SELECT 1'},
        {'name': 'n', 'schedule': '* * * * *'},
    ],
)
def test_schedule_job_requires_all_arguments(monkeypatch, args):
    inst, _, state = _cron(monkeypatch, [], access='admin')
    with pytest.raises(ValueError, match='supabase_cron.schedule_job'):
        inst.schedule_job(args)
    assert state.connect_kwargs == []


def test_unschedule_job(monkeypatch):
    inst, conn, _ = _cron(
        monkeypatch, [(r'WHERE jobname = %s', [(3,)]), (r'cron\.unschedule', [(True,)])], access='admin'
    )
    assert inst.unschedule_job({'name': 'nightly'}) == {'name': 'nightly', 'job_id': 3, 'unscheduled': True}
    assert _user_sql(conn)[1] == ('SELECT cron.unschedule(%s)', ('nightly',))


def test_unschedule_unknown_job(monkeypatch):
    inst, conn, _ = _cron(monkeypatch, [(r'WHERE jobname = %s', [])], access='admin')
    with pytest.raises(ValueError, match="no cron job named 'gone'"):
        inst.unschedule_job({'name': 'gone'})
    assert not any('unschedule' in sql for sql, _ in conn.executed)


# -----------------------------------------------------------------------------
# Secrets
# -----------------------------------------------------------------------------


def test_database_errors_never_show_the_password(monkeypatch):
    inst, _, _ = _cron(monkeypatch, [(r'FROM cron\.job ORDER', Exception(f'permission denied for {FAKE_DB_PASSWORD}'))])
    with pytest.raises(RuntimeError) as info:
        inst.list_jobs({})
    assert_no_secrets(str(info.value))


def test_connect_errors_never_show_the_password(monkeypatch):
    install_fake_psycopg2(monkeypatch, error=Exception(f'auth failed: {FAKE_DB_PASSWORD}'))
    inst = make_instance(IInstance, make_global(IGlobal, PG_CFG))
    with pytest.raises(sc.SupabaseError) as info:
        inst.list_jobs({})
    assert_no_secrets(str(info.value))


def test_outputs_and_logs_carry_no_secrets(monkeypatch):
    LOGS.clear()
    inst, _, _ = _cron(monkeypatch, [(r'FROM cron\.job ORDER', [JOB_ROW])])
    assert_no_secrets(inst.list_jobs({}))
    assert_no_secrets([m for _, m in LOGS])


# -----------------------------------------------------------------------------
# Keys embedded in job SQL
# -----------------------------------------------------------------------------

# Built at run time so secret scanners do not flag a JWT-shaped literal.
_JWT = '.'.join(['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoic2VydmljZV9yb2xlIn0', 'abcdefghijk'])
_SB_SECRET = 'sb_secret_' + 'someOtherProjectKey0123'
_AUTH, _APIKEY = 'Author' + 'ization', 'api' + 'key'
_HTTP_POST_JOB = (
    "select net.http_post(url := 'https://x.supabase.co/functions/v1/sync', "
    'headers := \'{"Content-Type": "application/json", "%s": "Bearer %s", "%s": "%s"}\'::jsonb)'
    % (_AUTH, _JWT, _APIKEY, _SB_SECRET)
)


@pytest.mark.parametrize('access', ['read'])
def test_list_jobs_below_admin_masks_every_literal_in_the_command(monkeypatch, access):
    """A read-level agent must not lift any credential out of a job's SQL, whatever its shape."""
    row = (4, 'sync', '*/5 * * * *', _HTTP_POST_JOB, True, 'postgres', 'postgres')
    inst, _, _ = _cron(monkeypatch, [(r'FROM cron\.job ORDER', [row])], access=access)
    command = inst.list_jobs({})['jobs'][0]['command']
    assert command == "select net.http_post(url := '***', headers := '***'::jsonb)"


def test_list_jobs_at_admin_masks_keys_inside_the_command(monkeypatch):
    """Admin sees the command, with secret-shaped values masked."""
    row = (4, 'sync', '*/5 * * * *', _HTTP_POST_JOB, True, 'postgres', 'postgres')
    inst, _, _ = _cron(monkeypatch, [(r'FROM cron\.job ORDER', [row])], access='admin')
    command = inst.list_jobs({})['jobs'][0]['command']
    assert _JWT not in command and _SB_SECRET not in command
    assert 'net.http_post' in command and '"Authorization": "***"' in command and '"apikey": "***"' in command
    assert 'https://x.supabase.co/functions/v1/sync' in command


# Credential shapes the Supabase patterns do not know; below admin they are hidden anyway.
_TOKEN = 'abcd' + '1234efgh5678'
_OTHER_JOBS = [
    "select net.http_post(url:='https://h.example.com', headers:=jsonb_build_object('%s','Bearer ' || '%s'))"
    % (_AUTH, _TOKEN),
    "select net.http_post(url:='https://h.example.com', headers:=jsonb_build_object('%s', concat('Bearer ', '%s')))"
    % (_AUTH, _TOKEN),
    "select net.http_post(url:='https://h.example.com', headers:='{\"X-Webhook-" + 'Secret":"%s"}\'::jsonb)' % _TOKEN,
    "select net.http_get(url:='https://hooks.example.com/x?to" + "ken=%s')" % _TOKEN,
    "select * from dblink('host=db.example.com user=postgres pass" + "word=%s', 'select 1') as t(x int)" % _TOKEN,
    "select net.http_get(url:=E'https://h.example.com/\\'%s')" % _TOKEN,
    "do $job$ begin perform set_config('app.key', '%s', false); end $job$" % _TOKEN,
    'select 1 -- key %s' % _TOKEN,
]


# The first five are the shapes the Redactor's patterns recognise, so admin sees them masked too.
_PATTERN_SHAPES = _OTHER_JOBS[:5]


@pytest.mark.parametrize(
    'access, command', [('read', c) for c in _OTHER_JOBS] + [('admin', c) for c in _PATTERN_SHAPES]
)
def test_list_jobs_hides_other_credential_shapes(monkeypatch, access, command):
    row = (5, 'hook', '* * * * *', command, True, 'postgres', 'postgres')
    inst, _, _ = _cron(monkeypatch, [(r'FROM cron\.job ORDER', [row])], access=access)
    shown = inst.list_jobs({})['jobs'][0]['command']
    assert _TOKEN not in shown and '***' in shown


def test_mask_sql_literals_keeps_identifiers_and_shape():
    sql = "select \"it's\", f('a''b', 42), $$x$$ from t where c = E'\\'q'"
    assert mask_sql_literals(sql) == "select \"it's\", f('***', 42), $$***$$ from t where c = E'***'"
    assert mask_sql_literals("select 'unterminated") == "select '***'"
    assert mask_sql_literals('select $1, $2') == 'select $1, $2'


def test_job_runs_masks_keys_in_return_message(monkeypatch):
    run = (12, 'failed', f'ERROR: 401 for Bearer {_JWT} key {_SB_SECRET}', STARTED, None)
    inst, _, _ = _cron(monkeypatch, [(r'WHERE jobname = %s', [(4,)]), (r'FROM cron\.job_run_details', [run])])
    message = inst.job_runs({'job_name': 'sync'})['runs'][0]['return_message']
    assert _JWT not in message and _SB_SECRET not in message and message.startswith('ERROR: 401 for Bearer ***')


def test_statement_timeout_is_cron_s_own_setting(monkeypatch):
    inst, conn, _ = _cron(monkeypatch, [(r'FROM cron\.job ORDER', [])])
    inst.IGlobal.STATEMENT_TIMEOUT_SECONDS = 7
    inst.list_jobs({})
    assert conn.executed[1][1] == ('7000',)
