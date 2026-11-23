# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the Supabase Edge Functions service (fake HTTP client)."""

from __future__ import annotations

import json

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
    from nodes.supabase.functions.IGlobal import IGlobal
    from nodes.supabase.functions.IInstance import IInstance

HELLO = 'POST /functions/v1/hello'


def _inst(access='write', routes=None, **cfg):
    http = FakeHttpClient(routes if routes is not None else {HELLO: FakeResponse(200, {'msg': 'hi'})})
    glb = make_global(IGlobal, cfg_with(API_CFG, access=access, **cfg), client=FakeSupabaseClient(), http=http)
    return make_instance(IInstance, glb), http


# -----------------------------------------------------------------------------
# Registration and settings
# -----------------------------------------------------------------------------


def test_tool_levels():
    assert tool_levels(IInstance) == {'invoke_function': 'write'}


def test_services_file():
    svc = load_service('functions')
    assert svc['title'] == 'Supabase Edge Functions'
    assert svc['protocol'] == 'tool_supabase_functions://'
    assert svc['prefix'] == IGlobal.SERVICE == 'supabase_functions'
    assert svc['path'] == 'nodes.supabase.functions'
    assert svc['classType'] == ['tool'] and svc['capabilities'] == ['invoke'] and svc['lanes'] == {}
    assert svc['icon'] == 'supabase.svg'
    assert svc['documentation'] == 'https://docs.rocketride.org/nodes/supabase/functions'
    profile = svc['preconfig']['profiles'][svc['preconfig']['default']]
    assert profile['authType'] == 'key' and profile['access'] == 'read'
    props = svc['shape'][0]['properties']
    assert props[:2] == ['supabase.authType', 'supabase.access']
    shared = {'authType', 'url', 'secretKey', 'access', 'host', 'user', 'password', 'database'}
    defaults = {'timeoutSeconds': 60, 'maxResponseKb': 256, 'maxRequestKb': 1024}
    for field_id, spec in svc['fields'].items():
        if field_id == 'supabase.access':
            continue
        key = field_id.rsplit('.', 1)[-1]
        assert field_id.startswith('supabase_functions.') and key not in shared
        assert field_id in props
        assert spec['default'] == profile[key] == defaults[key]
        assert spec['minimum'] <= spec['default'] <= spec['maximum']
    assert 'compute' not in str(svc).lower()


def test_settings_defaults_and_clamps():
    glb = _inst()[0].IGlobal
    assert (glb.timeout_seconds, glb.max_response_kb, glb.max_request_kb) == (60, 256, 1024)
    glb = _inst(timeoutSeconds=9999, maxResponseKb=0)[0].IGlobal
    assert glb.timeout_seconds == 400 and glb.max_response_kb == 256


@pytest.mark.parametrize('field,blank', [('secretKey', ''), ('url', '   ')])
def test_blank_required_fields_stop_startup(field, blank):
    with pytest.raises(ValueError, match='^supabase_functions: (Secret key|Project URL) is required'):
        make_global(IGlobal, cfg_with(API_CFG, **{field: blank}))


# -----------------------------------------------------------------------------
# Access levels
# -----------------------------------------------------------------------------


def test_read_level_is_refused():
    inst, http = _inst('read')
    with pytest.raises(PermissionError, match='supabase_functions.invoke_function needs the "write" access level'):
        inst.invoke_function({'name': 'hello'})
    assert http.requests == []


@pytest.mark.parametrize('access', ['write', 'admin'])
def test_write_and_admin_are_allowed(access):
    inst, _ = _inst(access)
    assert inst.invoke_function({'name': 'hello'})['status'] == 200


# -----------------------------------------------------------------------------
# Requests
# -----------------------------------------------------------------------------


def test_invoke_posts_json_with_the_secret_key():
    inst, http = _inst()
    out = inst.invoke_function({'name': 'hello', 'body': {'name': 'Ada'}, 'headers': {'x-request-id': '42'}})
    assert out == {
        'name': 'hello',
        'status': 200,
        'ok': True,
        'content_type': 'application/json',
        'body': {'msg': 'hi'},
        'body_bytes': len('{"msg": "hi"}'),  # the raw bytes sent (FakeResponse: json.dumps)
        'truncated': False,
    }
    (req,) = http.requests
    assert req['method'] == 'POST' and req['path'] == '/functions/v1/hello'
    assert req['json'] == {'name': 'Ada'} and 'content' not in req
    assert req['headers']['apikey'] == FAKE_SECRET_KEY
    assert req['headers']['Authorization'] == f'Bearer {FAKE_SECRET_KEY}'
    assert req['headers']['x-request-id'] == '42'
    assert req['timeout'] == 60
    assert_no_secrets(out)


def test_text_body_and_method():
    routes = {'PUT /functions/v1/hello': FakeResponse(201, 'created')}
    inst, http = _inst(routes=routes, timeoutSeconds=5)
    out = inst.invoke_function({'name': 'hello', 'body': 'plain', 'method': 'put'})
    assert out['status'] == 201 and out['body'] == 'created' and out['content_type'] == 'text/plain'
    req = http.requests[0]
    assert req['content'] == b'plain' and 'json' not in req
    assert req['headers']['Content-Type'] == 'text/plain; charset=utf-8'
    assert req['timeout'] == 5


