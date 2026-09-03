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

"""Regression tests: drive-path segments must be percent-encoded before they
land in a Graph URL.

A raw space in an unencoded ``root:/{path}:`` URL raises
``http.client.InvalidURL``; a raw ``#`` silently truncates the path and
addresses the wrong item. Each service's PATH-branch helper (``wb()`` /
``it()``) must ``urllib.parse.quote(value, safe='/')`` the path before
interpolating it, while leaving item-id addressing untouched.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest import mock

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

# Self-sufficient bootstrap: importing the nodes package pulls engine runtime
# modules (depends/rocketlib); stub them if absent so this file never depends
# on a sibling test having run first, then drop what we added.
from unittest.mock import MagicMock

_added = []
for _name in ('depends', 'rocketlib', 'ai', 'ai.common', 'ai.common.utils', 'ai.common.config'):
    if _name not in sys.modules:
        _stub = MagicMock()
        if _name == 'depends':
            _stub.depends = lambda *a, **k: None
        if _name == 'rocketlib':
            _stub.IInstanceBase = object
            _stub.IGlobalBase = object
            _stub.tool_function = lambda **kw: lambda f: f
        sys.modules[_name] = _stub
        _added.append(_name)

_fresh_nodes = 'nodes' not in sys.modules
from nodes.tool_microsoft_365 import graph_client as gc
from nodes.tool_microsoft_365.excel import client as excel_client
from nodes.tool_microsoft_365.onedrive import client as onedrive_client
from nodes.tool_microsoft_365.word import client as word_client

for _name in _added:
    sys.modules.pop(_name, None)
if _fresh_nodes:
    for _name in [k for k in list(sys.modules) if k == 'nodes' or k.startswith('nodes.')]:
        sys.modules.pop(_name, None)


def _resp(body: dict | None = None):
    m = mock.MagicMock()
    m.read.return_value = json.dumps(body or {}).encode()
    m.status = 200
    m.headers = {}
    m.__enter__ = lambda s: s
    m.__exit__ = lambda s, *a: False
    return m


def _auth():
    a = mock.MagicMock()
    a.token.return_value = 'TOK'
    return a


class TestExcelWorkbookPathEncoding:
    def test_space_in_path_is_percent_encoded(self):
        url = excel_client.wb('/me', 'Reports/Q3 Budget.xlsx')
        assert 'Reports/Q3%20Budget.xlsx' in url
        assert ' ' not in url

    def test_hash_in_path_is_percent_encoded_not_truncated(self):
        url = excel_client.wb('/me', 'Notes #1.xlsx')
        assert 'Notes%20%231.xlsx' in url
        assert '#' not in url

    def test_item_id_branch_is_unaffected(self):
        item_id = 'EC61DF107D0F1F05!s1a2b3c4d5e'
        assert excel_client.wb('/me', item_id) == '/me/drive/items/EC61DF107D0F1F05%21s1a2b3c4d5e/workbook'

    def test_bare_workbook_names_are_paths(self):
        # names with spaces/dots (incl. bare 'smoke.xlsx') take the path branch
        assert excel_client.wb('/me', 'Q3 Budget.xlsx') == '/me/drive/root:/Q3%20Budget.xlsx:/workbook'
        assert excel_client.wb('/me', 'smoke.xlsx') == '/me/drive/root:/smoke.xlsx:/workbook'

    def test_request_url_contains_encoded_space(self):
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'value': []})) as u:
            excel_client.request(_auth(), 'GET', excel_client.wb('/me', 'Reports/Q3 Budget.xlsx') + '/worksheets')
            req = u.call_args[0][0]
            assert 'Reports/Q3%20Budget.xlsx' in req.full_url
            assert ' ' not in req.full_url


class TestOneDrivePathEncoding:
    def test_space_in_path_is_percent_encoded(self):
        url = onedrive_client.it('/me', 'Reports/Q3 Budget.xlsx')
        assert 'Reports/Q3%20Budget.xlsx' in url
        assert ' ' not in url

    def test_hash_in_path_is_percent_encoded_not_truncated(self):
        url = onedrive_client.it('/me', 'Notes #1.docx')
        assert 'Notes%20%231.docx' in url
        assert '#' not in url

    def test_item_id_branch_still_uses_seg(self):
        # realistic personal-drive id shape (alnum + '!', 15+ chars)
        item_id = 'EC61DF107D0F1F05!s1a2b3c4d5e'
        # _seg percent-encodes '!' -> %21; Graph accepts the encoded form
        assert onedrive_client.it('/me', item_id) == '/me/drive/items/EC61DF107D0F1F05%21s1a2b3c4d5e'

    def test_bare_names_are_paths_not_ids(self):
        # Live-Graph finding: a bare folder name with a space was misrouted as
        # an item id (HTTP 400). Names with spaces/dots must take the path branch.
        assert onedrive_client.it('/me', 'RocketRide Smoke') == '/me/drive/root:/RocketRide%20Smoke:'
        assert onedrive_client.it('/me', 'smoke.xlsx') == '/me/drive/root:/smoke.xlsx:'
        assert onedrive_client.it('/me', 'root') == '/me/drive/items/root'

    def test_parent_ref_encodes_paths_and_keeps_ids(self):
        assert onedrive_client.parent_ref('Reports/Q3 Budget') == {'path': '/drive/root:/Reports/Q3%20Budget'}
        assert onedrive_client.parent_ref('EC61DF107D0F1F05!s1a2b3c4d5e') == {'id': 'EC61DF107D0F1F05!s1a2b3c4d5e'}

    def test_request_url_contains_encoded_hash(self):
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'id': '1'})) as u:
            onedrive_client.request(_auth(), 'GET', onedrive_client.it('/me', 'Notes #1.docx'))
            req = u.call_args[0][0]
            assert '%23' in req.full_url
            assert '#' not in req.full_url


class TestWordPathEncoding:
    def test_space_in_path_is_percent_encoded(self):
        url = word_client.it('/me', 'Docs/Meeting Notes.docx')
        assert 'Docs/Meeting%20Notes.docx' in url
        assert ' ' not in url

    def test_hash_in_path_is_percent_encoded_not_truncated(self):
        url = word_client.it('/me', 'Notes #1.docx')
        assert '%23' in url

    def test_item_id_branch_still_uses_seg(self):
        item_id = 'EC61DF107D0F1F05!s1a2b3c4d5e'
        assert word_client.it('/me', item_id) == '/me/drive/items/EC61DF107D0F1F05%21s1a2b3c4d5e'

    def test_bare_names_are_paths_not_ids(self):
        assert word_client.it('/me', 'Meeting Notes.docx') == '/me/drive/root:/Meeting%20Notes.docx:'

    def test_request_url_contains_encoded_space(self):
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'id': '1'})) as u:
            word_client.request(_auth(), 'GET', word_client.it('/me', 'Docs/Meeting Notes.docx'))
            req = u.call_args[0][0]
            assert 'Docs/Meeting%20Notes.docx' in req.full_url
            assert ' ' not in req.full_url
