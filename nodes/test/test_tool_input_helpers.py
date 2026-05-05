# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the tool-input helpers in ``rocketlib.filters``:

* ``normalize_tool_input`` — envelope-strip / input-coercion.
* ``require_str`` / ``require_int`` / ``optional_str`` — argument validators.

These were previously copy-pasted across tool nodes (tool_github,
tool_firecrawl, tool_exa_search, tool_pipe, tool_filesystem); pinning the
shared helpers' contract here means future bug fixes only need to land
in one place.

Importing the full ``rocketlib`` package pulls in the C++ ``engLib`` module
and triggers a ``depends()`` bootstrap that writes into the Python install
directory — neither is available in a plain unit-test environment. We
sidestep that by loading just ``filters.py`` into a synthetic ``rocketlib``
package with stubbed ``rocketlib.types`` / ``rocketlib.error`` / ``engLib``
siblings.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest


# ---------------------------------------------------------------------------
# Lightweight stub-loader: produces a ``rocketlib.filters`` module that
# binds normalize_tool_input without dragging in engLib / pydantic / pip.
# ---------------------------------------------------------------------------


def _load_filters_module() -> ModuleType:
    rocketlib_root = (
        Path(__file__).resolve().parents[2]
        / 'packages'
        / 'server'
        / 'engine-lib'
        / 'rocketlib-python'
        / 'lib'
        / 'rocketlib'
    )

    class _Sentinel:
        def __getattr__(self, name):  # noqa: ARG002
            return _Sentinel()

        def __call__(self, *args, **kwargs):  # noqa: ARG002
            return None

    # Stub engLib so ``from engLib import IFilterInstance`` (which filters.py
    # runs at import time inside ``_patch_classes()``) succeeds.
    eng = ModuleType('engLib')
    eng.IFilterInstance = type('IFilterInstance', (), {})
    sys.modules.setdefault('engLib', eng)

    # Synthetic ``rocketlib`` package — just a namespace so the relative
    # imports in filters.py resolve without executing the real __init__.
    pkg = ModuleType('rocketlib')
    pkg.__path__ = []  # mark as package so ``from .x`` works
    sys.modules.setdefault('rocketlib', pkg)

    # rocketlib.types stub: filters.py imports OPEN_MODE, ENDPOINT_MODE,
    # SERVICE_MODE, Entry, IControl, IInvoke from it.
    types_mod = ModuleType('rocketlib.types')
    types_mod.OPEN_MODE = _Sentinel()
    types_mod.ENDPOINT_MODE = _Sentinel()
    types_mod.SERVICE_MODE = _Sentinel()
    types_mod.Entry = type('Entry', (), {})
    types_mod.IControl = type('IControl', (), {'control': '', 'param': None, 'result': None})
    types_mod.IInvoke = type('IInvoke', (), {})
    sys.modules.setdefault('rocketlib.types', types_mod)
    pkg.types = types_mod

    # rocketlib.error stub: filters.py imports APERR and Ec.
    error_mod = ModuleType('rocketlib.error')

    class _APERR(Exception):
        def __init__(self, code, msg=''):
            self.code = code
            self.msg = msg
            super().__init__(msg)

    error_mod.APERR = _APERR
    error_mod.Ec = SimpleNamespace(PreventDefault='PreventDefault', InvalidParam='InvalidParam')
    sys.modules.setdefault('rocketlib.error', error_mod)
    pkg.error = error_mod

    # rocketlib.engine stub: filters.py lazy-imports ``warning`` from it.
    engine_mod = ModuleType('rocketlib.engine')
    engine_mod.warning = lambda *a, **kw: None
    engine_mod.monitorSSE = lambda *a, **kw: None
    sys.modules.setdefault('rocketlib.engine', engine_mod)
    pkg.engine = engine_mod

    # Now load filters.py as ``rocketlib.filters``. The trailing
    # ``_patch_classes()`` call needs ``engLib.IFilterInstance`` (stubbed
    # above) and is otherwise harmless.
    spec = importlib.util.spec_from_file_location(
        'rocketlib.filters',
        rocketlib_root / 'filters.py',
    )
    assert spec is not None and spec.loader is not None
    filters_mod = importlib.util.module_from_spec(spec)
    sys.modules['rocketlib.filters'] = filters_mod
    spec.loader.exec_module(filters_mod)
    pkg.filters = filters_mod
    return filters_mod


