# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Checks on the shared tool_masky test stubs themselves."""

from __future__ import annotations

import sys

import pytest

from ._stubs import STUB_MODULE_NAMES, scoped_stubs


def test_parse_bool_is_the_engine_one():
    with scoped_stubs():
        parse_bool = sys.modules['ai.common.utils'].parse_bool
        assert [parse_bool(v) for v in ('false', 'False', '0', 'no', '')] == [False] * 5
        assert [parse_bool(v) for v in ('true', 'YES', '1', 'on')] == [True] * 4


def test_tool_args_helpers_are_the_real_ones():
    with scoped_stubs():
        utils = sys.modules['ai.common.utils']
        assert utils.require_str({'k': 'v'}, 'k') == 'v'
        with pytest.raises(ValueError):
            utils.require_bool({'k': 'true'}, 'k')


def test_tools_base_is_a_plain_class_by_default():
    with scoped_stubs() as env:
        assert env.tools_base.__mro__ == (env.tools_base, object)


@pytest.mark.skipif(sys.version_info < (3, 10), reason='the engine ToolsBase uses match statements')
def test_real_tools_base_flag_loads_the_engine_class():
    with scoped_stubs(real_tools_base=True) as env:
        assert env.tools_base.__name__ == 'ToolsBase'
        assert hasattr(env.tools_base, 'handle_invoke')
        assert sys.modules['ai.common.tools'].ToolsBase is env.tools_base


def test_scope_restores_sys_modules():
    before = {name: sys.modules.get(name) for name in STUB_MODULE_NAMES}
    with scoped_stubs():
        assert sys.modules['rocketlib'] is not before['rocketlib']
    assert {name: sys.modules.get(name) for name in STUB_MODULE_NAMES} == before
