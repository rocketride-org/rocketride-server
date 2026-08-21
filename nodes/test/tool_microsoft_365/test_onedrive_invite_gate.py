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
Unit tests for ``onedrive_invite``'s directory-lookup sharing gate.

With ``allowPublicSharing`` off, every recipient must resolve to an
individual directory user (``GET /users/{email}``) before the invite is
sent; any lookup failure — not-a-user (404), missing permission (403), or
anything else — refuses the whole invite rather than guessing. With the
flag on, the lookup is skipped entirely. These are real ``IInstance``
method calls with only the HTTP layer (``graph_client._urlopen``) mocked,
mirroring ``test_graph_client.py``'s bootstrap.
"""

from __future__ import annotations

import io
import json
import sys
import types
import urllib.error
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest import mock

import pytest

_TEST_DIR = Path(__file__).resolve().parents[2]  # nodes/test -> nodes
_REPO_ROOT = _TEST_DIR.parent
_NODES_SRC = _TEST_DIR / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

_CORE_DIR = _NODES_SRC / 'nodes' / 'core'
if str(_CORE_DIR) not in sys.path:
    sys.path.insert(0, str(_CORE_DIR))

# Self-sufficient bootstrap (same technique as test_graph_client.py): stub the
# engine runtime modules the onedrive package imports (depends/rocketlib/
# ai.common.config), but load the *real* ai.common.utils.tool_args module
# directly by file path — it has no heavy deps (json/typing/rocketlib.warning
# only) — so normalize_tool_input/require_str/etc. behave exactly as in
# production instead of returning MagicMocks.
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
    for _n in ('normalize_tool_input', 'optional_str', 'require_str', 'require_str_list'):
        setattr(_utils_mod, _n, getattr(_tool_args, _n))
    sys.modules['ai.common.utils'] = _utils_mod
    _added.append('ai.common.utils')
    _added.append('ai.common.utils.tool_args')

_fresh_nodes = 'nodes' not in sys.modules
from nodes.tool_microsoft_365 import graph_client as gc  # noqa: E402
from nodes.tool_microsoft_365.onedrive import client as odc  # noqa: E402
from nodes.tool_microsoft_365.onedrive.IInstance import IInstance  # noqa: E402

for _name in _added:
    sys.modules.pop(_name, None)
if _fresh_nodes:
    for _name in [k for k in list(sys.modules) if k == 'nodes' or k.startswith('nodes.')]:
        sys.modules.pop(_name, None)

from microsoft_access import ONEDRIVE, resolve_microsoft_access  # noqa: E402


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


def _instance(*, allow_public_sharing: bool) -> IInstance:
    inst = IInstance()
    access = resolve_microsoft_access({'access': 'write', 'allowPublicSharing': allow_public_sharing}, ONEDRIVE)
    auth = mock.MagicMock()
    auth.token.return_value = 'TOK'
    inst.IGlobal = types.SimpleNamespace(access=access, auth=auth, cfg={'authType': 'user'})
    return inst


class TestInviteDirectoryLookupGate:
    def test_unresolvable_recipient_refuses_whole_invite(self):
        inst = _instance(allow_public_sharing=False)
        with mock.patch.object(gc, '_urlopen', side_effect=_http_error(404)) as u:
            with pytest.raises(gc.GraphError, match="'dist-list@contoso.com'.*allowPublicSharing"):
                inst.onedrive_invite({'item': 'Docs/a.pdf', 'emails': ['dist-list@contoso.com']})
            assert u.call_count == 1  # refused before the invite POST ever fires
            req = u.call_args[0][0]
            assert req.full_url.startswith('https://graph.microsoft.com/v1.0/users/dist-list%40contoso.com')
            assert req.get_method() == 'GET'

    def test_permission_error_names_directory_scope_hint(self):
        inst = _instance(allow_public_sharing=False)
        err = _http_error(403, {'code': 'ErrorAccessDenied', 'message': 'Access is denied.'})
        with mock.patch.object(gc, '_urlopen', side_effect=err):
            with pytest.raises(gc.GraphError, match='User.ReadBasic.All'):
                inst.onedrive_invite({'item': 'Docs/a.pdf', 'emails': ['someone@contoso.com']})

    def test_second_recipient_failure_still_refuses_whole_invite(self):
        inst = _instance(allow_public_sharing=False)
        with mock.patch.object(
            gc, '_urlopen', side_effect=[_resp({'id': '1', 'userType': 'Member'}), _http_error(404)]
        ) as u:
            with pytest.raises(gc.GraphError, match='second@contoso.com'):
                inst.onedrive_invite({'item': 'Docs/a.pdf', 'emails': ['first@contoso.com', 'second@contoso.com']})
            assert u.call_count == 2  # both lookups ran; the POST invite never fires

    def test_resolved_recipients_invite_sent_with_sendinvitation_true(self):
        inst = _instance(allow_public_sharing=False)
        responses = [
            _resp({'id': '1', 'userType': 'Member'}),  # directory lookup
            _resp({'value': [{'id': 'perm1', 'roles': ['read']}]}),  # invite POST
        ]
        with mock.patch.object(gc, '_urlopen', side_effect=responses) as u:
            out = inst.onedrive_invite({'item': 'Docs/a.pdf', 'emails': ['alex@contoso.com']})
            assert out == {'permissions': [{'id': 'perm1', 'roles': ['read']}]}
            assert u.call_count == 2
            invite_req = u.call_args_list[1][0][0]
            assert invite_req.full_url.endswith('/invite')
            body = json.loads(invite_req.data)
            assert body['sendInvitation'] is True  # always true, independent of message
            assert body['recipients'] == [{'email': 'alex@contoso.com'}]

    def test_allow_public_sharing_skips_lookup_entirely(self):
        inst = _instance(allow_public_sharing=True)
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'value': []})) as u:
            inst.onedrive_invite({'item': 'Docs/a.pdf', 'emails': ['dist-list@contoso.com']})
            assert u.call_count == 1  # no directory lookup, straight to the invite POST
            req = u.call_args[0][0]
            assert req.full_url.endswith('/invite')

    def test_directory_lookup_selects_only_id(self):
        # ``userType`` is outside the User.ReadBasic.All property set; selecting it
        # would 403 the lookup under the delegated scope the README documents.
        inst = _instance(allow_public_sharing=False)
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'id': '1'})) as u:
            inst._require_individual_directory_user('alex@contoso.com')
        url = u.call_args[0][0].full_url
        assert '/users/alex%40contoso.com' in url
        assert '%24select=id' in url and 'userType' not in url

    def test_no_org_wide_alias_helper_left_behind(self):
        assert not hasattr(odc, 'is_org_wide_alias')
        assert not hasattr(odc, 'ORG_WIDE_ALIAS_LOCALPARTS')


class TestRestorePersonalOnly:
    def test_service_auth_refused_without_graph_call(self):
        inst = _instance(allow_public_sharing=False)
        inst.IGlobal.cfg = {'authType': 'service', 'userPrincipalName': 'alex@contoso.com'}
        with mock.patch.object(gc, '_urlopen') as u:
            with pytest.raises(gc.GraphError, match='OneDrive Personal'):
                inst.onedrive_restore({'item': '01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K'})
        u.assert_not_called()

    def test_user_auth_issues_restore(self):
        inst = _instance(allow_public_sharing=False)
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'id': 'X', 'name': 'a.pdf'})) as u:
            out = inst.onedrive_restore({'item': '01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K'})
        assert out == {'id': 'X', 'name': 'a.pdf'}
        assert u.call_args[0][0].full_url.endswith('/me/drive/items/01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K/restore')


class TestChunkedUploadSession:
    _URL = 'https://sn3302.up.1drv.com/up/fe6987415ace7X4e1eF866337'

    def _put(self, side_effect):
        auth = mock.MagicMock()
        auth.token.return_value = 'TOK'
        with (
            mock.patch.object(gc, '_urlopen', side_effect=side_effect) as u,
            mock.patch.object(gc._time, 'sleep') as sl,
        ):
            out = odc.upload_chunk(auth, self._URL, b'abc', 0, 2, 3)
        return out, u, sl

    def test_chunk_put_omits_bearer_and_sets_content_range(self):
        # The session uploadUrl is pre-authenticated and on a non-Graph host: no Authorization.
        out, u, _ = self._put([_resp({'id': 'X'})])
        req = u.call_args[0][0]
        assert req.full_url == self._URL and req.get_method() == 'PUT'
        assert not req.has_header('Authorization')
        assert req.get_header('Content-range') == 'bytes 0-2/3'
        assert out == {'id': 'X'}

    def test_transient_failures_are_retried_with_backoff(self):
        out, u, sl = self._put([_http_error(503), urllib.error.URLError('reset'), _http_error(429), _resp({'id': 'X'})])
        assert out == {'id': 'X'}
        assert u.call_count == 4
        assert [c.args[0] for c in sl.call_args_list] == [1.0, 2, 4.0]

    def test_non_transient_failure_raises_immediately(self):
        with pytest.raises(gc.GraphError, match='HTTP 416'):
            self._put([_http_error(416)])

    def test_retry_budget_is_bounded(self):
        with pytest.raises(gc.GraphError, match='HTTP 503'):
            self._put([_http_error(503)] * 4)

    def test_bare_socket_errors_are_retried_like_urlerror(self):
        # TimeoutError/ConnectionResetError are OSError but not URLError; they can be
        # raised by urlopen or by resp.read() and must stay inside the retry budget.
        slow = _resp({'id': 'X'})
        slow.read.side_effect = TimeoutError('timed out')
        out, u, sl = self._put([slow, ConnectionResetError('reset'), _resp({'id': 'X'})])
        assert out == {'id': 'X'}
        assert u.call_count == 3
        assert [c.args[0] for c in sl.call_args_list] == [1, 2]

    def test_socket_errors_exhaust_budget_as_graph_error(self):
        with pytest.raises(gc.GraphError, match='connection error: timed out'):
            self._put([TimeoutError('timed out')] * 4)


class TestListItemsRootAddressing:
    @pytest.mark.parametrize('folder', ['', '/', 'root'])
    def test_empty_or_slash_folder_lists_drive_root(self, folder):
        inst = _instance(allow_public_sharing=False)
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'value': []})) as u:
            assert inst.onedrive_list_items({'folder': folder}) == {'items': []}
        assert u.call_args[0][0].full_url == 'https://graph.microsoft.com/v1.0/me/drive/items/root/children'

    def test_omitted_folder_lists_drive_root(self):
        inst = _instance(allow_public_sharing=False)
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'value': []})) as u:
            inst.onedrive_list_items({})
        assert u.call_args[0][0].full_url.endswith('/me/drive/items/root/children')

    def test_path_folder_keeps_path_addressing(self):
        inst = _instance(allow_public_sharing=False)
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'value': []})) as u:
            inst.onedrive_list_items({'folder': '/Reports/'})
        assert u.call_args[0][0].full_url.endswith('/me/drive/root:/Reports:/children')
