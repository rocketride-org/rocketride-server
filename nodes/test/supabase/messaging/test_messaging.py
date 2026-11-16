# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the Supabase Messaging service (fake supabase-py and HTTP clients)."""

from __future__ import annotations

import pytest

from .._support import (
    API_CFG,
    FAKE_SECRET_KEY,
    FakeHttpClient,
    FakeResponse,
    FakeSupabaseClient,
    assert_no_secrets,
    cfg_with,
    engine_stubs,
    load_service,
    make_global,
    make_instance,
    tool_levels,
)

with engine_stubs():
    from nodes.supabase import supabase_client as sc
    from nodes.supabase.messaging.IGlobal import IGlobal
    from nodes.supabase.messaging.IInstance import IInstance

RPC = 'schema.rpc.execute'
BROADCAST = 'POST /realtime/v1/api/broadcast'


class _Resp:
    def __init__(self, data):
        self.data = data


class FakeApiError(Exception):
    """Same attributes as postgrest.exceptions.APIError."""

    def __init__(self, code, message, hint=None):
        super().__init__(message)
        self.code, self.message, self.hint, self.details = code, message, hint, None


def _inst(access='write', client=None, http=None, **cfg):
    glb = make_global(
        IGlobal,
        cfg_with(API_CFG, access=access, **cfg),
        client=client or FakeSupabaseClient(),
        http=http or FakeHttpClient({BROADCAST: FakeResponse(202)}),
    )
    return make_instance(IInstance, glb)


def _rpc_calls(client):
    """(schema, function, params) for every pgmq_public RPC made."""
    schemas = [a[0] for a, _ in client.calls_to('schema')]
    rpcs = client.calls_to('schema.rpc')
    return [(s, a[0], a[1]) for s, (a, _) in zip(schemas, rpcs)]


# -----------------------------------------------------------------------------
# Registration and settings
# -----------------------------------------------------------------------------


def test_tool_levels():
    assert tool_levels(IInstance) == {
        'broadcast': 'write',
        'queue_send': 'write',
        'queue_read': 'write',
        'queue_pop': 'write',
        'queue_archive': 'write',
        'queue_delete': 'write',
    }


def test_services_file():
    svc = load_service('messaging')
    assert svc['protocol'] == 'tool_supabase_messaging://'
    assert svc['prefix'] == IGlobal.SERVICE == 'supabase_messaging'
    assert svc['path'] == 'nodes.supabase.messaging'
    assert svc['classType'] == ['tool'] and svc['capabilities'] == ['invoke'] and svc['lanes'] == {}
    assert svc['icon'] == 'supabase.svg'
    assert svc['documentation'] == 'https://docs.rocketride.org/nodes/supabase/messaging'
    profile = svc['preconfig']['profiles'][svc['preconfig']['default']]
    assert profile['authType'] == 'key' and profile['access'] == 'read'
    props = svc['shape'][0]['properties']
    assert props[:2] == ['supabase.authType', 'supabase.access']
    shared = {'authType', 'url', 'secretKey', 'access', 'host', 'user', 'password', 'database'}
    defaults = {'maxReadCount': 100, 'maxVisibilitySeconds': 3600, 'maxDelaySeconds': 3600, 'maxPayloadKb': 256}
    for field_id, spec in svc['fields'].items():
        if field_id == 'supabase.access':
            continue
        key = field_id.rsplit('.', 1)[-1]
        assert field_id.startswith('supabase_messaging.') and key not in shared
        assert field_id in props
        assert spec['default'] == profile[key] == defaults[key]
        assert spec['minimum'] <= spec['default'] <= spec['maximum']


def test_settings_defaults_and_clamps():
    glb = _inst().IGlobal
    assert (glb.max_read_count, glb.max_visibility_seconds, glb.max_delay_seconds, glb.max_payload_kb) == (
        100,
        3600,
        3600,
        256,
    )
    glb = _inst(maxReadCount=5000, maxPayloadKb=99999).IGlobal
    assert glb.max_read_count == 1000 and glb.max_payload_kb == 3072


@pytest.mark.parametrize('field,blank', [('secretKey', '  '), ('url', '')])
def test_blank_required_fields_stop_startup(field, blank):
    with pytest.raises(ValueError, match='^supabase_messaging: (Secret key|Project URL) is required'):
        make_global(IGlobal, cfg_with(API_CFG, **{field: blank}))


# -----------------------------------------------------------------------------
# Access levels
# -----------------------------------------------------------------------------

