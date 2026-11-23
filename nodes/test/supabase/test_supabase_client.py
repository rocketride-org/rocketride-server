# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for nodes/src/nodes/supabase/supabase_client.py (pure Python, no engine)."""

from __future__ import annotations

import base64
import json
import sys
from types import SimpleNamespace

import pytest

from ._support import (
    API_CFG,
    FAKE_DB_PASSWORD,
    FAKE_REF,
    FAKE_SECRET_KEY,
    PG_CFG,
    FakeHttpClient,
    FakePgConnection,
    FakeResponse,
    assert_no_secrets,
    cfg_with,
    install_fake_psycopg2,
    require_supabase_py,
)

# supabase_client imports nothing from the engine, so no stubs are needed.
from nodes.supabase import supabase_client as sc  # noqa: E402


def _jwt(role: str) -> str:
    def seg(obj):
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip('=')

    return f'{seg({"alg": "HS256"})}.{seg({"role": role, "iss": "supabase"})}.signaturepart123'


# -----------------------------------------------------------------------------
# Access levels
# -----------------------------------------------------------------------------


@pytest.mark.parametrize('value,expected', [(None, 'read'), ('', 'read'), (' Write ', 'write'), ('admin', 'admin')])
def test_normalize_access(value, expected):
    assert sc.normalize_access(value) == expected


@pytest.mark.parametrize('value', ['superuser', 3, 'readonly'])
def test_normalize_access_rejects_unknown(value):
    with pytest.raises(sc.SupabaseConfigError):
        sc.normalize_access(value)


@pytest.mark.parametrize(
    'node,needed,allowed',
    [
        ('read', 'read', True),
        ('read', 'write', False),
        ('read', 'admin', False),
        ('write', 'read', True),
        ('write', 'write', True),
        ('write', 'admin', False),
        ('admin', 'admin', True),
        ('admin', 'read', True),
    ],
)
def test_access_matrix(node, needed, allowed):
    assert sc.access_allows(node, needed) is allowed
    if allowed:
        sc.require_access(node, needed, 'supabase_x.tool')
    else:
        with pytest.raises(sc.SupabaseAccessError) as err:
            sc.require_access(node, needed, 'supabase_x.tool')
        message = str(err.value)
        assert 'supabase_x.tool' in message and f'"{needed}"' in message and f'"{node}"' in message
        assert isinstance(err.value, PermissionError)


# -----------------------------------------------------------------------------
# API connection
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    'raw,expected',
    [
        (f'https://{FAKE_REF}.supabase.co', f'https://{FAKE_REF}.supabase.co'),
        (f'https://{FAKE_REF}.supabase.co/', f'https://{FAKE_REF}.supabase.co'),
        (f'https://{FAKE_REF}.supabase.co/rest/v1/', f'https://{FAKE_REF}.supabase.co'),
        (f'{FAKE_REF}.supabase.co', f'https://{FAKE_REF}.supabase.co'),
        (FAKE_REF, f'https://{FAKE_REF}.supabase.co'),
        ('http://localhost:54321', 'http://localhost:54321'),
        ('http://127.0.0.1:8000', 'http://127.0.0.1:8000'),
        ('http://192.168.1.20:8000/', 'http://192.168.1.20:8000'),
        ('http://kong.localhost', 'http://kong.localhost'),
        # Self-hosted Supabase in docker-compose, reached by its service name.
        ('http://kong:8000', 'http://kong:8000'),
        ('http://supabase-kong:8000', 'http://supabase-kong:8000'),
        ('http://host.docker.internal:54321', 'http://host.docker.internal:54321'),
        ('http://supabase.local:8000', 'http://supabase.local:8000'),
        ('https://supabase.example.com/base/', 'https://supabase.example.com/base'),
        ('  ', ''),
        (None, ''),
    ],
)
def test_normalize_project_url(raw, expected):
    assert sc.normalize_project_url(raw) == expected


@pytest.mark.parametrize('raw', ['ftp://x.supabase.co', 'https://user:pw@x.supabase.co', 'https://x.supabase.co?a=1'])
def test_normalize_project_url_rejects(raw):
    with pytest.raises(sc.SupabaseConfigError):
        sc.normalize_project_url(raw)


