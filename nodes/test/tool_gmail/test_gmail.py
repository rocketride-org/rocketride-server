# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the tool_gmail node (no network, no engine runtime).

Bootstrap mirrors test_tool_tavily.py: inject lightweight stubs for the engine
runtime modules ONLY if absent, import the module under test, then drop the
stubs so they never leak into a shared pytest session. The Google SDK is never
imported — IInstance receives a FakeGmail service and a real GoogleAccess.
"""

from __future__ import annotations

import base64
import importlib
import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

_SERVICES_JSON = _NODES_SRC / 'nodes' / 'tool_gmail' / 'services.json'


def _require_str(args, key, *, tool_name=''):
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{tool_name or key}: "{key}" is required')
    return value.strip()


def _build_import_stubs():
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f
    rocketlib.OPEN_MODE = MagicMock()
    rocketlib.warning = lambda *a, **kw: None

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}
    ai_common_utils.require_str = _require_str

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.config': MagicMock(),
    }


_added = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added.append(_name)

IInstance = importlib.import_module('nodes.tool_gmail.IInstance')
gmail_client = importlib.import_module('nodes.tool_gmail.gmail_client')
ga = importlib.import_module('nodes.core.google_access')

for _name in _added:
    sys.modules.pop(_name, None)


# ---------------------------------------------------------------------------
# Fake Gmail service: records terminal calls, returns canned results.
# ---------------------------------------------------------------------------

_RESOURCES = {
    'users',
    'messages',
    'threads',
    'labels',
    'drafts',
    'history',
    'attachments',
    # settings sub-resources
    'settings',
    'filters',
    'sendAs',
    'smimeInfo',
    'delegates',
    'forwardingAddresses',
}


class _Req:
    def __init__(self, result):
        self.result = result

    def execute(self):
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class _Node:
    def __init__(self, gm, path):
        self._gm = gm
        self._path = path

    def __getattr__(self, name):
        def method(**kwargs):
            if name in _RESOURCES:
                return _Node(self._gm, f'{self._path}.{name}')
            self._gm.calls.append((name, kwargs))
            return _Req(self._gm.results.get(name, {}))

        return method


class FakeGmail:
    def __init__(self, results=None):
        self.calls = []
        self.results = results or {}

    def users(self):
        return _Node(self, 'users')

    def call_for(self, op):
        return next((kw for n, kw in self.calls if n == op), None)


def make_inst(access_tier='modify', results=None, config=None):
    access = ga.resolve_google_access({'access': access_tier, **(config or {})}, ga.GMAIL)
    inst = IInstance.IInstance()
    inst.IGlobal = types.SimpleNamespace(service=FakeGmail(results or {}), access=access)
    return inst


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def test_message_list_shapes_refs():
    inst = make_inst(results={'list': {'messages': [{'id': 'a', 'threadId': 't1', 'x': 1}], 'resultSizeEstimate': 1}})
    out = inst.message_list({'query': 'is:unread'})
    assert out['messages'] == [{'id': 'a', 'threadId': 't1'}]
    assert out['resultSizeEstimate'] == 1
    assert inst.IGlobal.service.call_for('list')['q'] == 'is:unread'


def test_message_list_max_results_zero_clamps_not_defaults():
    # An explicit 0 must hit the clamp (-> 1), not silently become the default 25.
    inst = make_inst(results={'list': {'messages': []}})
    inst.message_list({'maxResults': 0})
    assert inst.IGlobal.service.call_for('list')['maxResults'] == 1


def test_message_list_max_results_absent_uses_default():
    inst = make_inst(results={'list': {'messages': []}})
    inst.message_list({})
    assert inst.IGlobal.service.call_for('list')['maxResults'] == 25


# ---------------------------------------------------------------------------
# Refresh URL allowlist (SSRF gate on the untrusted token payload)
# ---------------------------------------------------------------------------


def test_refresh_url_accepts_trusted_broker():
    url = 'https://oauth2.rocketride.ai/refresh'
    assert gmail_client.resolve_refresh_url(url) == url


def test_refresh_url_none_passes_through():
    assert gmail_client.resolve_refresh_url(None) is None
    assert gmail_client.resolve_refresh_url('') is None


@pytest.mark.parametrize(
    'bad',
    [
        'http://oauth2.rocketride.ai/refresh',  # scheme downgrade
        'https://evil.example.com/refresh',  # attacker host
        'https://oauth2.rocketride.ai.evil.com/refresh',  # suffix confusion
        'ftp://oauth2.rocketride.ai/refresh',
    ],
)
def test_refresh_url_rejects_untrusted(bad):
    with pytest.raises(ValueError):
        gmail_client.resolve_refresh_url(bad)


def test_refresh_url_rejects_non_string():
    with pytest.raises(ValueError):
        gmail_client.resolve_refresh_url({'url': 'https://oauth2.rocketride.ai'})


def test_refresh_url_env_override_adds_host(monkeypatch):
    monkeypatch.setenv('RR_OAUTH_BROKER_URL', 'https://broker.internal.example')
    url = 'https://broker.internal.example/refresh'
    assert gmail_client.resolve_refresh_url(url) == url
    # Built-in hosts still allowed alongside the override.
    assert gmail_client.resolve_refresh_url('https://oauth2.rocketride.ai/refresh')


def test_message_get_cleans_headers():
    raw = {
        'id': 'm1',
        'threadId': 't1',
        'labelIds': ['INBOX'],
        'snippet': 'hi',
        'payload': {'headers': [{'name': 'Subject', 'value': 'Hello'}, {'name': 'X-Spam', 'value': 'no'}]},
    }
    inst = make_inst(results={'get': raw})
    out = inst.message_get({'id': 'm1'})
    assert out['headers'] == {'Subject': 'Hello'}  # X-Spam dropped
    assert out['labelIds'] == ['INBOX']


def test_message_search_requires_query():
    inst = make_inst()
    with pytest.raises(ValueError):
        inst.message_search({})


def test_error_path_wraps_http_error():
    boom = RuntimeError('boom')
    inst = make_inst(results={'get': boom})
    with pytest.raises(ValueError) as exc:
        inst.message_get({'id': 'm1'})
    assert 'Gmail request failed' in str(exc.value)


# ---------------------------------------------------------------------------
# Write gating
# ---------------------------------------------------------------------------


def test_message_modify_blocked_on_readonly():
    inst = make_inst(access_tier='readonly')
    with pytest.raises(ga.GoogleAccessError):
        inst.message_modify({'id': 'm1', 'addLabelIds': ['STARRED']})


def test_read_state_via_unread_label():
    inst = make_inst(results={'modify': {'id': 'm1', 'labelIds': []}})
    inst.message_modify({'id': 'm1', 'removeLabelIds': ['UNREAD']})
    body = inst.IGlobal.service.call_for('modify')['body']
    assert body == {'removeLabelIds': ['UNREAD']}


def test_batch_modify_enforces_cap():
    inst = make_inst()
    too_many = [f'id{i}' for i in range(1001)]
    with pytest.raises(ValueError):
        inst.message_batch_modify({'ids': too_many, 'addLabelIds': ['X']})


def test_batch_modify_rejects_non_list():
    inst = make_inst()
    with pytest.raises(ValueError):
        inst.message_batch_modify({'ids': 'm1,m2', 'addLabelIds': ['X']})


def test_batch_modify_success():
    inst = make_inst(results={'batchModify': {}})
    out = inst.message_batch_modify({'ids': ['a', 'b'], 'addLabelIds': ['X']})
    assert out == {'modified': 2}
    assert inst.IGlobal.service.call_for('batchModify')['body'] == {'ids': ['a', 'b'], 'addLabelIds': ['X']}


# ---------------------------------------------------------------------------
# Send + reply threading
# ---------------------------------------------------------------------------


def test_send_blocked_without_send_scope():
    inst = make_inst(access_tier='modify')  # writable but no send scope
    with pytest.raises(ga.GoogleAccessError):
        inst.message_send({'to': 'a@x.com', 'subject': 'hi', 'body': 'yo'})


def test_send_reply_sets_threading_headers():
    thread = {
        'messages': [
            {
                'payload': {
                    'headers': [{'name': 'Message-Id', 'value': '<abc@x>'}, {'name': 'References', 'value': '<old@x>'}]
                }
            }
        ]
    }
    inst = make_inst(access_tier='send', results={'get': thread, 'send': {'id': 'sent', 'threadId': 't1'}})
    inst.message_send({'to': 'a@x.com', 'subject': 'Re: hi', 'body': 'reply', 'threadId': 't1'})
    send = inst.IGlobal.service.call_for('send')
    assert send['body']['threadId'] == 't1'
    decoded = base64.urlsafe_b64decode(send['body']['raw']).decode('utf-8', errors='replace')
    assert 'In-Reply-To: <abc@x>' in decoded
    assert 'References: <old@x> <abc@x>' in decoded


def test_send_from_full_tier_allowed():
    inst = make_inst(access_tier='full', results={'send': {'id': 's'}})
    out = inst.message_send({'to': 'a@x.com', 'subject': 's', 'body': 'b'})
    assert out['id'] == 's'


# ---------------------------------------------------------------------------
# Labels & drafts
# ---------------------------------------------------------------------------


def test_label_create_and_delete():
    inst = make_inst(results={'create': {'id': 'L1', 'name': 'Inv'}, 'delete': {}})
    assert inst.label_create({'name': 'Inv'})['id'] == 'L1'
    assert inst.label_delete({'id': 'L1'}) == {'deleted': True, 'id': 'L1'}


def test_draft_create_builds_message():
    inst = make_inst(results={'create': {'id': 'd1', 'message': {'id': 'm1', 'threadId': 't1'}}})
    out = inst.draft_create({'to': 'a@x.com', 'subject': 's', 'body': 'b'})
    assert out['id'] == 'd1'
    assert 'raw' in inst.IGlobal.service.call_for('create')['body']['message']


def test_draft_send_requires_send_scope():
    inst = make_inst(access_tier='modify')
    with pytest.raises(ga.GoogleAccessError):
        inst.draft_send({'id': 'd1'})


# ---------------------------------------------------------------------------
# Hard delete gate (full tier AND allowHardDelete flag; fail closed)
# ---------------------------------------------------------------------------


def test_hard_delete_blocked_without_full_tier():
    # Non-full tier cannot grant the permanent-delete scope, even with the flag.
    inst = make_inst(access_tier='send', config={'allowHardDelete': True})
    with pytest.raises(ga.GoogleAccessError):
        inst.message_delete({'id': 'm1'})


def test_hard_delete_blocked_without_flag():
    # The full tier alone is not consent: allowHardDelete must be enabled too.
    inst = make_inst(access_tier='full', results={'delete': {}})
    with pytest.raises(ga.GoogleAccessError):
        inst.message_delete({'id': 'm1'})
    with pytest.raises(ga.GoogleAccessError):
        inst.messages_batchDelete({'ids': ['a']})


def test_hard_delete_allowed_with_full_tier_and_flag():
    inst = make_inst(access_tier='full', results={'delete': {}}, config={'allowHardDelete': True})
    assert inst.message_delete({'id': 'm1'}) == {'deleted': True, 'id': 'm1'}


def test_batch_delete_enforces_cap_and_gate():
    inst = make_inst(access_tier='full', results={'batchDelete': {}}, config={'allowHardDelete': True})
    assert inst.messages_batchDelete({'ids': ['a', 'b', 'c']}) == {'deleted': 3}
    with pytest.raises(ValueError):
        inst.messages_batchDelete({'ids': [f'id{i}' for i in range(1001)]})


# ---------------------------------------------------------------------------
# services.json contract: GMAIL flag names exist as config fields
# ---------------------------------------------------------------------------


def test_services_json_declares_access_and_gmail_flags():
    fields = json.loads(_SERVICES_JSON.read_text(encoding='utf-8'))['fields']
    assert 'gmail.access' in fields
    # Every GMAIL spec flag must be exposed as a gmail.* config field.
    for flag in ga.GMAIL.flags:
        assert f'gmail.{flag}' in fields, f'missing config field for GMAIL flag {flag!r}'


# ---------------------------------------------------------------------------
# Mock run: build the Gmail client through the ROCKETRIDE_MOCK Google SDK stubs
# and exercise a call end-to-end (no network, no real google-api-python-client).
# ---------------------------------------------------------------------------


def test_mock_sdk_builds_service_and_lists(monkeypatch):
    mocks = Path(__file__).resolve().parents[1] / 'mocks'
    monkeypatch.syspath_prepend(str(mocks))
    from nodes.tool_gmail import gmail_client

    svc = gmail_client.build_service('service', {'serviceKey': '{"type": "service_account"}'}, ['scope'])
    data = gmail_client.execute(svc.users().messages().list(userId='me'))
    assert data['messages'][0]['id'] == 'mock1'


def test_mock_sdk_user_auth_builds_service(monkeypatch):
    mocks = Path(__file__).resolve().parents[1] / 'mocks'
    monkeypatch.syspath_prepend(str(mocks))
    from nodes.tool_gmail import gmail_client

    svc = gmail_client.build_service('user', {'userToken': '{"access_token": "mock-tok"}'}, ['scope'])
    assert gmail_client.execute(svc.users().labels().list(userId='me'))['labels'][0]['id'] == 'INBOX'


def test_expired_token_no_refresh_path_raises(monkeypatch):
    """Expired token with no oauth_server_url and no client creds → clear ValueError."""
    mocks = Path(__file__).resolve().parents[1] / 'mocks'
    monkeypatch.syspath_prepend(str(mocks))
    from nodes.tool_gmail import gmail_client
    import time

    expired_token = json.dumps(
        {
            'access_token': 'ya29.old',
            'refresh_token': '1//x',
            'expiry_date': int((time.time() - 3600) * 1000),  # 1 hour ago
        }
    )
    with pytest.raises(ValueError, match='expired'):
        gmail_client.build_service('user', {'userToken': expired_token}, ['scope'])


def test_valid_token_sets_expiry_on_credentials(monkeypatch):
    """A fresh token with expiry_date sets creds.expiry so the library won't auto-refresh."""
    mocks = Path(__file__).resolve().parents[1] / 'mocks'
    monkeypatch.syspath_prepend(str(mocks))
    from nodes.tool_gmail import gmail_client
    import time

    future_expiry_ms = int((time.time() + 3600) * 1000)
    token = json.dumps({'access_token': 'mock-tok', 'expiry_date': future_expiry_ms})
    svc = gmail_client.build_service('user', {'userToken': token}, ['scope'])
    assert svc is not None