_MINIMAL_ARGS = {
    'broadcast': {'channel': 'room', 'event': 'e'},
    'queue_send': {'queue': 'jobs', 'message': {'a': 1}},
    'queue_read': {'queue': 'jobs'},
    'queue_pop': {'queue': 'jobs'},
    'queue_archive': {'queue': 'jobs', 'message_id': 1},
    'queue_delete': {'queue': 'jobs', 'message_id': 1},
}


@pytest.mark.parametrize('tool', sorted(_MINIMAL_ARGS))
def test_read_level_refuses_every_tool(tool):
    client, http = FakeSupabaseClient(), FakeHttpClient()
    inst = _inst('read', client=client, http=http)
    with pytest.raises(PermissionError, match=f'supabase_messaging.{tool} needs the "write" access level'):
        getattr(inst, tool)(_MINIMAL_ARGS[tool])
    assert client.calls == [] and http.requests == []


@pytest.mark.parametrize('access', ['write', 'admin'])
@pytest.mark.parametrize('tool', sorted(_MINIMAL_ARGS))
def test_write_and_admin_allow_every_tool(tool, access):
    client = FakeSupabaseClient({RPC: _Resp([])})
    getattr(_inst(access, client=client), tool)(_MINIMAL_ARGS[tool])


# -----------------------------------------------------------------------------
# broadcast
# -----------------------------------------------------------------------------


def test_broadcast_posts_the_realtime_message():
    http = FakeHttpClient({BROADCAST: FakeResponse(202)})
    out = _inst(http=http).broadcast({'channel': 'room-1', 'event': 'new-order', 'payload': {'id': 7}})
    assert out == {'ok': True, 'channel': 'room-1', 'event': 'new-order', 'private': False}
    (req,) = http.requests
    assert req['method'] == 'POST' and req['path'] == '/realtime/v1/api/broadcast'
    assert req['json'] == {
        'messages': [{'topic': 'room-1', 'event': 'new-order', 'payload': {'id': 7}, 'private': False}]
    }
    assert req['headers']['apikey'] == FAKE_SECRET_KEY
    assert_no_secrets(out)


def test_broadcast_private_and_default_payload():
    http = FakeHttpClient({BROADCAST: FakeResponse(202)})
    _inst(http=http).broadcast({'channel': 'c', 'event': 'e', 'private': True})
    assert http.requests[0]['json']['messages'][0] == {'topic': 'c', 'event': 'e', 'payload': {}, 'private': True}


@pytest.mark.parametrize(
    'args,match',
    [
        ({'event': 'e'}, '"channel" is required'),
        ({'channel': 'c'}, '"event" is required'),
        ({'channel': 'c' * 256, 'event': 'e'}, 'at most 255'),
        ({'channel': 'c', 'event': 'e', 'payload': [1]}, '"payload" must be a JSON object'),
        ({'channel': 'c', 'event': 'e', 'private': 'yes'}, '"private" must be a boolean'),
    ],
)
def test_broadcast_input_errors(args, match):
    http = FakeHttpClient()
    with pytest.raises(ValueError, match=match):
        _inst(http=http).broadcast(args)
    assert http.requests == []


def test_broadcast_payload_size_limit():
    http = FakeHttpClient({BROADCAST: FakeResponse(202)})
    with pytest.raises(ValueError, match='limit is 1 KB'):
        _inst(http=http, maxPayloadKb=1).broadcast({'channel': 'c', 'event': 'e', 'payload': {'x': 'y' * 2000}})
    assert http.requests == []


def test_broadcast_backend_error_is_redacted():
    http = FakeHttpClient({BROADCAST: FakeResponse(403, {'message': f'bad key {FAKE_SECRET_KEY}'})})
    with pytest.raises(sc.SupabaseError) as err:
        _inst(http=http).broadcast({'channel': 'c', 'event': 'e'})
    assert err.value.status == 403
    assert str(err.value).startswith('supabase_messaging.broadcast: Realtime broadcast failed (HTTP 403)')
    assert_no_secrets(str(err.value))


# -----------------------------------------------------------------------------
# Queues
# -----------------------------------------------------------------------------


def test_queue_send_calls_pgmq_public_send():
    client = FakeSupabaseClient({RPC: _Resp([42])})
    out = _inst(client=client).queue_send({'queue': 'jobs', 'message': {'task': 'x'}, 'delay_seconds': 5})
    assert out == {'queue': 'jobs', 'message_id': 42}
    assert _rpc_calls(client) == [
        ('pgmq_public', 'send', {'queue_name': 'jobs', 'message': {'task': 'x'}, 'sleep_seconds': 5})
    ]