@pytest.mark.parametrize(
    'raw',
    [
        f'http://{FAKE_REF}.supabase.co',
        'http://supabase.example.com',
        'http://kong.example.com',
        'http://8.8.8.8',
        'HTTP://x.supabase.co',
    ],
)
def test_plain_http_is_refused_outside_local_networks(raw):
    """The secret key goes in every request's headers: never over plain HTTP on the internet."""
    with pytest.raises(sc.SupabaseConfigError, match='must use https'):
        sc.normalize_project_url(raw)
    with pytest.raises(sc.SupabaseConfigError, match='must use https'):
        sc.resolve_api_connection(cfg_with(API_CFG, url=raw))


def test_project_ref_from_url():
    assert sc.project_ref_from_url(f'https://{FAKE_REF}.supabase.co') == FAKE_REF
    assert sc.project_ref_from_url('http://localhost:54321') == ''


def test_classify_key():
    assert sc.classify_key(FAKE_SECRET_KEY) == 'secret'
    assert sc.classify_key('sb_publishable_abc') == 'publishable'
    assert sc.classify_key(_jwt('service_role')) == 'service_role'
    assert sc.classify_key(_jwt('anon')) == 'anon'
    assert sc.classify_key('whatever') == 'unknown'


def test_resolve_api_connection_and_repr_hides_key():
    conn = sc.resolve_api_connection(API_CFG)
    assert conn.url == API_CFG['url'] and conn.secret_key == FAKE_SECRET_KEY and conn.project_ref == FAKE_REF
    assert conn.auth_type == 'key'
    assert_no_secrets(repr(conn))
    assert_no_secrets(str(conn))


def test_missing_auth_type_means_key():
    """Forward compatibility: a pipeline saved without authType stays key mode."""
    cfg = {k: v for k, v in API_CFG.items() if k != 'authType'}
    assert sc.resolve_api_connection(cfg).auth_type == 'key'
    assert sc.resolve_auth_type({'authType': ''}) == 'key'


def test_oauth_not_available_yet():
    with pytest.raises(sc.SupabaseConfigError, match='not available yet'):
        sc.resolve_auth_type({'authType': 'oauth'})


def test_legacy_service_role_key_is_accepted():
    cfg = cfg_with(API_CFG, secretKey=_jwt('service_role'))
    assert sc.resolve_api_connection(cfg).secret_key.startswith('eyJ')
    assert sc.api_config_problems(cfg) == []


@pytest.mark.parametrize('key', ['sb_publishable_abc123', _jwt('anon')])
def test_public_keys_are_refused(key):
    cfg = cfg_with(API_CFG, secretKey=key)
    with pytest.raises(sc.SupabaseConfigError):
        sc.resolve_api_connection(cfg)
    assert any('public' in p for p in sc.api_config_problems(cfg))


def test_api_config_problems():
    assert sc.api_config_problems(API_CFG) == []
    problems = sc.api_config_problems({})
    assert any('Project URL' in p for p in problems) and any('Secret key' in p for p in problems)
    for missing in ('url', 'secretKey'):
        with pytest.raises(sc.SupabaseConfigError):
            sc.resolve_api_connection(cfg_with(API_CFG, **{missing: ''}))


# -----------------------------------------------------------------------------
# Postgres connection
# -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    'raw,expected',
    [
        ('h.example.com', ('h.example.com', 5432)),
        ('h.example.com:6543', ('h.example.com', 6543)),
        ('[::1]:5433', ('::1', 5433)),
        ('[::1]', ('::1', 5432)),
    ],
)
def test_split_host_port(raw, expected):
    assert sc.split_host_port(raw) == expected


@pytest.mark.parametrize('raw', ['h:abc', 'h:0', 'h:70000'])
def test_split_host_port_bad_port(raw):
    with pytest.raises(sc.SupabaseConfigError):
        sc.split_host_port(raw)


# The two ways a user pastes the pooler password into the host field.
_PASTED_HOSTS = [
    f'postgres.{FAKE_REF}:{FAKE_DB_PASSWORD}@aws-0-eu-west-1.pooler.supabase.com',
    f'postgresql://postgres.{FAKE_REF}:{FAKE_DB_PASSWORD}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
]


