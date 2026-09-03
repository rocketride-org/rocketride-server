# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Focused tier/gate tests for the Outlook Mail service.

Covers the three-tier (readonly/send/modify) guard design that
``require_write`` alone cannot express: the ``send`` tier is nominally
writable (``can_write`` is False only for ``readonly``) but lacks the
Mail.ReadWrite scope, so modify-class tools are additionally guarded by the
module-level ``_require_modify`` helper, and send-class tools by
``_require_send``. Real ``IInstance`` method calls with only the HTTP layer
(``graph_client._urlopen``) mocked, mirroring
``test_onedrive_invite_gate.py``'s bootstrap.
"""

from __future__ import annotations

import base64
import io
import json
import sys
import types
import urllib.error
import urllib.parse
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest import mock

import pytest

_TEST_DIR = Path(__file__).resolve().parents[2]  # nodes/test -> nodes
_REPO_ROOT = _TEST_DIR.parent
_NODES_SRC = _TEST_DIR / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

# Self-sufficient bootstrap (same technique as test_graph_client.py /
# test_onedrive_invite_gate.py): stub the engine runtime modules the
# outlook_mail package imports (depends/rocketlib/ai.common.config), but
# load the *real* ai.common.utils.tool_args module directly by file path —
# it has no heavy deps (json/typing/rocketlib.warning only) — so
# normalize_tool_input/require_str/etc. behave exactly as in production
# instead of returning MagicMocks.
_added = []
for _name in ('depends', 'rocketlib', 'ai', 'ai.common', 'ai.common.config'):
    if _name not in sys.modules:
        _stub = types.ModuleType(_name)
        if _name == 'depends':
            _stub.depends = lambda *a, **k: None
        if _name == 'rocketlib':
            _stub.IInstanceBase = object
            _stub.IGlobalBase = object
            _stub.OPEN_MODE = types.SimpleNamespace(CONFIG='CONFIG')
            _stub.warning = lambda *a, **k: None
            _stub.tool_function = lambda **kw: lambda f: f
        if _name == 'ai.common.config':
            _stub.Config = object
        sys.modules[_name] = _stub
        _added.append(_name)

if 'ai.common.utils' not in sys.modules:
    _tool_args_path = _REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils' / 'tool_args.py'
    _spec = spec_from_file_location('ai.common.utils.tool_args', _tool_args_path)
    _tool_args = module_from_spec(_spec)
    sys.modules['ai.common.utils.tool_args'] = _tool_args
    _spec.loader.exec_module(_tool_args)
    _utils_mod = types.ModuleType('ai.common.utils')
    for _n in (
        'normalize_tool_input',
        'optional_str',
        'optional_str_list',
        'optional_bool',
        'require_str',
        'require_str_list',
        'int_arg',
    ):
        setattr(_utils_mod, _n, getattr(_tool_args, _n))
    sys.modules['ai.common.utils'] = _utils_mod
    _added.append('ai.common.utils')
    _added.append('ai.common.utils.tool_args')

_fresh_nodes = 'nodes' not in sys.modules
from nodes.tool_microsoft_365 import graph_client as gc  # noqa: E402
from nodes.tool_microsoft_365.outlook_mail import client as omc  # noqa: E402
from nodes.tool_microsoft_365.outlook_mail.IInstance import IInstance, _require_modify, _require_send  # noqa: E402

# Capture these from the *same* dotted-loaded nodes.core.microsoft_access module
# that IInstance.py itself imported from (identical import path -> identical
# MicrosoftAccessError class object), rather than re-importing the file under a
# bare module name afterward — a second load would mint a distinct class object
# that pytest.raises(MicrosoftAccessError) below could never match against
# exceptions raised inside IInstance.py's _require_send/_require_modify.
from nodes.core.microsoft_access import MicrosoftAccessError, OUTLOOK_MAIL, resolve_microsoft_access  # noqa: E402

for _name in _added:
    sys.modules.pop(_name, None)
if _fresh_nodes:
    for _name in [k for k in list(sys.modules) if k == 'nodes' or k.startswith('nodes.')]:
        sys.modules.pop(_name, None)


def _resp(body: dict, status: int = 200):
    m = mock.MagicMock()
    m.read.return_value = json.dumps(body).encode()
    m.status = status
    m.headers = {}
    m.__enter__ = lambda s: s
    m.__exit__ = lambda s, *a: False
    return m


def _http_error(status: int, body: dict | None = None):
    payload = io.BytesIO(json.dumps({'error': body or {}}).encode())
    return urllib.error.HTTPError('u', status, 'err', {}, payload)


def _instance(*, tier: str, allow_hard_delete: bool = False) -> IInstance:
    inst = IInstance()
    cfg = {'access': tier, 'allowHardDelete': allow_hard_delete}
    access = resolve_microsoft_access(cfg, OUTLOOK_MAIL)
    auth = mock.MagicMock()
    auth.token.return_value = 'TOK'
    inst.IGlobal = types.SimpleNamespace(access=access, auth=auth, cfg={'authType': 'user'})
    return inst


class TestModuleLevelGuards:
    def test_require_send_passes_for_send_tier(self):
        access = resolve_microsoft_access({'access': 'send'}, OUTLOOK_MAIL)
        _require_send(access)  # must not raise

    def test_require_send_passes_for_modify_tier(self):
        access = resolve_microsoft_access({'access': 'modify'}, OUTLOOK_MAIL)
        _require_send(access)  # must not raise

    def test_require_send_blocks_readonly_tier(self):
        access = resolve_microsoft_access({'access': 'readonly'}, OUTLOOK_MAIL)
        with pytest.raises(MicrosoftAccessError, match='send scope'):
            _require_send(access)

    def test_require_modify_blocks_send_tier(self):
        # (b) send tier lacks Mail.ReadWrite: _require_modify blocks it even
        # though it passes _require_send.
        access = resolve_microsoft_access({'access': 'send'}, OUTLOOK_MAIL)
        with pytest.raises(MicrosoftAccessError, match='modify scope'):
            _require_modify(access)
        _require_send(access)  # ... but the send-class guard passes

    def test_require_modify_passes_for_modify_tier(self):
        access = resolve_microsoft_access({'access': 'modify'}, OUTLOOK_MAIL)
        _require_modify(access)  # must not raise


class TestToolLevelGuards:
    def test_readonly_tier_blocks_modify_tool(self):
        # (a) readonly tier blocks a modify-class tool via require_write.
        inst = _instance(tier='readonly')
        with pytest.raises(MicrosoftAccessError, match='read-only'):
            inst.outlook_mail_move_message({'message_id': 'm1', 'folder': 'archive'})

    def test_send_tier_blocks_create_draft(self):
        # (b) send tier blocks create_draft (Mail.ReadWrite missing).
        inst = _instance(tier='send')
        with pytest.raises(MicrosoftAccessError, match='modify scope'):
            inst.outlook_mail_create_draft({'to': ['a@contoso.com'], 'subject': 'Hi', 'body': 'text'})

    def test_permanently_delete_refused_without_allow_hard_delete(self):
        # (c) modify tier, flag off: refused even though the tier is fully modify.
        inst = _instance(tier='modify', allow_hard_delete=False)
        with pytest.raises(MicrosoftAccessError, match='allowHardDelete'):
            inst.outlook_mail_permanently_delete({'message_id': 'm1'})

    def test_permanently_delete_allowed_with_flag_on(self):
        inst = _instance(tier='modify', allow_hard_delete=True)
        with mock.patch.object(gc, '_urlopen', return_value=_resp({})) as u:
            out = inst.outlook_mail_permanently_delete({'message_id': 'm1'})
            assert out == {'permanentlyDeleted': 'm1'}
            req = u.call_args[0][0]
            assert req.get_method() == 'DELETE'
            assert req.full_url.endswith('/messages/m1')

    def test_delete_message_moves_to_deleted_items(self):
        # (d) soft delete issues a POST .../move with destinationId=deleteditems.
        inst = _instance(tier='modify')
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'id': 'm1'})) as u:
            out = inst.outlook_mail_delete_message({'message_id': 'm1'})
            assert out == {'deleted': 'm1', 'permanently': False}
            req = u.call_args[0][0]
            assert req.get_method() == 'POST'
            assert req.full_url.endswith('/messages/m1/move')
            body = json.loads(req.data)
            assert body == {'destinationId': 'deleteditems'}

    def test_send_message_posts_sendmail_body_shape(self):
        # (e) send_message POSTs /sendMail with the {message, saveToSentItems} shape.
        inst = _instance(tier='send')
        with mock.patch.object(gc, '_urlopen', return_value=_resp({})) as u:
            out = inst.outlook_mail_send_message(
                {'to': ['a@contoso.com'], 'cc': ['b@contoso.com'], 'subject': 'Hi', 'body': 'text body'}
            )
            assert out == {'sent': True, 'to': ['a@contoso.com'], 'subject': 'Hi'}
            req = u.call_args[0][0]
            assert req.get_method() == 'POST'
            assert req.full_url.endswith('/sendMail')
            body = json.loads(req.data)
            assert body['saveToSentItems'] is True
            message = body['message']
            assert message['subject'] == 'Hi'
            assert message['body'] == {'contentType': 'Text', 'content': 'text body'}
            assert message['toRecipients'] == [{'emailAddress': {'address': 'a@contoso.com'}}]
            assert message['ccRecipients'] == [{'emailAddress': {'address': 'b@contoso.com'}}]
            assert 'bccRecipients' not in message

    def test_send_message_blocked_for_readonly_tier(self):
        inst = _instance(tier='readonly')
        with pytest.raises(MicrosoftAccessError, match='send scope'):
            inst.outlook_mail_send_message({'to': ['a@contoso.com'], 'subject': 'Hi', 'body': 'text'})

    def test_no_stray_client_helpers_left_behind(self):
        assert not hasattr(omc, 'is_org_wide_alias')


class TestHtmlToTextStripsStyleAndScript:
    """Real Outlook HTML embeds a big <style> block (mso-* CSS) in <head>, and
    sometimes <script>; tag-stripping alone leaves their *contents* behind, so
    html_to_text must drop the whole element before stripping tags.
    """

    _HTML = """
        <html>
        <head>
        <style>
        body { font-family: Calibri; }
        p.MsoNormal, li.MsoNormal { margin: 0in; mso-style-priority: 99; }
        @media screen { .foo { color: red; } }
        </style>
        <script type="text/javascript">
        var trackingId = "abc123"; document.write(trackingId);
        </script>
        </head>
        <body>
        <p class="MsoNormal">Hi Alex,</p>
        <p class="MsoNormal">See the attached report.</p>
        <p class="MsoNormal">Thanks,<br>Dylan</p>
        </body>
        </html>
    """

    def test_style_and_script_contents_do_not_leak(self):
        text = omc.html_to_text(self._HTML)
        assert 'mso-style-priority' not in text
        assert 'font-family' not in text
        assert '.foo { color: red; }' not in text
        assert 'trackingId' not in text
        assert 'document.write' not in text

    def test_real_body_text_survives(self):
        text = omc.html_to_text(self._HTML)
        assert 'Hi Alex,' in text
        assert 'See the attached report.' in text
        assert 'Thanks,' in text
        assert 'Dylan' in text

    def test_case_insensitive_and_attributed_tags(self):
        html = '<P>keep</P><STYLE type="text/css">.x{color:red}</STYLE><SCRIPT>evil()</SCRIPT><p>me</p>'
        text = omc.html_to_text(html)
        assert 'color:red' not in text
        assert 'evil()' not in text
        assert 'keep' in text
        assert 'me' in text

    def test_conditional_comment_contents_do_not_leak(self):
        html = (
            '<!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]--><p>visible</p><!-- plain\ncomment -->'
        )
        text = omc.html_to_text(html)
        assert 'OfficeDocumentSettings' not in text
        assert 'endif' not in text
        assert 'comment' not in text
        assert text == 'visible'


class TestListMessagesSearchEscaping:
    def test_double_quotes_in_query_are_backslash_escaped(self):
        inst = _instance(tier='readonly')
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'value': []})) as u:
            inst.outlook_mail_list_messages({'query': 'say "hi" now'})
            url = urllib.parse.unquote_plus(u.call_args[0][0].full_url)
            assert '$search="say \\"hi\\" now"' in url


class TestAddAttachmentSizeGuard:
    def test_attachment_at_or_above_3mb_is_rejected_before_request(self):
        inst = _instance(tier='modify')
        big = base64.b64encode(b'x' * omc.MAX_INLINE_ATTACHMENT_BYTES).decode()
        with mock.patch.object(gc, '_urlopen') as u:
            with pytest.raises(ValueError, match='3 MB'):
                inst.outlook_mail_add_attachment({'message_id': 'm1', 'name': 'big.bin', 'content_base64': big})
            u.assert_not_called()

    def test_small_attachment_is_posted(self):
        inst = _instance(tier='modify')
        small = base64.b64encode(b'hello').decode()
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'id': 'a1', 'name': 'hi.txt'})) as u:
            inst.outlook_mail_add_attachment({'message_id': 'm1', 'name': 'hi.txt', 'content_base64': small})
            assert json.loads(u.call_args[0][0].data)['contentBytes'] == small