def test_queue_send_defaults_and_bounds():
    client = FakeSupabaseClient({RPC: _Resp([1])})
    inst = _inst(client=client, maxDelaySeconds=10)
    inst.queue_send({'queue': 'jobs', 'message': 'plain text'})
    assert _rpc_calls(client)[0][2]['sleep_seconds'] == 0
    with pytest.raises(ValueError, match='"delay_seconds" must be an integer between 0 and 10'):
        inst.queue_send({'queue': 'jobs', 'message': {}, 'delay_seconds': 11})
    with pytest.raises(ValueError, match='"message" is required'):
        inst.queue_send({'queue': 'jobs'})
    with pytest.raises(ValueError, match='limit is 1 KB'):
        _inst(client=client, maxPayloadKb=1).queue_send({'queue': 'jobs', 'message': 'x' * 2000})


@pytest.mark.parametrize('name', ['', 'a b', 'jobs;drop', '../x', 'q' * 48, '-lead'])
def test_queue_name_is_validated(name):
    client = FakeSupabaseClient()
    with pytest.raises(ValueError, match='"queue"'):
        _inst(client=client).queue_pop({'queue': name})
    assert client.calls == []


def test_queue_read_returns_messages():
    rows = [
        {'msg_id': 1, 'read_ct': 1, 'enqueued_at': 't0', 'vt': 't1', 'message': {'n': 1}},
        {'msg_id': 2, 'read_ct': 3, 'enqueued_at': 't0', 'vt': 't1', 'message': {'n': 2}},
    ]
    client = FakeSupabaseClient({RPC: _Resp(rows)})
    out = _inst(client=client).queue_read({'queue': 'jobs', 'count': 2, 'visibility_seconds': 60})
    assert out == {'queue': 'jobs', 'messages': rows, 'count': 2}
    assert _rpc_calls(client) == [('pgmq_public', 'read', {'queue_name': 'jobs', 'sleep_seconds': 60, 'n': 2})]


def test_queue_read_defaults_cap_and_bounds():
    client = FakeSupabaseClient({RPC: _Resp([])})
    inst = _inst(client=client, maxReadCount=5, maxVisibilitySeconds=20)
    out = inst.queue_read({'queue': 'jobs'})
    # Default count 1; default visibility 30 is lowered to the configured maximum.
    assert _rpc_calls(client)[-1][2] == {'queue_name': 'jobs', 'sleep_seconds': 20, 'n': 1}
    assert out == {'queue': 'jobs', 'messages': [], 'count': 0}
    out = inst.queue_read({'queue': 'jobs', 'count': 50})
    assert _rpc_calls(client)[-1][2]['n'] == 5 and out['count_capped_to'] == 5
    with pytest.raises(ValueError, match='"visibility_seconds" must be an integer between 0 and 20'):
        inst.queue_read({'queue': 'jobs', 'visibility_seconds': 21})
    with pytest.raises(ValueError, match='"count" must be an integer >= 1'):
        inst.queue_read({'queue': 'jobs', 'count': 0})


def test_queue_read_returns_message_bodies_as_stored():
    # A queue body is user data: a key that happens to be named like a secret
    # is kept, so the worker reading the job gets the job it was sent.
    rows = [{'msg_id': 1, 'message': {'user': 'a', 'password_reset': True, 'access_token': 'job-field'}}]
    out = _inst(client=FakeSupabaseClient({RPC: _Resp(rows)})).queue_read({'queue': 'jobs'})
    assert out['messages'] == rows


def test_queue_read_masks_the_configured_secret_key():
    rows = [{'msg_id': 1, 'message': {'echo': FAKE_SECRET_KEY}}]
    out = _inst(client=FakeSupabaseClient({RPC: _Resp(rows)})).queue_read({'queue': 'jobs'})
    assert_no_secrets(out, FAKE_SECRET_KEY)
    assert out['messages'][0]['message']['echo'] == '***'


def test_queue_read_leaves_out_bodies_above_the_payload_limit():
    """Another producer can write any size into pgmq; the agent gets the msg_id and size, not the body."""
    big = {'blob': 'x' * 3000}
    rows = [
        {'msg_id': 1, 'read_ct': 1, 'enqueued_at': 't0', 'vt': 't1', 'message': {'n': 1}},
        {'msg_id': 2, 'read_ct': 1, 'enqueued_at': 't0', 'vt': 't1', 'message': big},
    ]
    out = _inst(client=FakeSupabaseClient({RPC: _Resp(rows)}), maxPayloadKb=1).queue_read({'queue': 'jobs', 'count': 2})
    assert out['messages'][0] == rows[0]
    assert out['messages'][1] == {
        'msg_id': 2,
        'read_ct': 1,
        'enqueued_at': 't0',
        'vt': 't1',
        'message': None,
        'message_bytes': len('{"blob":"' + 'x' * 3000 + '"}'),
        'message_omitted': True,
    }
    assert out['count'] == 2