def test_build_service_raises_on_scope_mismatch(monkeypatch):
    """Token with only gmail.modify scope should raise immediately when settings scopes are required."""
    mocks = Path(__file__).resolve().parents[1] / 'mocks'
    monkeypatch.syspath_prepend(str(mocks))
    from nodes.tool_gmail import gmail_client

    token = json.dumps(
        {
            'access_token': 'tok',
            'scope': 'https://www.googleapis.com/auth/gmail.modify',
        }
    )
    with pytest.raises(ValueError, match='missing required scopes'):
        gmail_client.build_service(
            'user',
            {'userToken': token},
            ['https://www.googleapis.com/auth/gmail.settings.basic'],
        )


def test_build_service_full_scope_token_not_blocked(monkeypatch):
    """https://mail.google.com/ (full scope) must not trigger the scope-mismatch check."""
    mocks = Path(__file__).resolve().parents[1] / 'mocks'
    monkeypatch.syspath_prepend(str(mocks))
    from nodes.tool_gmail import gmail_client

    token = json.dumps({'access_token': 'tok', 'scope': 'https://mail.google.com/'})
    svc = gmail_client.build_service(
        'user',
        {'userToken': token},
        ['https://www.googleapis.com/auth/gmail.settings.basic'],
    )
    assert svc is not None