_filters = _load_filters_module()
normalize_tool_input = _filters.normalize_tool_input
require_str = _filters.require_str
require_int = _filters.require_int
optional_str = _filters.optional_str


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestNormalizeToolInput:
    def test_none_returns_empty_dict(self):
        assert normalize_tool_input(None) == {}

    def test_plain_dict_passes_through(self):
        assert normalize_tool_input({'a': 1, 'b': 'x'}) == {'a': 1, 'b': 'x'}

    def test_pydantic_like_model_dump(self):
        class Fake:
            def model_dump(self):
                return {'a': 1}

        assert normalize_tool_input(Fake()) == {'a': 1}

    def test_pydantic_v1_dict_fallback(self):
        class FakeV1:
            def dict(self):
                return {'a': 2}

        assert normalize_tool_input(FakeV1()) == {'a': 2}

    def test_pydantic_unwrap_disabled(self):
        class Fake:
            def model_dump(self):
                return {'should': 'not appear'}

        assert normalize_tool_input(Fake(), unwrap_pydantic=False) == {}

    def test_json_string_parsed(self):
        assert normalize_tool_input('{"q": "hello"}') == {'q': 'hello'}

    def test_json_parse_disabled(self):
        assert normalize_tool_input('{"q": "hello"}', parse_json_strings=False) == {}

    def test_unparseable_json_returns_empty(self):
        assert normalize_tool_input('not-json') == {}

    def test_json_string_array_returns_empty(self):
        # Valid JSON, but not a dict — agent-supplied scalars/lists at the
        # tool-args level are nonsense, so we drop them.
        assert normalize_tool_input('[1, 2, 3]') == {}

    def test_unexpected_type_returns_empty(self):
        assert normalize_tool_input(42) == {}
        assert normalize_tool_input([1, 2]) == {}

    def test_nested_input_envelope_unwrapped(self):
        result = normalize_tool_input({'input': {'q': 'hi', 'limit': 5}})
        assert result == {'q': 'hi', 'limit': 5}

    def test_top_level_keys_win_on_conflict(self):
        result = normalize_tool_input({'input': {'q': 'inner'}, 'q': 'outer'})
        assert result == {'q': 'outer'}

    def test_security_context_stripped(self):
        result = normalize_tool_input({'q': 'x', 'security_context': {'user': 'a'}})
        assert result == {'q': 'x'}

    def test_security_context_stripped_from_inside_input_envelope(self):
        result = normalize_tool_input({'input': {'q': 'x', 'security_context': {'user': 'a'}}})
        assert result == {'q': 'x'}

    def test_non_dict_input_envelope_left_alone(self):
        # If 'input' isn't a dict (e.g. an int), the helper should not crash
        # and should not unwrap — the value stays at the top level.
        result = normalize_tool_input({'input': 5, 'q': 'hi'})
        assert result == {'input': 5, 'q': 'hi'}

    def test_extra_envelope_key_unwrapped(self):
        result = normalize_tool_input(
            {'params': {'q': 'hi', 'n': 3}},
            extra_envelope_keys=('params',),
        )
        assert result == {'q': 'hi', 'n': 3}

    def test_input_envelope_takes_precedence_over_extras(self):
        result = normalize_tool_input(
            {'input': {'a': 1}, 'params': {'b': 2}},
            extra_envelope_keys=('params',),
        )
        assert result == {'a': 1, 'b': 2}

    def test_empty_dict_returns_empty(self):
        assert normalize_tool_input({}) == {}

    def test_warning_emitted_for_unexpected_type(self, monkeypatch):
        from rocketlib import engine as engine_module  # the stub from _load_filters_module

        captured: list[str] = []
        monkeypatch.setattr(engine_module, 'warning', lambda msg: captured.append(msg))

        result = normalize_tool_input(42, tool_name='exa_search')

        assert result == {}
        assert len(captured) == 1
        assert 'exa_search' in captured[0]
        assert 'int' in captured[0]


