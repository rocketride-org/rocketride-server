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
ga = importlib.import_module('nodes.core.google_access')

for _name in _added:
    sys.modules.pop(_name, None)


# ---------------------------------------------------------------------------
# Fake Gmail service: records terminal calls, returns canned results.
# ---------------------------------------------------------------------------

_RESOURCES = {'users', 'messages', 'threads', 'labels', 'drafts', 'history', 'attachments'}


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


def make_inst(access_tier='modify', allow_hard_delete=False, results=None):
    access = ga.resolve_google_access({'access': access_tier, 'allowHardDelete': allow_hard_delete}, ga.GMAIL)
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
# Hard delete gate (allowHardDelete flag + full tier)
# ---------------------------------------------------------------------------


def test_hard_delete_blocked_when_flag_off():
    inst = make_inst(access_tier='full', allow_hard_delete=False)
    with pytest.raises(ga.GoogleAccessError):
        inst.message_delete({'id': 'm1'})


def test_hard_delete_blocked_without_full_tier():
    # Flag on, but a non-full tier cannot grant the delete scope.
    inst = make_inst(access_tier='send', allow_hard_delete=True)
    with pytest.raises(ga.GoogleAccessError):
        inst.message_delete({'id': 'm1'})


def test_hard_delete_allowed_with_flag_and_full_tier():
    inst = make_inst(access_tier='full', allow_hard_delete=True, results={'delete': {}})
    assert inst.message_delete({'id': 'm1'}) == {'deleted': True, 'id': 'm1'}


def test_batch_delete_enforces_cap_and_gate():
    inst = make_inst(access_tier='full', allow_hard_delete=True, results={'batchDelete': {}})
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