def test_build_service_no_scope_field_does_not_raise(monkeypatch):
    """Token without a scope field should not trigger the scope check (broker may omit it)."""
    mocks = Path(__file__).resolve().parents[1] / 'mocks'
    monkeypatch.syspath_prepend(str(mocks))
    from nodes.tool_gmail import gmail_client

    token = json.dumps({'access_token': 'tok'})
    # Should not raise even though settings scope is required — no scope metadata to check against
    svc = gmail_client.build_service(
        'user',
        {'userToken': token},
        ['https://www.googleapis.com/auth/gmail.settings.basic'],
    )
    assert svc is not None


# ---------------------------------------------------------------------------
# services.json contract: all GMAIL tiers exist in the access enum
# ---------------------------------------------------------------------------


def test_services_json_access_enum_matches_gmail_spec():
    fields = json.loads(_SERVICES_JSON.read_text(encoding='utf-8'))['fields']
    enum_tiers = {v for v, _ in fields['gmail.access']['enum']}
    spec_tiers = set(ga.GMAIL.scopes)
    assert spec_tiers == enum_tiers, f'tier mismatch between GMAIL spec and services.json: {spec_tiers ^ enum_tiers}'


# ---------------------------------------------------------------------------
# Thread ops
# ---------------------------------------------------------------------------