# ---------------------------------------------------------------------------
# require_str
# ---------------------------------------------------------------------------


class TestRequireStr:
    def test_returns_stripped_value(self):
        assert require_str({'path': '  /etc/hosts  '}, 'path') == '/etc/hosts'

    def test_accepts_already_clean_value(self):
        assert require_str({'q': 'hello'}, 'q') == 'hello'

    def test_missing_key_raises(self):
        with pytest.raises(ValueError, match='"path" is required'):
            require_str({}, 'path')

    def test_none_value_raises(self):
        with pytest.raises(ValueError, match='"path" is required'):
            require_str({'path': None}, 'path')

    def test_empty_string_raises(self):
        with pytest.raises(ValueError, match='"path" is required'):
            require_str({'path': ''}, 'path')

    def test_whitespace_only_raises(self):
        with pytest.raises(ValueError, match='"path" is required'):
            require_str({'path': '   '}, 'path')

    def test_non_string_raises(self):
        # The old tool_github helper crashed with AttributeError here; the
        # canonical helper raises a clean ValueError.
        with pytest.raises(ValueError, match='"path" is required'):
            require_str({'path': 42}, 'path')

    def test_tool_name_prefixes_error(self):
        with pytest.raises(ValueError, match='file_create: "path" is required'):
            require_str({}, 'path', tool_name='file_create')


# ---------------------------------------------------------------------------
# require_int
# ---------------------------------------------------------------------------


class TestRequireInt:
    def test_int_passes_through(self):
        assert require_int({'n': 42}, 'n') == 42

    def test_numeric_string_coerced(self):
        assert require_int({'n': '42'}, 'n') == 42

    def test_missing_key_raises(self):
        with pytest.raises(ValueError, match='"n" is required'):
            require_int({}, 'n')

    def test_none_value_raises(self):
        with pytest.raises(ValueError, match='"n" is required'):
            require_int({'n': None}, 'n')

    def test_non_numeric_string_raises(self):
        with pytest.raises(ValueError, match='"n" must be an integer'):
            require_int({'n': 'abc'}, 'n')

    def test_bool_rejected(self):
        # bool is an int subclass — agents passing {"issue_number": true}
        # should NOT silently get 1.
        with pytest.raises(ValueError, match='"n" must be an integer'):
            require_int({'n': True}, 'n')
        with pytest.raises(ValueError, match='"n" must be an integer'):
            require_int({'n': False}, 'n')

    def test_tool_name_prefixes_error(self):
        with pytest.raises(ValueError, match='issue_get: "issue_number" is required'):
            require_int({}, 'issue_number', tool_name='issue_get')


# ---------------------------------------------------------------------------
# optional_str
# ---------------------------------------------------------------------------


class TestOptionalStr:
    def test_returns_value_when_present(self):
        assert optional_str({'encoding': 'latin-1'}, 'encoding') == 'latin-1'

    def test_returns_default_when_missing(self):
        assert optional_str({}, 'encoding', default='utf-8') == 'utf-8'

    def test_returns_default_when_none(self):
        assert optional_str({'encoding': None}, 'encoding', default='utf-8') == 'utf-8'

    def test_default_defaults_to_none(self):
        assert optional_str({}, 'encoding') is None

    def test_does_not_strip(self):
        # Unlike require_str, optional_str preserves the value as-is — an
        # explicit empty string stays empty.
        assert optional_str({'encoding': ''}, 'encoding') == ''

    def test_non_string_raises(self):
        with pytest.raises(ValueError, match='"encoding" must be a string'):
            optional_str({'encoding': 42}, 'encoding')

    def test_tool_name_prefixes_error(self):
        with pytest.raises(ValueError, match='read_file: "encoding" must be a string'):
            optional_str({'encoding': 42}, 'encoding', tool_name='read_file')
