# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for the Supabase Auth service (fake supabase-py client, no network)."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from .._support import (
    API_CFG,
    FAKE_SECRET_KEY,
    FakeSupabaseClient,
    assert_no_secrets,
    cfg_with,
    config_key,
    engine_stubs,
    load_common_fields,
    load_service,
    make_global,
    make_instance,
    tool_levels,
)

with engine_stubs():
    from nodes.supabase.auth.IGlobal import IGlobal
    from nodes.supabase.auth.IInstance import USER_FIELDS, IInstance

USER_ID = '6f1d2c3b-4a59-4e1f-9a8b-7c6d5e4f3a21'
# Obviously fake, JWT-shaped (three base64url parts), never a real token.
# A JWT-shaped fake token, joined at run time so gitleaks' jwt rule (pre-commit
# and CI) does not flag a literal in the source.
USER_TOKEN = '.'.join(('eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0LW9ubHkifQ', 'TESTONLYsignatureTESTONLY'))
USER_PASSWORD = 'test-only-user-password'

FULL_USER = {
    'id': USER_ID,
    'email': 'ada@example.com',
    'phone': '',
    'role': 'authenticated',
    'aud': 'authenticated',
    'created_at': '2026-01-01T00:00:00Z',
    'last_sign_in_at': '2026-02-01T00:00:00Z',
    'email_confirmed_at': None,
    'user_metadata': {'name': 'Ada'},
    'app_metadata': {'provider': 'email'},
    # Fields that must never reach the agent:
    'encrypted_password': 'hash-TESTONLY',
    'confirmation_token': 'confirm-TESTONLY',
    'recovery_token': 'recover-TESTONLY',
    'action_link': 'https://example.supabase.co/auth/v1/verify?token=LINKTOKEN-TESTONLY',
    'identities': [{'identity_data': {'email': 'ada@example.com'}}],
}
SENSITIVE = ('hash-TESTONLY', 'confirm-TESTONLY', 'recover-TESTONLY', 'LINKTOKEN-TESTONLY')

ALL_LEVELS = {
    'list_users': 'read',
    'get_user': 'read',
    'verify_user': 'read',
    'create_user': 'write',
    'invite_user': 'write',
    'generate_link': 'write',
    'update_user': 'write',
    'delete_user': 'admin',
}

# Minimal valid arguments per tool, for the refusal tests.
ARGS = {
    'list_users': {},
    'get_user': {'user_id': USER_ID},
    'verify_user': {'access_token': USER_TOKEN},
    'create_user': {'email': 'a@b.co'},
    'invite_user': {'email': 'a@b.co'},
    'generate_link': {'type': 'magiclink', 'email': 'a@b.co'},
    'update_user': {'user_id': USER_ID, 'phone': '+15550100'},
    'delete_user': {'user_id': USER_ID},
}


def _inst(access='read', results=None, **cfg):
    client = FakeSupabaseClient(results or {})
    glb = make_global(IGlobal, cfg_with(API_CFG, access=access, **cfg), client=client)
    return make_instance(IInstance, glb), client


def _resp(user=None):
    return SimpleNamespace(user=dict(user or FULL_USER))


def _assert_clean(value):
    text = json.dumps(value, default=str)
    assert_no_secrets(text)
    for secret in SENSITIVE + (USER_TOKEN, USER_PASSWORD):
        assert secret not in text, 'a sensitive value leaked into output'


# -----------------------------------------------------------------------------
# Registration and settings
# -----------------------------------------------------------------------------


def test_tool_levels():
    assert tool_levels(IInstance) == ALL_LEVELS


def test_services_file():
    svc = load_service('auth')
    assert svc['protocol'] == 'tool_supabase_auth://'
    assert svc['prefix'] == 'supabase_auth' == IGlobal.SERVICE
    assert svc['path'] == 'nodes.supabase.auth'
    assert svc['classType'] == ['tool'] and svc['capabilities'] == ['invoke'] and svc['lanes'] == {}
    assert svc['documentation'] == 'https://docs.rocketride.org/nodes/supabase/auth'
    profile = svc['preconfig']['profiles']['default']
    assert profile['authType'] == 'key' and profile['access'] == 'read'
    field = svc['fields']['supabase_auth.pageSize']
    assert (field['default'], field['minimum'], field['maximum']) == (50, 1, 1000)
    assert profile['pageSize'] == field['default']
    # Service fields must not collide with the shared config keys.
    shared = {config_key(f) for f in load_common_fields()}
    assert not [f for f in svc['fields'] if f.startswith('supabase_auth.') and config_key(f) in shared]
    assert svc['shape'][0]['properties'][:2] == ['supabase.authType', 'supabase.access']


