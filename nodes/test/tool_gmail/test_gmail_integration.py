# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Live integration tests for tool_gmail.

Calls real Gmail API endpoints using a user OAuth token obtained via the
oauth2.rocketride.ai broker. Read-only calls exercise the readonly tier;
write calls use the modify/send tier and clean up after themselves.

Obtain a token via the broker:
    1. Open in browser (baseURL must be on the broker's redirect allowlist):
       https://oauth2.rocketride.ai/google?service=%7B%7D&type=user&baseURL=https://oauth2.rocketride.ai/callback
    2. Complete Google login.
    3. Copy the 'tokens' query-param JSON from the callback response and set it below.

Set up:
    export GMAIL_USER_TOKEN='{"access_token":"ya29.x","refresh_token":"1//x","scope":"...","token_type":"Bearer","expiry_date":...,"oauth_server_url":"https://oauth.rocketride.ai/refresh"}'
    export GMAIL_TEST_ADDRESS=your-test-gmail@gmail.com

Run:
    cd nodes
    python -m pytest test/tool_gmail/test_gmail_integration.py -v

Or via builder:
    ./builder nodes:test --pytest-pattern="test_gmail_integration"
"""

from __future__ import annotations

import importlib
import os
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

# ---------------------------------------------------------------------------
# Env-var gate — tests skip unless both vars are set
# ---------------------------------------------------------------------------

TOKEN_JSON = os.getenv('GMAIL_USER_TOKEN', '')
TEST_ADDRESS = os.getenv('GMAIL_TEST_ADDRESS', '')

pytestmark = pytest.mark.skipif(
    not TOKEN_JSON or not TEST_ADDRESS,
    reason='GMAIL_USER_TOKEN and GMAIL_TEST_ADDRESS must both be set',
)

# ---------------------------------------------------------------------------
# Engine stubs (same pattern as test_gmail.py unit tests)
# ---------------------------------------------------------------------------


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
# Helper — build a live IInstance connected to real Gmail
# ---------------------------------------------------------------------------


def make_live_inst(access_tier: str = 'modify'):
    """Return an IInstance backed by a real Gmail API service."""
    access = ga.resolve_google_access({'access': access_tier}, ga.GMAIL)
    svc = gmail_client.build_service('user', {'userToken': TOKEN_JSON}, access.scopes)
    inst = IInstance.IInstance()
    inst.IGlobal = types.SimpleNamespace(service=svc, access=access)
    return inst


# ---------------------------------------------------------------------------
# Read-only tests (no side effects — safe to run repeatedly)
# ---------------------------------------------------------------------------


class TestLabelRead:
    def test_label_list_returns_system_labels(self):
        inst = make_live_inst('readonly')
        result = inst.label_list({})
        labels = result.get('labels', [])
        assert isinstance(labels, list)
        ids = [lbl.get('id') for lbl in labels]
        assert 'INBOX' in ids

    def test_label_get_inbox(self):
        inst = make_live_inst('readonly')
        result = inst.label_get({'id': 'INBOX'})
        assert result.get('id') == 'INBOX'
        assert 'name' in result


class TestMessageRead:
    def test_message_list_inbox(self):
        inst = make_live_inst('readonly')
        result = inst.message_list({'query': 'is:inbox', 'maxResults': 5})
        # May return empty inbox — just confirm the shape is correct
        assert 'resultSizeEstimate' in result or 'messages' in result

    def test_message_list_with_label(self):
        inst = make_live_inst('readonly')
        result = inst.message_list({'labelIds': 'INBOX', 'maxResults': 3})
        assert isinstance(result, dict)


class TestThreadRead:
    def test_thread_list(self):
        inst = make_live_inst('readonly')
        result = inst.thread_list({'maxResults': 3})
        assert isinstance(result, dict)


class TestDraftRead:
    def test_draft_list(self):
        inst = make_live_inst('modify')
        result = inst.draft_list({'maxResults': 5})
        assert isinstance(result, dict)


# ---------------------------------------------------------------------------
# Write tests — draft lifecycle (create → get → delete, no email sent)
# ---------------------------------------------------------------------------


class TestDraftLifecycle:
    def test_create_get_delete(self):
        inst = make_live_inst('send')

        created = inst.draft_create(
            {
                'to': TEST_ADDRESS,
                'subject': '[rocketride-test] Draft lifecycle',
                'body': 'Automated integration test — safe to delete.',
            }
        )
        draft_id = created.get('id')
        assert draft_id, f'expected draft id, got: {created}'

        fetched = inst.draft_get({'id': draft_id})
        assert fetched.get('id') == draft_id

        deleted = inst.draft_delete({'id': draft_id})
        assert deleted.get('deleted') is True


# ---------------------------------------------------------------------------
# Send test — sends a real email to TEST_ADDRESS (should be your own account)
# ---------------------------------------------------------------------------


class TestMessageSend:
    def test_send_to_self(self):
        inst = make_live_inst('send')
        result = inst.message_send(
            {
                'to': TEST_ADDRESS,
                'subject': '[rocketride-test] Integration send',
                'body': 'Automated test from tool_gmail integration suite. Safe to delete.',
            }
        )
        msg_id = result.get('id')
        assert msg_id, f'expected message id, got: {result}'

    def test_send_thread_reply(self):
        """Create a draft, extract the message-id header, reply in-thread, then clean up."""
        inst = make_live_inst('send')

        # Create a draft to get a real Message-ID header to reply to
        draft = inst.draft_create(
            {
                'to': TEST_ADDRESS,
                'subject': '[rocketride-test] Thread reply test',
                'body': 'Original message.',
            }
        )
        draft_id = draft.get('id')
        assert draft_id

        # Retrieve to find the Message-ID header
        full_draft = inst.draft_get({'id': draft_id})
        msg_headers = (full_draft.get('message') or {}).get('headers') or {}
        message_id_header = msg_headers.get('Message-ID') or msg_headers.get('message-id')

        # Clean up the draft regardless of whether we can thread
        inst.draft_delete({'id': draft_id})

        if not message_id_header:
            pytest.skip('draft had no Message-ID header — skipping thread-reply assertion')

        reply = inst.message_send(
            {
                'to': TEST_ADDRESS,
                'subject': 'Re: [rocketride-test] Thread reply test',
                'body': 'Reply from integration test.',
                'inReplyTo': message_id_header,
                'references': message_id_header,
            }
        )
        assert reply.get('id')


# ---------------------------------------------------------------------------
# Hard-delete gate test — verifies the gate blocks without the full tier
# ---------------------------------------------------------------------------


class TestHardDeleteGate:
    def test_hard_delete_blocked_at_modify_tier(self):
        """message_delete should raise without the full tier."""
        inst = make_live_inst('modify')
        with pytest.raises((ValueError, PermissionError)):
            inst.message_delete({'id': 'fake-id-that-doesnt-exist'})


# ---------------------------------------------------------------------------
# Thread ops
# ---------------------------------------------------------------------------


class TestThreadOps:
    def test_thread_list_and_modify(self):
        inst = make_live_inst('modify')
        threads = inst.thread_list({'maxResults': 3})
        thread_list = threads.get('threads') or []
        if not thread_list:
            pytest.skip('no threads in mailbox — skipping thread_modify test')

        tid = thread_list[0]['id']
        # Apply STARRED, then remove it — net-zero change.
        inst.thread_modify({'id': tid, 'addLabelIds': ['STARRED']})
        inst.thread_modify({'id': tid, 'removeLabelIds': ['STARRED']})

    def test_thread_trash_and_untrash(self):
        inst = make_live_inst('modify')
        threads = inst.thread_list({'maxResults': 3})
        thread_list = threads.get('threads') or []
        if not thread_list:
            pytest.skip('no threads — skipping thread_trash test')

        tid = thread_list[0]['id']
        trashed = inst.thread_trash({'id': tid})
        assert trashed.get('id') == tid
        restored = inst.thread_untrash({'id': tid})
        assert restored.get('id') == tid


# ---------------------------------------------------------------------------
# Message convenience wrappers
# ---------------------------------------------------------------------------


class TestConvenienceWrappers:
    def _any_message_id(self, inst) -> str | None:
        result = inst.message_list({'labelIds': 'INBOX', 'maxResults': 1})
        msgs = result.get('messages') or []
        return msgs[0]['id'] if msgs else None

    def test_star_and_unstar(self):
        inst = make_live_inst('modify')
        mid = self._any_message_id(inst)
        if not mid:
            pytest.skip('no INBOX messages — skipping star test')
        inst.message_star({'id': mid})
        inst.message_unstar({'id': mid})

    def test_mark_unread_and_read(self):
        inst = make_live_inst('modify')
        mid = self._any_message_id(inst)
        if not mid:
            pytest.skip('no INBOX messages — skipping mark_read test')
        inst.message_mark_unread({'id': mid})
        inst.message_mark_read({'id': mid})

    def test_message_get_body(self):
        inst = make_live_inst('readonly')
        result = inst.message_list({'maxResults': 5})
        msgs = result.get('messages') or []
        if not msgs:
            pytest.skip('no messages — skipping body extraction test')
        out = inst.message_get_body({'id': msgs[0]['id']})
        assert 'id' in out
        # At least one of text or html should be present for most real messages
        assert out.get('text') is not None or out.get('html') is not None


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------


class TestFilters:
    def test_filter_list(self):
        inst = make_live_inst('settings')
        result = inst.filter_list({})
        assert isinstance(result, list)

    def test_filter_create_and_delete(self):
        inst = make_live_inst('settings')
        created = inst.filter_create(
            {
                'criteria': {'from': 'noreply-rocketride-test@example.invalid'},
                'action': {'addLabelIds': ['STARRED']},
            }
        )
        fid = created.get('id')
        assert fid, f'expected filter id, got: {created}'
        deleted = inst.filter_delete({'id': fid})
        assert deleted.get('deleted') is True


# ---------------------------------------------------------------------------
# Vacation responder (read + idempotent disable)
# ---------------------------------------------------------------------------


class TestVacation:
    def test_vacation_get(self):
        inst = make_live_inst('settings')
        result = inst.vacation_get({})
        assert 'enableAutoReply' in result

    def test_vacation_update_disable(self):
        """Disable the vacation responder — safe to run on any account."""
        inst = make_live_inst('settings')
        result = inst.vacation_update({'enable_auto_reply': False})
        assert 'enableAutoReply' in result


# ---------------------------------------------------------------------------
# HTML send with attachment
# ---------------------------------------------------------------------------


class TestHtmlSend:
    def test_send_html_to_self(self):
        import base64

        inst = make_live_inst('send')
        content_b64 = base64.b64encode(b'Integration test attachment content').decode()
        result = inst.message_send(
            {
                'to': TEST_ADDRESS,
                'subject': '[rocketride-test] HTML send with attachment',
                'html_body': '<h1>Integration test</h1><p>This is an automated HTML email from the tool_gmail integration suite. Safe to delete.</p>',
                'attachments': [{'filename': 'test.txt', 'content_base64': content_b64, 'mime_type': 'text/plain'}],
            }
        )
        assert result.get('id'), f'expected message id, got: {result}'