def test_thread_modify_sets_labels():
    inst = make_inst(results={'modify': {'id': 't1', 'messages': []}})
    out = inst.thread_modify({'id': 't1', 'addLabelIds': ['STARRED']})
    body = inst.IGlobal.service.call_for('modify')['body']
    assert body == {'addLabelIds': ['STARRED']}
    assert out['id'] == 't1'


def test_thread_modify_requires_labels():
    inst = make_inst()
    with pytest.raises(ValueError):
        inst.thread_modify({'id': 't1'})


# ---------------------------------------------------------------------------
# check_connection diagnostics
# ---------------------------------------------------------------------------


def _inst_with_token(access_tier: str, token: dict | None) -> 'IInstance.IInstance':
    """Return an IInstance whose IGlobal.glb simulates a persisted user token."""
    inst = make_inst(access_tier)
    token_json = json.dumps(token) if token is not None else ''
    inst.IGlobal.glb = types.SimpleNamespace(logicalType='tool_gmail', connConfig={})
    inst.IGlobal._token_cfg = {'authType': 'user', 'userToken': token_json}
    return inst


def _patch_config(monkeypatch, inst):
    """Make Config.getNodeConfig return the inst's _token_cfg."""
    cfg_mod = MagicMock()
    cfg_mod.Config.getNodeConfig = MagicMock(return_value=inst.IGlobal._token_cfg)
    monkeypatch.setitem(sys.modules, 'ai.common.config', cfg_mod)