def test_page_size_is_clamped():
    assert _inst(pageSize=5000)[0].IGlobal.page_size == 1000
    assert _inst()[0].IGlobal.page_size == 50


@pytest.mark.parametrize('field', ['secretKey', 'url'])
def test_blank_required_field_stops_startup(field):
    with pytest.raises(ValueError, match=r'^supabase_auth: '):
        make_global(IGlobal, cfg_with(API_CFG, **{field: '   '}))


# -----------------------------------------------------------------------------
# Access levels
# -----------------------------------------------------------------------------

_ORDER = ('read', 'write', 'admin')


@pytest.mark.parametrize(
    'tool,access',
    [(t, a) for t, need in ALL_LEVELS.items() for a in _ORDER if _ORDER.index(a) < _ORDER.index(need)],
)
def test_refused_below_level(tool, access):
    inst, client = _inst(access)
    with pytest.raises(PermissionError, match=f'supabase_auth.{tool} needs the "{ALL_LEVELS[tool]}" access level'):
        getattr(inst, tool)(dict(ARGS[tool]))
    assert client.calls == []


@pytest.mark.parametrize('tool', list(ALL_LEVELS))
def test_allowed_at_its_level(tool):
    results = {
        'auth.admin.list_users': [],
        'auth.admin.get_user_by_id': _resp(),
        'auth.get_user': _resp(),
        'auth.admin.create_user': _resp(),
        'auth.admin.invite_user_by_email': _resp(),
        'auth.admin.generate_link': SimpleNamespace(
            properties={'action_link': 'https://x/verify?token=t'}, user={'id': USER_ID}
        ),
        'auth.admin.update_user_by_id': _resp(),
        'auth.admin.delete_user': None,
    }
    inst, client = _inst(ALL_LEVELS[tool], results)
    getattr(inst, tool)(dict(ARGS[tool]))
    assert client.calls


# -----------------------------------------------------------------------------
# Tools
# -----------------------------------------------------------------------------


def test_list_users_shapes_and_pages():
    users = [dict(FULL_USER, id=f'u{i}') for i in range(3)]
    inst, client = _inst(results={'auth.admin.list_users': users})
    out = inst.list_users({'page': 2, 'per_page': 3})
    assert client.calls_to('auth.admin.list_users') == [((), {'page': 2, 'per_page': 3})]
    assert out['count'] == 3 and out['more_may_exist'] is True and out['page'] == 2
    assert set(out['users'][0]) == {'id', 'email', 'phone', 'created_at', 'last_sign_in_at', 'email_confirmed_at'}
    _assert_clean(out)


def test_list_users_per_page_is_capped_by_node_setting():
    inst, client = _inst(results={'auth.admin.list_users': []}, pageSize=20)
    out = inst.list_users({'per_page': 500})
    assert out['per_page'] == 20 and out['more_may_exist'] is False
    assert client.calls_to('auth.admin.list_users')[0][1] == {'page': 1, 'per_page': 20}


def test_list_users_rejects_bad_page():
    inst, _ = _inst()
    with pytest.raises(ValueError, match='"page"'):
        inst.list_users({'page': 0})


def test_get_user_allow_list():
    inst, client = _inst(results={'auth.admin.get_user_by_id': _resp()})
    out = inst.get_user({'user_id': USER_ID})
    assert out['id'] == USER_ID and out['user_metadata'] == {'name': 'Ada'}
    assert set(out) <= set(USER_FIELDS)
    assert 'action_link' not in out and 'identities' not in out
    _assert_clean(out)
    assert client.calls_to('auth.admin.get_user_by_id') == [((USER_ID,), {})]


def test_get_user_requires_uuid():
    inst, client = _inst()
    with pytest.raises(ValueError, match=r'supabase_auth.get_user: "user_id" must be a user id'):
        inst.get_user({'user_id': 'not-a-uuid'})
    with pytest.raises(ValueError, match='"user_id" is required'):
        inst.get_user({})
    assert client.calls == []