@pytest.mark.parametrize('host', _PASTED_HOSTS)
def test_pasted_connection_string_in_host_is_refused_without_echoing_it(host):
    """The password must reach no problem text, exception or repr."""
    with pytest.raises(sc.SupabaseConfigError) as err:
        sc.split_host_port(host)
    assert 'not a connection string' in str(err.value)
    with pytest.raises(sc.SupabaseConfigError) as err:
        sc.resolve_postgres_connection(cfg_with(PG_CFG, host=host))
    assert_no_secrets(str(err.value))
    assert FAKE_DB_PASSWORD not in str(err.value)
    problems = sc.postgres_config_problems(cfg_with(PG_CFG, host=host))
    assert any('not a connection string' in p for p in problems)
    assert not any(FAKE_DB_PASSWORD in p for p in problems)


@pytest.mark.parametrize('raw', ['h:Hunter2Pass', 'h:70000'])
def test_bad_port_message_does_not_echo_the_value(raw):
    with pytest.raises(sc.SupabaseConfigError) as err:
        sc.split_host_port(raw)
    assert raw.split(':')[1] not in str(err.value) and '1 to 65535' in str(err.value)


def test_resolve_postgres_connection():
    conn = sc.resolve_postgres_connection(PG_CFG)
    assert (conn.host, conn.port, conn.user, conn.database) == (
        'aws-0-eu-west-1.pooler.supabase.com',
        5432,
        f'postgres.{FAKE_REF}',
        'postgres',
    )
    assert conn.password == FAKE_DB_PASSWORD
    assert_no_secrets(repr(conn))


def test_password_whitespace_is_kept():
    conn = sc.resolve_postgres_connection(cfg_with(PG_CFG, password=' pw '))
    assert conn.password == ' pw '


@pytest.mark.parametrize('password', ['   ', '\t\n'])
def test_whitespace_only_password_is_missing(password):
    with pytest.raises(sc.SupabaseConfigError, match='Database password is required'):
        sc.resolve_postgres_connection(cfg_with(PG_CFG, password=password))
    assert any('password is required' in p for p in sc.postgres_config_problems(cfg_with(PG_CFG, password=password)))


def test_postgres_config_problems():
    assert sc.postgres_config_problems(PG_CFG) == []
    assert any('project ref' in p for p in sc.postgres_config_problems(cfg_with(PG_CFG, user='postgres')))
    assert any('IPv6' in p for p in sc.postgres_config_problems(cfg_with(PG_CFG, host=f'db.{FAKE_REF}.supabase.co')))
    assert len(sc.postgres_config_problems({})) == 3


def test_postgres_connect_kwargs_require_tls():
    kwargs = sc.postgres_connect_kwargs(sc.resolve_postgres_connection(PG_CFG))
    assert kwargs['sslmode'] == 'require'
    # A man in the middle cannot ask for the password in clear text.
    assert kwargs['require_auth'] == 'scram-sha-256'
    assert kwargs['dbname'] == 'postgres' and kwargs['port'] == 5432


def test_connect_postgres_uses_tls(monkeypatch):
    state = install_fake_psycopg2(monkeypatch)
    conn = sc.connect_postgres(sc.resolve_postgres_connection(PG_CFG))
    assert isinstance(conn, FakePgConnection)
    assert state.connect_kwargs[0]['sslmode'] == 'require'


def test_connect_postgres_error_hides_password(monkeypatch):
    install_fake_psycopg2(monkeypatch, error=Exception(f'password authentication failed: {FAKE_DB_PASSWORD}\nDETAIL'))
    with pytest.raises(sc.SupabaseError) as err:
        sc.connect_postgres(sc.resolve_postgres_connection(PG_CFG))
    assert_no_secrets(str(err.value))
    assert 'password authentication failed' in str(err.value)
    assert err.value.__cause__ is None


# -----------------------------------------------------------------------------
# supabase-py client
# -----------------------------------------------------------------------------