def test_check_connection_missing_scope(monkeypatch):
    """check_connection reports missing scopes and provides an action."""
    mocks = Path(__file__).resolve().parents[1] / 'mocks'
    monkeypatch.syspath_prepend(str(mocks))
    inst = _inst_with_token(
        'settings', {'access_token': 'tok', 'scope': 'https://www.googleapis.com/auth/gmail.modify'}
    )
    _patch_config(monkeypatch, inst)
    result = inst.check_connection({})
    assert not result['connection_ok']
    assert any('gmail.settings.basic' in s for s in result['missing_scopes'])
    assert result['action'] is not None


def test_check_connection_ok_with_full_scope(monkeypatch):
    """check_connection reports OK when the token carries https://mail.google.com/ (full scope)."""
    mocks = Path(__file__).resolve().parents[1] / 'mocks'
    monkeypatch.syspath_prepend(str(mocks))
    inst = _inst_with_token('settings', {'access_token': 'tok', 'scope': 'https://mail.google.com/'})
    _patch_config(monkeypatch, inst)
    result = inst.check_connection({})
    assert result['connection_ok']
    assert result['missing_scopes'] == []
    assert result['action'] is None


def test_thread_trash_and_untrash():
    inst = make_inst(results={'trash': {'id': 't1', 'messages': []}, 'untrash': {'id': 't1', 'messages': []}})
    assert inst.thread_trash({'id': 't1'})['id'] == 't1'
    assert inst.thread_untrash({'id': 't1'})['id'] == 't1'


def test_thread_delete_blocked_without_full_tier():
    inst = make_inst(access_tier='send')
    with pytest.raises(ga.GoogleAccessError):
        inst.thread_delete({'id': 't1'})


def test_thread_delete_allowed_with_full_tier():
    inst = make_inst(access_tier='full', results={'delete': {}}, config={'allowHardDelete': True})
    assert inst.thread_delete({'id': 't1'}) == {'deleted': True, 'id': 't1'}


def test_thread_delete_blocked_without_flag():
    inst = make_inst(access_tier='full', results={'delete': {}})
    with pytest.raises(ga.GoogleAccessError):
        inst.thread_delete({'id': 't1'})


# ---------------------------------------------------------------------------
# Message convenience wrappers
# ---------------------------------------------------------------------------


def test_message_archive_removes_inbox_label():
    inst = make_inst(results={'modify': {'id': 'm1', 'labelIds': []}})
    inst.message_archive({'id': 'm1'})
    body = inst.IGlobal.service.call_for('modify')['body']
    assert body == {'removeLabelIds': ['INBOX']}


def test_message_mark_read_removes_unread():
    inst = make_inst(results={'modify': {'id': 'm1', 'labelIds': []}})
    inst.message_mark_read({'id': 'm1'})
    assert inst.IGlobal.service.call_for('modify')['body'] == {'removeLabelIds': ['UNREAD']}