def test_get_without_body():
    inst, http = _inst(routes={'GET /functions/v1/hello': FakeResponse(204)})
    out = inst.invoke_function({'name': 'hello', 'method': 'GET'})
    assert out == {
        'name': 'hello',
        'status': 204,
        'ok': True,
        'content_type': '',
        'body': None,
        'body_bytes': 0,
        'truncated': False,
    }
    with pytest.raises(ValueError, match='GET request cannot have a body'):
        inst.invoke_function({'name': 'hello', 'method': 'GET', 'body': {'a': 1}})


@pytest.mark.parametrize('name', ['', '../rest/v1/users', 'hello/world', 'hello?x=1', '1abc', 'a' * 129, 'he llo'])
def test_function_name_is_validated(name):
    inst, http = _inst()
    with pytest.raises(ValueError, match='"name"'):
        inst.invoke_function({'name': name})
    assert http.requests == []


def test_method_is_validated():
    inst, http = _inst()
    with pytest.raises(ValueError, match='"method" must be one of'):
        inst.invoke_function({'name': 'hello', 'method': 'TRACE'})
    assert http.requests == []


@pytest.mark.parametrize(
    'header', ['Authorization', 'authorization', 'APIKEY', 'apikey', 'Host', 'Content-Length', 'Cookie']
)
def test_reserved_headers_are_refused(header):
    inst, http = _inst()
    with pytest.raises(ValueError, match='cannot be set'):
        inst.invoke_function({'name': 'hello', 'headers': {header: 'Bearer attacker'}})
    assert http.requests == []


@pytest.mark.parametrize(
    'headers,match',
    [
        ('x: y', '"headers" must be a JSON object'),
        ({'bad name': 'v'}, 'not a valid header name'),
        ({'x-a': 1}, 'must have a string value'),
        ({'x-a': 'one\r\nInjected: two'}, 'must be one line'),
        ({f'x-{i}': 'v' for i in range(21)}, 'at most 20 headers'),
    ],
)
def test_header_validation(headers, match):
    inst, http = _inst()
    with pytest.raises(ValueError, match=match):
        inst.invoke_function({'name': 'hello', 'headers': headers})
    assert http.requests == []


def test_request_size_limit():
    inst, http = _inst(maxRequestKb=1)
    with pytest.raises(ValueError, match='limit is 1 KB'):
        inst.invoke_function({'name': 'hello', 'body': {'x': 'y' * 2000}})
    assert http.requests == []


# -----------------------------------------------------------------------------
# Responses
# -----------------------------------------------------------------------------


def test_function_errors_are_returned_not_raised():
    inst, _ = _inst(routes={HELLO: FakeResponse(500, {'error': 'kaput'})})
    out = inst.invoke_function({'name': 'hello'})
    assert out['status'] == 500 and out['ok'] is False and out['body'] == {'error': 'kaput'}


def test_large_body_is_truncated():
    inst, _ = _inst(routes={HELLO: FakeResponse(200, 'é' * 1000)}, maxResponseKb=1)
    out = inst.invoke_function({'name': 'hello'})
    assert out['truncated'] is True and out['body_bytes'] == 2000
    assert len(out['body'].encode('utf-8')) <= 1024 and out['body'] == 'é' * 512
    assert 'first 1 KB' in out['note']


@pytest.mark.parametrize('kept', [4, 20, len(FAKE_SECRET_KEY) - 1])
def test_a_body_cut_inside_the_secret_key_shows_none_of_it(kept):
    """A function that echoes its headers (apikey, Authorization) can be cut mid-key at Max response size."""

    def echo(pad):
        return json.dumps(
            {'pad': pad, 'headers': {'apikey': FAKE_SECRET_KEY, 'authorization': f'Bearer {FAKE_SECRET_KEY}'}}
        )

    # Pad so the 1 KB cut falls `kept` characters into the second copy of the key.
    body = echo('x' * (1024 - kept - echo('').rindex(FAKE_SECRET_KEY)))
    assert body[:1024].endswith(FAKE_SECRET_KEY[:kept])
    resp = FakeResponse(200, body.encode(), headers={'content-type': 'application/json'})
    inst, _ = _inst(routes={HELLO: resp}, maxResponseKb=1)
    out = inst.invoke_function({'name': 'hello'})
    assert out['truncated'] is True and out['body'].endswith('Bearer ***')
    assert FAKE_SECRET_KEY[:4] not in out['body']
    assert_no_secrets(out)


def test_large_json_body_is_truncated_to_text():
    inst, _ = _inst(routes={HELLO: FakeResponse(200, {'rows': list(range(1000))})}, maxResponseKb=1)
    out = inst.invoke_function({'name': 'hello'})
    assert out['truncated'] is True and isinstance(out['body'], str) and out['body'].startswith('{"rows": [0, 1, 2')