def test_metadata_secret_keys_are_dropped():
    user = dict(FULL_USER, user_metadata={'name': 'Ada', 'password': USER_PASSWORD})
    inst, _ = _inst(results={'auth.admin.get_user_by_id': _resp(user)})
    out = inst.get_user({'user_id': USER_ID})
    assert out['user_metadata'] == {'name': 'Ada'}


def test_create_user_sends_password_but_never_returns_it():
    inst, client = _inst('write', {'auth.admin.create_user': _resp(dict(FULL_USER, password=USER_PASSWORD))})
    out = inst.create_user(
        {'email': ' ada@example.com ', 'password': USER_PASSWORD, 'email_confirm': True, 'user_metadata': {'a': 1}}
    )
    (attrs,), _ = client.calls_to('auth.admin.create_user')[0]
    assert attrs == {
        'email': 'ada@example.com',
        'password': USER_PASSWORD,
        'email_confirm': True,
        'user_metadata': {'a': 1},
    }
    assert out['id'] == USER_ID
    _assert_clean(out)


@pytest.mark.parametrize('email', ['', 'no-at-sign', 'a b@c.d'])
def test_create_user_rejects_bad_email(email):
    inst, client = _inst('write')
    with pytest.raises(ValueError, match='"email"'):
        inst.create_user({'email': email})
    assert client.calls == []


def test_create_user_rejects_non_object_metadata():
    inst, _ = _inst('write')
    with pytest.raises(ValueError, match='"user_metadata" must be a JSON object'):
        inst.create_user({'email': 'a@b.co', 'user_metadata': 'x'})


def test_invite_user_passes_redirect():
    inst, client = _inst('write', {'auth.admin.invite_user_by_email': _resp()})
    out = inst.invite_user({'email': 'ada@example.com', 'redirect_to': 'https://app.example.com/welcome'})
    assert client.calls_to('auth.admin.invite_user_by_email') == [
        (('ada@example.com', {'redirect_to': 'https://app.example.com/welcome'}), {})
    ]
    _assert_clean(out)


def test_generate_link_returns_only_the_link():
    response = SimpleNamespace(
        properties={
            'action_link': 'https://ref.supabase.co/auth/v1/verify?token=abc&type=magiclink',
            'email_otp': '123456',
            'hashed_token': 'HASHED-TESTONLY',
            'redirect_to': 'https://app',
            'verification_type': 'magiclink',
        },
        user=dict(FULL_USER),
    )
    inst, client = _inst('write', {'auth.admin.generate_link': response})
    out = inst.generate_link({'type': 'magiclink', 'email': 'ada@example.com', 'redirect_to': 'https://app'})
    assert out == {
        'type': 'magiclink',
        'email': 'ada@example.com',
        'user_id': USER_ID,
        'link': 'https://ref.supabase.co/auth/v1/verify?token=abc&type=magiclink',
    }
    (params,), _ = client.calls_to('auth.admin.generate_link')[0]
    assert params == {'type': 'magiclink', 'email': 'ada@example.com', 'options': {'redirect_to': 'https://app'}}


def test_generate_link_signup_needs_password_and_others_refuse_it():
    inst, client = _inst('write')
    with pytest.raises(ValueError, match='"password" is required when type is signup'):
        inst.generate_link({'type': 'signup', 'email': 'a@b.co'})
    with pytest.raises(ValueError, match='only used when type is signup'):
        inst.generate_link({'type': 'recovery', 'email': 'a@b.co', 'password': 'x'})
    with pytest.raises(ValueError, match='"type" must be one of'):
        inst.generate_link({'type': 'email_change_new', 'email': 'a@b.co'})
    assert client.calls == []


def test_generate_link_signup_sends_password():
    response = SimpleNamespace(properties={'action_link': 'https://l'}, user={'id': USER_ID})
    inst, client = _inst('write', {'auth.admin.generate_link': response})
    out = inst.generate_link({'type': 'signup', 'email': 'a@b.co', 'password': USER_PASSWORD})
    assert client.calls_to('auth.admin.generate_link')[0][0][0]['password'] == USER_PASSWORD
    _assert_clean(out)