def test_message_mark_unread_adds_unread():
    inst = make_inst(results={'modify': {'id': 'm1', 'labelIds': ['UNREAD']}})
    inst.message_mark_unread({'id': 'm1'})
    assert inst.IGlobal.service.call_for('modify')['body'] == {'addLabelIds': ['UNREAD']}


def test_message_star_and_unstar():
    inst = make_inst(results={'modify': {'id': 'm1', 'labelIds': ['STARRED']}})
    inst.message_star({'id': 'm1'})
    assert inst.IGlobal.service.call_for('modify')['body'] == {'addLabelIds': ['STARRED']}

    inst2 = make_inst(results={'modify': {'id': 'm1', 'labelIds': []}})
    inst2.message_unstar({'id': 'm1'})
    assert inst2.IGlobal.service.call_for('modify')['body'] == {'removeLabelIds': ['STARRED']}


def test_message_convenience_blocked_on_readonly():
    inst = make_inst(access_tier='readonly')
    with pytest.raises(ga.GoogleAccessError):
        inst.message_archive({'id': 'm1'})


# ---------------------------------------------------------------------------
# message_get_body: MIME extraction
# ---------------------------------------------------------------------------


def test_message_get_body_extracts_text_and_html():
    import base64

    def _b64(s):
        return base64.urlsafe_b64encode(s.encode()).decode()

    raw_msg = {
        'id': 'm1',
        'threadId': 't1',
        'snippet': 'Hello',
        'payload': {
            'mimeType': 'multipart/alternative',
            'parts': [
                {'mimeType': 'text/plain', 'body': {'data': _b64('plain text')}},
                {'mimeType': 'text/html', 'body': {'data': _b64('<b>html</b>')}},
            ],
        },
    }
    inst = make_inst(results={'get': raw_msg})
    out = inst.message_get_body({'id': 'm1'})
    assert out['text'] == 'plain text'
    assert out['html'] == '<b>html</b>'


def test_message_get_body_nested_parts():
    """Nested multipart structure is recursed."""
    import base64

    def _b64(s):
        return base64.urlsafe_b64encode(s.encode()).decode()

    raw_msg = {
        'id': 'm2',
        'payload': {
            'mimeType': 'multipart/mixed',
            'parts': [
                {
                    'mimeType': 'multipart/alternative',
                    'parts': [
                        {'mimeType': 'text/plain', 'body': {'data': _b64('deep text')}},
                    ],
                },
            ],
        },
    }
    inst = make_inst(results={'get': raw_msg})
    out = inst.message_get_body({'id': 'm2'})
    assert out['text'] == 'deep text'
    assert out['html'] is None


# ---------------------------------------------------------------------------
# HTML send / attachments
# ---------------------------------------------------------------------------


def test_send_html_body_encodes_multipart():
    import base64

    inst = make_inst(access_tier='send', results={'get': {'messages': []}, 'send': {'id': 's1', 'threadId': 't1'}})
    inst.message_send({'to': 'a@x.com', 'subject': 'Hi', 'html_body': '<b>hello</b>'})
    send_kwargs = inst.IGlobal.service.call_for('send')
    raw = base64.urlsafe_b64decode(send_kwargs['body']['raw']).decode('utf-8', errors='replace')
    # The decoded MIME bytes always contain the Content-Type headers in plain text.
    assert 'text/html' in raw
    assert 'multipart/alternative' in raw


def test_send_with_attachment_encodes_attachment():
    import base64

    inst = make_inst(access_tier='send', results={'get': {'messages': []}, 'send': {'id': 's1', 'threadId': 't1'}})
    content_b64 = base64.b64encode(b'hello file').decode()
    inst.message_send(
        {
            'to': 'a@x.com',
            'subject': 'With attachment',
            'html_body': '<p>see attached</p>',
            'attachments': [{'filename': 'test.txt', 'content_base64': content_b64, 'mime_type': 'text/plain'}],
        }
    )
    send_kwargs = inst.IGlobal.service.call_for('send')
    raw = base64.urlsafe_b64decode(send_kwargs['body']['raw']).decode('utf-8', errors='replace')
    assert 'Content-Disposition: attachment' in raw
    assert 'test.txt' in raw