def test_body_bytes_is_the_size_sent_not_a_re_serialised_copy():
    pretty = '{\n    "rows": [\n        1,\n        2\n    ]\n}'
    resp = FakeResponse(200, pretty.encode(), headers={'content-type': 'application/json'})
    inst, _ = _inst(routes={HELLO: resp})
    out = inst.invoke_function({'name': 'hello'})
    assert out['body'] == {'rows': [1, 2]} and out['body_bytes'] == len(pretty) and out['truncated'] is False


def test_large_body_is_never_read_into_memory():
    resp = FakeResponse(200, b'x' * (10 * 1024 * 1024), headers={'content-type': 'text/plain'})
    inst, http = _inst(routes={HELLO: resp}, maxResponseKb=1)
    out = inst.invoke_function({'name': 'hello'})
    assert out['truncated'] is True and len(out['body']) == 1024 and out['body_bytes'] == 10 * 1024 * 1024
    # Streamed: reading stopped after the first chunk, not after 10 MB.
    assert resp.bytes_streamed <= 64 * 1024
    assert http.requests[-1]['stream'] is True


def test_truncated_body_without_content_length_has_no_body_bytes():
    resp = FakeResponse(200, 'y' * 5000)
    del resp.headers['content-length']
    inst, _ = _inst(routes={HELLO: resp}, maxResponseKb=1)
    out = inst.invoke_function({'name': 'hello'})
    assert out['truncated'] is True and 'body_bytes' not in out


def test_binary_body_is_not_returned():
    resp = FakeResponse(200, b'\x89PNG\r\n\x1a\n\x00\x00', headers={'content-type': 'image/png'})
    inst, _ = _inst(routes={HELLO: resp})
    out = inst.invoke_function({'name': 'hello'})
    assert out['body'] is None and out['content_type'] == 'image/png' and 'Binary content' in out['note']


def test_echoed_secret_is_scrubbed():
    def echo(req):
        return FakeResponse(200, {'headers': dict(req['headers'])})

    inst, _ = _inst(routes={HELLO: echo})
    out = inst.invoke_function({'name': 'hello'})
    assert out['body']['headers']['apikey'] == '***'
    assert_no_secrets(out)


# -----------------------------------------------------------------------------
# Error mapping
# -----------------------------------------------------------------------------


def test_401_explains_verify_jwt():
    inst, _ = _inst(
        routes={HELLO: FakeResponse(401, {'code': 'UNAUTHORIZED_INVALID_JWT_FORMAT', 'message': 'Invalid JWT'})}
    )
    with pytest.raises(sc.SupabaseError) as err:
        inst.invoke_function({'name': 'hello'})
    message = str(err.value)
    assert err.value.status == 401
    assert message.startswith(
        "supabase_functions.invoke_function: Edge Function 'hello' refused the secret key (HTTP 401): Invalid JWT"
    )
    assert 'not JWTs' in message and 'Verify JWT' in message
    assert_no_secrets(message)


def test_gateway_404_names_the_function():
    inst, _ = _inst(
        routes={HELLO: FakeResponse(404, {'code': 'NOT_FOUND', 'message': 'Requested function was not found'})}
    )
    with pytest.raises(sc.SupabaseError, match="No Edge Function named 'hello' is deployed") as err:
        inst.invoke_function({'name': 'hello'})
    assert err.value.status == 404


@pytest.mark.parametrize(
    'body',
    [
        {'error': 'wrong password'},
        {'message': 'Unauthorized'},
        'denied',
        {'code': 'BAD_LOGIN'},
        # What a function writes after its own token check (or forwards from supabase-js getUser()).
        {'message': 'Invalid token'},
        {'message': 'Invalid JWT'},
        {'msg': 'invalid JWT', 'detail': 'expired'},
        {'message': 'Missing authorization header'},
        {'code': 'UNAUTHORIZED', 'message': 'no session'},
    ],
)
def test_function_own_401_is_returned_not_raised(body):
    inst, _ = _inst(routes={HELLO: FakeResponse(401, body)})
    out = inst.invoke_function({'name': 'hello'})
    assert out['status'] == 401 and out['ok'] is False and out['body'] == body


@pytest.mark.parametrize(
    'body', [{'msg': 'Invalid JWT'}, {'code': 'UNAUTHORIZED_NO_AUTH_HEADER', 'message': 'Missing authorization header'}]
)
def test_gateway_401_shapes_explain_verify_jwt(body):
    inst, _ = _inst(routes={HELLO: FakeResponse(401, body)})
    with pytest.raises(sc.SupabaseError, match='Verify JWT'):
        inst.invoke_function({'name': 'hello'})


def test_function_own_404_is_returned():
    inst, _ = _inst(routes={HELLO: FakeResponse(404, {'error': 'no such order'})})
    out = inst.invoke_function({'name': 'hello'})
    assert out['status'] == 404 and out['body'] == {'error': 'no such order'}


def test_network_error_is_redacted():
    inst, _ = _inst(routes={HELLO: ConnectionError(f'reset while sending {FAKE_SECRET_KEY}')})
    with pytest.raises(sc.SupabaseError) as err:
        inst.invoke_function({'name': 'hello'})
    assert str(err.value).startswith("supabase_functions.invoke_function: Edge Function 'hello' failed: reset")
    assert_no_secrets(str(err.value))