def test_build_client_options(monkeypatch):
    """build_client turns session persistence and token refresh off (fake supabase module)."""
    seen = {}

    class Options:
        def __init__(self, **kw):
            seen['options'] = kw

    def create_client(url, key, options=None):
        seen['url'], seen['key'] = url, key
        return SimpleNamespace(url=url)

    supabase_mod = SimpleNamespace(create_client=create_client)
    monkeypatch.setitem(sys.modules, 'supabase', supabase_mod)
    monkeypatch.setitem(sys.modules, 'supabase.lib', SimpleNamespace())
    monkeypatch.setitem(sys.modules, 'supabase.lib.client_options', SimpleNamespace(SyncClientOptions=Options))
    sc.build_client(sc.resolve_api_connection(API_CFG), timeout=12)
    assert seen['url'] == API_CFG['url'] and seen['key'] == FAKE_SECRET_KEY
    assert seen['options']['auto_refresh_token'] is False and seen['options']['persist_session'] is False
    assert seen['options']['postgrest_client_timeout'] == 12


def test_build_client_with_real_supabase_py():
    """When supabase-py is installed, a client builds offline with an sb_secret_ key."""
    require_supabase_py()
    client = sc.build_client(sc.resolve_api_connection(API_CFG))
    assert str(client.auth_url).startswith(API_CFG['url'])
    assert client.options.headers['apiKey'] == FAKE_SECRET_KEY


# -----------------------------------------------------------------------------
# HTTP helper
# -----------------------------------------------------------------------------


def _api(routes):
    http = FakeHttpClient(routes)
    return sc.SupabaseApi(sc.resolve_api_connection(API_CFG), http_client=http), http


def test_request_sends_key_headers_and_parses_json():
    api, http = _api({'POST /realtime/v1/api/broadcast': FakeResponse(202, {'ok': True})})
    result = api.request('post', '/realtime/v1/api/broadcast', json={'messages': []})
    assert result.ok and result.status == 202 and result.body == {'ok': True}
    req = http.requests[0]
    assert req['method'] == 'POST' and req['url'] == API_CFG['url'] + '/realtime/v1/api/broadcast'
    assert req['headers']['apikey'] == FAKE_SECRET_KEY
    assert req['headers']['Authorization'] == f'Bearer {FAKE_SECRET_KEY}'
    assert req['json'] == {'messages': []}


def test_request_merges_extra_headers_and_params():
    api, http = _api({'POST /rest/v1/rpc/send': FakeResponse(200, [1])})
    api.request('POST', '/rest/v1/rpc/send', json={}, headers={'Content-Profile': 'pgmq_public'}, params={'a': 1})
    assert http.requests[0]['headers']['Content-Profile'] == 'pgmq_public'
    assert http.requests[0]['params'] == {'a': 1}


@pytest.mark.parametrize('path', ['rest/v1', 'https://evil.example/x', '/x://y'])
def test_request_refuses_non_relative_paths(path):
    api, _ = _api({})
    with pytest.raises(ValueError):
        api.request('GET', path)


def test_request_error_status_raises_redacted():
    body = {'message': f'bad key {FAKE_SECRET_KEY}', 'code': 'PGRST'}
    api, _ = _api({'GET /rest/v1/x': FakeResponse(401, body)})
    with pytest.raises(sc.SupabaseError) as err:
        api.request('GET', '/rest/v1/x', what='Queue read')
    assert err.value.status == 401
    assert str(err.value).startswith('Queue read failed (HTTP 401): bad key')
    assert_no_secrets(str(err.value))


def test_request_without_raise_returns_result():
    api, _ = _api({'POST /functions/v1/hello': FakeResponse(500, 'boom')})
    result = api.request('POST', '/functions/v1/hello', raise_for_status=False)
    assert result.status == 500 and result.body == 'boom' and not result.ok


def test_request_transport_error_is_supabase_error():
    api, _ = _api({'GET /x': ConnectionError(f'connect failed apikey={FAKE_SECRET_KEY}')})
    with pytest.raises(sc.SupabaseError) as err:
        api.request('GET', '/x')
    assert_no_secrets(str(err.value))
    assert err.value.__cause__ is None