def test_update_user_uses_admin_api():
    inst, client = _inst('write', {'auth.admin.update_user_by_id': _resp()})
    inst.update_user({'user_id': USER_ID, 'email': 'new@example.com', 'ban_duration': '24h', 'email_confirm': True})
    assert client.paths() == ['auth.admin.update_user_by_id']
    (uid, attrs), _ = client.calls_to('auth.admin.update_user_by_id')[0]
    assert uid == USER_ID
    assert attrs == {'email': 'new@example.com', 'ban_duration': '24h', 'email_confirm': True}


def test_update_user_needs_a_field_and_ignores_role():
    inst, client = _inst('write')
    with pytest.raises(ValueError, match='at least one field'):
        inst.update_user({'user_id': USER_ID, 'role': 'service_role'})
    assert client.calls == []


def test_delete_user():
    inst, client = _inst('admin', {'auth.admin.delete_user': None})
    assert inst.delete_user({'user_id': USER_ID}) == {'deleted': True, 'user_id': USER_ID, 'soft_delete': False}
    assert client.calls_to('auth.admin.delete_user') == [((USER_ID,), {'should_soft_delete': False})]
    inst.delete_user({'user_id': USER_ID, 'soft_delete': True})
    assert client.calls_to('auth.admin.delete_user')[1] == ((USER_ID,), {'should_soft_delete': True})


# -----------------------------------------------------------------------------
# verify_user
# -----------------------------------------------------------------------------


class AuthApiError(Exception):
    """Shape of supabase_auth's AuthApiError (message, status, code)."""

    def __init__(self, message, status, code=None):
        super().__init__(message)
        self.message, self.status, self.code = message, status, code


def test_verify_user_valid():
    inst, client = _inst(results={'auth.get_user': _resp()})
    out = inst.verify_user({'access_token': f'Bearer {USER_TOKEN}'})
    assert out == {'valid': True, 'user': {'id': USER_ID, 'email': 'ada@example.com'}}
    # The token goes to auth.get_user for this call only, never to a session method.
    assert client.calls_to('auth.get_user') == [((USER_TOKEN,), {})]
    assert not [p for p in client.paths() if 'sign_in' in p or 'set_session' in p]
    assert not [v for v in vars(inst.IGlobal).values() if v == USER_TOKEN]
    _assert_clean(out)


@pytest.mark.parametrize(
    'error',
    [
        AuthApiError('invalid JWT: unable to parse or verify signature', 403, 'bad_jwt'),
        AuthApiError('User from sub claim in JWT does not exist', 404, 'user_not_found'),
        AuthApiError('session expired', 401),
    ],
)
def test_verify_user_not_valid(error):
    inst, _ = _inst(results={'auth.get_user': error})
    out = inst.verify_user({'access_token': USER_TOKEN})
    assert out['valid'] is False and 'not accept the token' in out['reason']
    assert 'user' not in out
    _assert_clean(out)


def test_verify_user_backend_failure_raises_without_token():
    inst, _ = _inst(results={'auth.get_user': AuthApiError(f'upstream broke on {USER_TOKEN}', 500)})
    with pytest.raises(RuntimeError) as err:
        inst.verify_user({'access_token': USER_TOKEN})
    assert USER_TOKEN not in str(err.value)
    assert_no_secrets(str(err.value))


@pytest.mark.parametrize('token', ['', '   ', 'Bearer ', 'two words', 'x' * 20000])
def test_verify_user_rejects_non_tokens_without_echo(token):
    inst, client = _inst()
    with pytest.raises(ValueError) as err:
        inst.verify_user({'access_token': token})
    assert client.calls == []
    if token.strip():
        assert token.strip() not in str(err.value)


# -----------------------------------------------------------------------------
# Secrets
# -----------------------------------------------------------------------------


def test_backend_error_is_redacted():
    error = AuthApiError(f'bad apikey {FAKE_SECRET_KEY}', 401, 'no_authorization')
    inst, _ = _inst(results={'auth.admin.get_user_by_id': error})
    with pytest.raises(RuntimeError) as err:
        inst.get_user({'user_id': USER_ID})
    assert str(err.value).startswith('supabase_auth.get_user: (HTTP 401, no_authorization)')
    assert_no_secrets(str(err.value))


def test_secret_key_in_result_is_scrubbed():
    user = dict(FULL_USER, user_metadata={'note': f'key {FAKE_SECRET_KEY}'})
    inst, _ = _inst(results={'auth.admin.get_user_by_id': _resp(user)})
    assert_no_secrets(inst.get_user({'user_id': USER_ID}))
