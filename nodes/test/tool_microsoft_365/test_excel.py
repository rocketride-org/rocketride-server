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
Focused tests for the Excel service.

Real ``IInstance`` method calls with only the HTTP layer
(``graph_client._urlopen``) mocked, mirroring ``test_word.py``'s bootstrap.
"""

from __future__ import annotations

import json
import sys
import types
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest import mock

import pytest

_TEST_DIR = Path(__file__).resolve().parents[2]  # nodes/test -> nodes
_REPO_ROOT = _TEST_DIR.parent
_NODES_SRC = _TEST_DIR / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

# Self-sufficient bootstrap (same technique as test_outlook_calendar.py /
# test_outlook_mail_guards.py): stub the engine runtime modules the word
# package imports (depends/rocketlib/ai.common.config), but load the *real*
# ai.common.utils.tool_args module directly by file path — it has no heavy
# deps (json/typing/rocketlib.warning only) — so normalize_tool_input/
# require_str/require_str_list behave exactly as in production instead of
# returning MagicMocks.
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
from nodes.tool_microsoft_365.excel.IInstance import IInstance  # noqa: E402

from nodes.core.microsoft_access import EXCEL, MicrosoftAccessError, resolve_microsoft_access  # noqa: E402

for _name in _added:
    sys.modules.pop(_name, None)
if _fresh_nodes:
    for _name in [k for k in list(sys.modules) if k == 'nodes' or k.startswith('nodes.')]:
        sys.modules.pop(_name, None)


def _json_resp(body: dict, status: int = 200):
    m = mock.MagicMock()
    m.read.return_value = json.dumps(body).encode()
    m.status = status
    m.headers = {}
    m.__enter__ = lambda s: s
    m.__exit__ = lambda s, *a: False
    return m


def _instance(*, tier: str) -> IInstance:
    inst = IInstance()
    access = resolve_microsoft_access({'access': tier}, EXCEL)
    auth = mock.MagicMock()
    auth.token.return_value = 'TOK'
    inst.IGlobal = types.SimpleNamespace(access=access, auth=auth, cfg={'authType': 'user'})
    return inst


class TestReadTable:
    def test_follows_next_link_and_unwraps_row_values(self):
        inst = _instance(tier='readonly')
        page1 = {
            'value': [{'index': 0, 'values': [['a', 1]]}, {'index': 1, 'values': [['b', 2]]}],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/drive/root:/r.xlsx:/workbook/tables/T/rows?$skip=2',
        }
        page2 = {'value': [{'index': 2, 'values': [['c', 3]]}]}
        with mock.patch.object(gc, '_urlopen', side_effect=[_json_resp(page1), _json_resp(page2)]) as u:
            out = inst.excel_read_table({'file': 'r.xlsx', 'table': 'T'})
        assert out == {'rows': [['a', 1], ['b', 2], ['c', 3]]}
        assert u.call_count == 2
        assert u.call_args_list[1][0][0].full_url == page1['@odata.nextLink']

    def test_readonly_tier_blocks_add_table_rows(self):
        inst = _instance(tier='readonly')
        with pytest.raises(MicrosoftAccessError, match='read-only'):
            inst.excel_add_table_rows({'file': 'r.xlsx', 'table': 'T', 'rows': [['x']]})