def test_queue_pop_returns_a_large_body_whole():
    """queue_pop has already deleted the message: leaving its body out would lose it."""
    row = {'msg_id': 9, 'message': {'blob': 'x' * 3000}}
    out = _inst(client=FakeSupabaseClient({RPC: _Resp([row])}), maxPayloadKb=1).queue_pop({'queue': 'jobs'})
    assert out['message'] == row


def test_refused_timing_is_stated_to_the_agent():
    """delay_seconds and visibility_seconds are refused, not lowered; the agent must read that."""
    for name, key in (('queue_send', 'delay_seconds'), ('queue_read', 'visibility_seconds')):
        meta = getattr(IInstance, name).__tool_meta__
        assert 'refused (not lowered)' in meta['description'], name
        assert 'refused (not lowered)' in meta['input_schema']['properties'][key]['description'], name


def test_queue_pop():
    row = {'msg_id': 9, 'read_ct': 0, 'enqueued_at': 't', 'vt': 't', 'message': {'k': 'v'}}
    client = FakeSupabaseClient({RPC: _Resp([row])})
    assert _inst(client=client).queue_pop({'queue': 'jobs'}) == {'queue': 'jobs', 'message': row}
    assert _rpc_calls(client) == [('pgmq_public', 'pop', {'queue_name': 'jobs'})]
    empty = _inst(client=FakeSupabaseClient({RPC: _Resp([])})).queue_pop({'queue': 'jobs'})
    assert empty == {'queue': 'jobs', 'message': None}


@pytest.mark.parametrize('tool,function', [('queue_archive', 'archive'), ('queue_delete', 'delete')])
@pytest.mark.parametrize('data,ok', [(True, True), ([True], True), (False, False), ([], False)])
def test_queue_archive_and_delete(tool, function, data, ok):
    client = FakeSupabaseClient({RPC: _Resp(data)})
    out = getattr(_inst(client=client), tool)({'queue': 'jobs', 'message_id': 7})
    assert out == {'queue': 'jobs', 'message_id': 7, 'ok': ok}
    assert _rpc_calls(client) == [('pgmq_public', function, {'queue_name': 'jobs', 'message_id': 7})]


@pytest.mark.parametrize('bad', [0, -1, 'abc', 1.5, True, None])
def test_message_id_is_validated(bad):
    with pytest.raises(ValueError, match='"message_id"'):
        _inst().queue_delete({'queue': 'jobs', 'message_id': bad})


# -----------------------------------------------------------------------------
# Queue error mapping
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    'error,match,status',
    [
        (
            FakeApiError('PGRST106', 'Invalid schema: pgmq_public', 'Only the following schemas are exposed: public'),
            "turn on 'Expose Queues via PostgREST'",
            406,
        ),
        (FakeApiError(None, 'Invalid schema: pgmq_public'), 'Expose Queues via PostgREST', 406),
        (
            FakeApiError('PGRST202', 'Could not find the function pgmq_public.send'),
            r'pgmq_public\.send was not found.*Expose Queues',
            404,
        ),
        (
            FakeApiError('42501', 'permission denied for table q_jobs'),
            "Permission denied on queue 'jobs'.*service_role",
            403,
        ),
        (FakeApiError('42P01', 'relation "pgmq.q_jobs" does not exist'), "Queue 'jobs' does not exist", 404),
    ],
)
def test_queue_setup_errors_are_explained(error, match, status):
    inst = _inst(client=FakeSupabaseClient({RPC: error}))
    with pytest.raises(sc.SupabaseError, match=match) as err:
        inst.queue_send({'queue': 'jobs', 'message': {}})
    assert str(err.value).startswith('supabase_messaging.queue_send: ')
    assert err.value.status == status
    assert err.value.__cause__ is None


def test_other_queue_errors_are_described_and_redacted():
    error = FakeApiError('XX000', f'boom near {FAKE_SECRET_KEY}')
    with pytest.raises(RuntimeError) as err:
        _inst(client=FakeSupabaseClient({RPC: error})).queue_read({'queue': 'jobs'})
    assert str(err.value).startswith('supabase_messaging.queue_read: (XX000) boom near ***')
    assert_no_secrets(str(err.value))