def test_draft_create_with_html_body():
    import base64

    inst = make_inst(results={'create': {'id': 'd1', 'message': {'id': 'm1', 'threadId': 't1'}}})
    inst.draft_create({'to': 'a@x.com', 'subject': 'Draft HTML', 'html_body': '<p>rich</p>'})
    create_kwargs = inst.IGlobal.service.call_for('create')
    raw = base64.urlsafe_b64decode(create_kwargs['body']['message']['raw']).decode('utf-8', errors='replace')
    assert 'text/html' in raw


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------


def test_filter_list_requires_settings_scope():
    inst = make_inst(access_tier='modify')  # modify doesn't have settings.basic
    with pytest.raises(ga.GoogleAccessError):
        inst.filter_list({})


def test_filter_list_with_settings_tier():
    inst = make_inst(access_tier='settings', results={'list': {'filter': [{'id': 'f1', 'criteria': {}, 'action': {}}]}})
    out = inst.filter_list({})
    assert out[0]['id'] == 'f1'


def test_filter_create_passes_body():
    inst = make_inst(
        access_tier='settings',
        results={'create': {'id': 'f2', 'criteria': {'from': 'x@y.com'}, 'action': {'addLabelIds': ['L1']}}},
    )
    out = inst.filter_create({'criteria': {'from': 'x@y.com'}, 'action': {'addLabelIds': ['L1']}})
    assert out['id'] == 'f2'
    body = inst.IGlobal.service.call_for('create')['body']
    assert body['criteria'] == {'from': 'x@y.com'}


def test_filter_create_rejects_non_dict_criteria():
    inst = make_inst(access_tier='settings')
    with pytest.raises(ValueError):
        inst.filter_create({'criteria': 'from:x', 'action': {}})


def test_filter_delete():
    inst = make_inst(access_tier='settings', results={'delete': {}})
    out = inst.filter_delete({'id': 'f1'})
    assert out == {'deleted': True, 'id': 'f1'}


# ---------------------------------------------------------------------------
# Watch
# ---------------------------------------------------------------------------


def test_watch_start_requires_topic():
    inst = make_inst()
    with pytest.raises(ValueError):
        inst.watch_start({})


def test_watch_start_sends_topic():
    inst = make_inst(results={'watch': {'historyId': '123', 'expiration': '9999'}})
    out = inst.watch_start({'topic_name': 'projects/p/topics/t'})
    assert out['historyId'] == '123'
    body = inst.IGlobal.service.call_for('watch')['body']
    assert body['topicName'] == 'projects/p/topics/t'


def test_watch_stop():
    inst = make_inst(results={'stop': {}})
    out = inst.watch_stop({})
    assert out == {'stopped': True}


# ---------------------------------------------------------------------------
# sendAs
# ---------------------------------------------------------------------------


def test_send_as_list_requires_settings():
    inst = make_inst(access_tier='modify')
    with pytest.raises(ga.GoogleAccessError):
        inst.send_as_list({})


def test_send_as_list_with_settings_tier():
    inst = make_inst(
        access_tier='settings', results={'list': {'sendAs': [{'sendAsEmail': 'a@b.com', 'isPrimary': True}]}}
    )
    out = inst.send_as_list({})
    assert out[0]['sendAsEmail'] == 'a@b.com'


def test_send_as_create_requires_settings_sharing():
    inst = make_inst(access_tier='settings')  # settings but not settings_sharing
    with pytest.raises(ga.GoogleAccessError):
        inst.send_as_create({'send_as_email': 'alias@x.com'})


def test_send_as_delete():
    inst = make_inst(access_tier='settings_sharing', results={'delete': {}})
    out = inst.send_as_delete({'send_as_email': 'alias@x.com'})
    assert out == {'deleted': True, 'sendAsEmail': 'alias@x.com'}


# ---------------------------------------------------------------------------
# IMAP / POP
# ---------------------------------------------------------------------------


def test_imap_get_requires_settings():
    inst = make_inst(access_tier='modify')
    with pytest.raises(ga.GoogleAccessError):
        inst.imap_get({})


def test_imap_get_with_settings_tier():
    inst = make_inst(access_tier='settings', results={'getImap': {'enabled': True, 'autoExpunge': False}})
    out = inst.imap_get({})
    assert out['enabled'] is True


def test_imap_update_passes_body():
    inst = make_inst(access_tier='settings', results={'updateImap': {'enabled': False}})
    inst.imap_update({'enabled': False, 'auto_expunge': True})
    body = inst.IGlobal.service.call_for('updateImap')['body']
    assert body['enabled'] is False
    assert body['autoExpunge'] is True