def test_request_max_bytes_streams_and_stops_early():
    big = FakeResponse(200, b'z' * (5 * 1024 * 1024), headers={'content-type': 'text/plain'})
    api, http = _api({'GET /big': big})
    result = api.request('GET', '/big', max_bytes=100)
    assert result.truncated and result.content == b'z' * 100 and result.body == 'z' * 100
    assert result.size == 5 * 1024 * 1024  # from Content-Length
    assert big.bytes_streamed <= 64 * 1024 and http.requests[0]['stream'] is True


def test_request_max_bytes_under_the_limit_parses_json():
    api, _ = _api({'GET /small': FakeResponse(200, {'a': 1})})
    result = api.request('GET', '/small', max_bytes=1024)
    assert not result.truncated and result.body == {'a': 1} and result.size == len(b'{"a": 1}')


def test_request_max_bytes_exactly_at_the_limit_is_not_truncated():
    api, _ = _api({'GET /x': FakeResponse(200, b'abcd', headers={'content-type': 'text/plain'})})
    result = api.request('GET', '/x', max_bytes=4)
    assert not result.truncated and result.content == b'abcd'


def test_request_max_bytes_cut_compressed_body_has_unknown_size():
    """The httpx client yields decoded bytes; a gzip Content-Length is the wire size, not the body's size."""
    httpx = pytest.importorskip('httpx')
    import gzip

    raw = b'a' * 1_000_000
    packed = gzip.compress(raw)

    def handler(request):
        return httpx.Response(
            200,
            content=packed,
            headers={'content-encoding': 'gzip', 'content-length': str(len(packed)), 'content-type': 'text/plain'},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    api = sc.SupabaseApi(sc.resolve_api_connection(API_CFG), http_client=client)
    cut = api.request('GET', '/big', max_bytes=262144)
    assert cut.truncated and cut.size is None and len(cut.content) == 262144
    whole = api.request('GET', '/big')
    assert not whole.truncated and whole.size == len(raw)


def test_request_max_bytes_cut_identity_body_keeps_content_length():
    big = FakeResponse(200, b'z' * 5000, headers={'content-type': 'text/plain', 'content-encoding': 'identity'})
    api, _ = _api({'GET /big': big})
    assert api.request('GET', '/big', max_bytes=100).size == 5000


def test_http_result_size_defaults_to_unknown():
    assert sc.HttpResult(status=200, headers={}, body=None).size is None


def test_close():
    api, http = _api({})
    api.close()
    assert http.closed


# -----------------------------------------------------------------------------
# Secret hygiene
# -----------------------------------------------------------------------------


def test_redactor_known_and_shaped_secrets():
    r = sc.Redactor([FAKE_SECRET_KEY, FAKE_DB_PASSWORD, None, ''])
    text = (
        f'key={FAKE_SECRET_KEY} pw={FAKE_DB_PASSWORD} other=sb_secret_zzzzzzzz '
        f'jwt={_jwt("service_role")} dsn=postgresql://postgres.ref:hunter2@host/db'
    )
    out = r.redact(text)
    for leaked in (FAKE_SECRET_KEY, FAKE_DB_PASSWORD, 'sb_secret_zzzzzzzz', 'hunter2', _jwt('service_role')):
        assert leaked not in out
    assert 'postgresql://postgres.ref:***@host/db' in out


# Header names and values are joined at run time so secret scanners (gitleaks)
# do not flag these fixtures as real credentials.
_AUTH, _APIKEY = 'Author' + 'ization', 'api' + 'key'
_VALUE = 'fake' + '-value-0123456789'


@pytest.mark.parametrize(
    'template',
    [
        'headers := \'{"%(auth)s": "Bearer %(value)s"}\'::jsonb',
        'headers := \'{"%(apikey)s": "%(value)s"}\'::jsonb',
        "jsonb_build_object('%(apikey)s', '%(value)s')",
        "jsonb_build_object('%(auth)s', 'Basic %(value)s')",
        'curl -H "%(auth)s: bearer %(value)s"',
    ],
)
def test_redactor_masks_header_values_written_in_sql(template):
    text = template % {'auth': _AUTH, 'apikey': _APIKEY, 'value': _VALUE}
    leaked = _VALUE
    out = sc.Redactor().redact(text)
    assert leaked not in out and '***' in out


# Credential shapes other than Supabase's, as pg_cron jobs store them.
_TOKEN = 'abcd' + '1234efgh5678'
_OTHER_SHAPES = [
    "jsonb_build_object('%s','Bearer ' || '%s')" % (_AUTH, _TOKEN),
    "jsonb_build_object('%s', concat('Bearer ', '%s'))" % (_AUTH, _TOKEN),
    '\'{"X-Webhook-' + 'Secret":"%s"}\'' % _TOKEN,
    "url:='https://hooks.example.com/x?to" + "ken=%s'" % _TOKEN,
    "dblink('host=db.example.com user=postgres pass" + "word=%s dbname=x', 'select 1')" % _TOKEN,
]


@pytest.mark.parametrize('text', _OTHER_SHAPES)
def test_redactor_masks_other_credential_shapes(text):
    out = sc.Redactor().redact(text)
    assert _TOKEN not in out and '***' in out


def test_redactor_keeps_prose_about_bearer_tokens():
    assert sc.Redactor().redact('Bearer token missing') == 'Bearer token missing'


def test_scrub_only_replaces_configured_secrets():
    r = sc.Redactor([FAKE_SECRET_KEY])
    value = {'a': [f'x{FAKE_SECRET_KEY}y', {'b': FAKE_SECRET_KEY}], 'jwt_in_file': _jwt('anon'), 'n': 1}
    out = r.scrub(value)
    assert_no_secrets(out, FAKE_SECRET_KEY)
    assert out['jwt_in_file'] == _jwt('anon') and out['n'] == 1


def test_scrub_cut_masks_a_secret_cut_at_the_end():
    r = sc.Redactor([FAKE_SECRET_KEY])
    for size in (4, 10, len(FAKE_SECRET_KEY) - 1):
        out = r.scrub_cut(f'apikey: {FAKE_SECRET_KEY}, again: {FAKE_SECRET_KEY[:size]}')
        assert out == 'apikey: ***, again: ***', size
    # Three characters are no more than the public prefix: kept, as is text that only looks alike.
    assert r.scrub_cut('ends with sb_') == 'ends with sb_'
    assert r.scrub_cut('sb_secret_TESTONLY plus more') == 'sb_secret_TESTONLY plus more'
    assert sc.Redactor().scrub_cut('nothing configured') == 'nothing configured'


def test_drop_secret_fields():
    user = {
        'id': 'u1',
        'email': 'a@b.c',
        'encrypted_password': 'x',
        'identities': [{'id': 'i', 'access_token': 't'}],
        'action_link': 'https://...',
    }
    out = sc.drop_secret_fields(user)
    assert out == {'id': 'u1', 'email': 'a@b.c', 'identities': [{'id': 'i'}], 'action_link': 'https://...'}
    assert 'action_link' not in sc.drop_secret_fields(user, extra=['action_link'])
    assert sc.drop_secret_fields({'password': 'p'}, keep=['password']) == {'password': 'p'}


def test_to_plain():
    import datetime
    from dataclasses import dataclass

    @dataclass
    class D:
        a: int

    class Model:
        def model_dump(self, mode=None):
            return {'when': datetime.datetime(2026, 1, 2), 'mode': mode}

    out = sc.to_plain({'d': D(1), 'm': Model(), 'b': b'hi', 't': (1, 2), 'ns': SimpleNamespace(x=1, _y=2)})
    assert out == {
        'd': {'a': 1},
        'm': {'when': '2026-01-02T00:00:00', 'mode': 'json'},
        'b': 'aGk=',
        't': [1, 2],
        'ns': {'x': 1},
    }


def test_describe_exception():
    class AuthApiError(Exception):
        def __init__(self, message, status, code):
            super().__init__(message)
            self.message, self.status, self.code = message, status, code

    assert sc.describe_exception(AuthApiError('User not found', 404, 'user_not_found')) == (
        '(HTTP 404, user_not_found) User not found'
    )
    storage_exc = Exception({'statusCode': 400, 'error': 'Bucket not found', 'message': 'Bucket not found'})
    assert sc.describe_exception(storage_exc) == '(HTTP 400) Bucket not found'
    assert sc.describe_exception(ValueError('first\nsecond')) == 'first'