def test_imap_update_requires_at_least_one_field():
    inst = make_inst(access_tier='settings')
    with pytest.raises(ValueError):
        inst.imap_update({})


def test_pop_get_and_update():
    inst = make_inst(
        access_tier='settings',
        results={'getPop': {'accessWindow': 'allMail'}, 'updatePop': {'accessWindow': 'fromNowOn'}},
    )
    assert inst.pop_get({})['accessWindow'] == 'allMail'
    inst.pop_update({'access_window': 'fromNowOn'})
    body = inst.IGlobal.service.call_for('updatePop')['body']
    assert body['accessWindow'] == 'fromNowOn'


# ---------------------------------------------------------------------------
# Vacation
# ---------------------------------------------------------------------------


def test_vacation_get_requires_settings():
    inst = make_inst(access_tier='modify')
    with pytest.raises(ga.GoogleAccessError):
        inst.vacation_get({})


def test_vacation_get_returns_settings():
    inst = make_inst(
        access_tier='settings', results={'getVacation': {'enableAutoReply': False, 'responseSubject': 'OOO'}}
    )
    out = inst.vacation_get({})
    assert out['enableAutoReply'] is False


def test_vacation_update_sends_enable_flag():
    inst = make_inst(access_tier='settings', results={'updateVacation': {'enableAutoReply': True}})
    inst.vacation_update({'enable_auto_reply': True, 'response_subject': 'Away'})
    body = inst.IGlobal.service.call_for('updateVacation')['body']
    assert body['enableAutoReply'] is True
    assert body['responseSubject'] == 'Away'


def test_vacation_update_requires_fields():
    inst = make_inst(access_tier='settings')
    with pytest.raises(ValueError):
        inst.vacation_update({})


# ---------------------------------------------------------------------------
# Forwarding addresses
# ---------------------------------------------------------------------------


def test_forwarding_address_list():
    inst = make_inst(
        access_tier='settings',
        results={'list': {'forwardingAddresses': [{'forwardingEmail': 'f@x.com', 'verificationStatus': 'accepted'}]}},
    )
    out = inst.forwarding_address_list({})
    assert out[0]['forwardingEmail'] == 'f@x.com'


def test_forwarding_address_create_and_delete():
    inst = make_inst(
        access_tier='settings',
        results={
            'create': {'forwardingEmail': 'f@x.com', 'verificationStatus': 'pending'},
            'delete': {},
        },
    )
    out = inst.forwarding_address_create({'forwarding_email': 'f@x.com'})
    assert out['verificationStatus'] == 'pending'
    out2 = inst.forwarding_address_delete({'forwarding_email': 'f@x.com'})
    assert out2['deleted'] is True


# ---------------------------------------------------------------------------
# Delegation
# ---------------------------------------------------------------------------


def test_delegate_list_requires_settings_sharing():
    inst = make_inst(access_tier='settings')
    with pytest.raises(ga.GoogleAccessError):
        inst.delegate_list({})


def test_delegate_create_and_delete():
    inst = make_inst(
        access_tier='settings_sharing',
        results={
            'create': {'delegateEmail': 'd@x.com', 'verificationStatus': 'pending'},
            'delete': {},
        },
    )
    out = inst.delegate_create({'delegate_email': 'd@x.com'})
    assert out['delegateEmail'] == 'd@x.com'
    out2 = inst.delegate_delete({'delegate_email': 'd@x.com'})
    assert out2['deleted'] is True


# ---------------------------------------------------------------------------
# S/MIME
# ---------------------------------------------------------------------------


def test_smime_list_requires_settings():
    inst = make_inst(access_tier='modify')
    with pytest.raises(ga.GoogleAccessError):
        inst.smime_list({'send_as_email': 'a@b.com'})


def test_smime_set_default_requires_settings_sharing():
    inst = make_inst(access_tier='settings')
    with pytest.raises(ga.GoogleAccessError):
        inst.smime_set_default({'send_as_email': 'a@b.com', 'id': 'key1'})


def test_smime_delete():
    inst = make_inst(access_tier='settings_sharing', results={'delete': {}})
    out = inst.smime_delete({'send_as_email': 'a@b.com', 'id': 'key1'})
    assert out == {'deleted': True, 'id': 'key1', 'sendAsEmail': 'a@b.com'}
