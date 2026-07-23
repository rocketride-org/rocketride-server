# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression tests for Chroma `Store._coercePort`: port config coercion (issue RR-1416, I-11).

The port schema accepts both a number and a string so env-var placeholders
(which interpolate to a string, e.g. '${ROCKETRIDE_CHROMA_PORT}') validate.
`_coercePort` normalizes whatever survives schema validation to the int the
chromadb HTTP client requires. These tests pin each branch so a future refactor
cannot silently regress it.
"""

from __future__ import annotations

import importlib.util
import math
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

_STUB_MODULE_NAMES = (
    'chromadb',
    'chromadb.config',
    'numpy',
    'chroma_store_under_test',
)


def _install_min_stubs() -> None:
    """Minimal stubs so `chroma.py` can execute for the `_coercePort` tests."""
    chromadb = types.ModuleType('chromadb')

    class _HttpClient:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

    chromadb.HttpClient = _HttpClient
    chromadb.Collection = object
    sys.modules['chromadb'] = chromadb

    chromadb_config = types.ModuleType('chromadb.config')

    class Settings:
        def __init__(self, *_a: object, **_k: object) -> None:
            pass

    chromadb_config.Settings = Settings
    sys.modules['chromadb.config'] = chromadb_config

    numpy_mod = types.ModuleType('numpy')
    numpy_mod.exp = math.exp
    numpy_mod.int64 = int
    sys.modules['numpy'] = numpy_mod


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    _install_min_stubs()
    try:
        yield
    finally:
        for name in _STUB_MODULE_NAMES:
            if original.get(name) is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original[name]


def _load_store_class() -> type:
    nodes_root = Path(__file__).resolve().parent.parent.parent
    chroma_py = nodes_root / 'src' / 'nodes' / 'store_chroma' / 'chroma.py'
    with _scoped_stubs():
        spec = importlib.util.spec_from_file_location('chroma_store_under_test', chroma_py)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.Store


def test_coerce_port_plain_integer_passes_through() -> None:
    """An already-integer port is returned unchanged."""
    Store = _load_store_class()
    result = Store._coercePort(8000)
    assert result == 8000
    assert isinstance(result, int)


def test_coerce_port_numeric_string_is_parsed() -> None:
    """A numeric string (e.g. from an env var) is parsed to an int."""
    Store = _load_store_class()
    result = Store._coercePort('8000')
    assert result == 8000
    assert isinstance(result, int)


def test_coerce_port_numeric_string_is_stripped() -> None:
    """Surrounding whitespace is stripped before parsing."""
    Store = _load_store_class()
    result = Store._coercePort(' 443 ')
    assert result == 443
    assert isinstance(result, int)


def test_coerce_port_unresolved_placeholder_falls_back_to_default() -> None:
    """An unresolved '${...}' placeholder is not numeric and uses the default."""
    Store = _load_store_class()
    result = Store._coercePort('${ROCKETRIDE_CHROMA_PORT}')
    assert result == 8000
    assert isinstance(result, int)


def test_coerce_port_non_numeric_string_falls_back_to_default() -> None:
    """Any other non-numeric string uses the default rather than crashing."""
    Store = _load_store_class()
    result = Store._coercePort('abc')
    assert result == 8000
    assert isinstance(result, int)


def test_coerce_port_whole_number_float_is_truncated_to_int() -> None:
    """A JSON 'number' arriving as a whole-number float coerces to that int (not the default)."""
    Store = _load_store_class()
    result = Store._coercePort(8443.0)
    assert result == 8443
    assert isinstance(result, int)


def test_coerce_port_fractional_float_falls_back_to_default() -> None:
    """A fractional float is an invalid port and falls back to the default."""
    Store = _load_store_class()
    result = Store._coercePort(8000.5)
    assert result == 8000
    assert isinstance(result, int)


def test_coerce_port_bool_falls_back_to_default() -> None:
    """A bool is an int subclass but never a valid port, so it uses the default."""
    Store = _load_store_class()
    assert Store._coercePort(True) == 8000
    assert Store._coercePort(False) == 8000


def test_coerce_port_none_falls_back_to_default() -> None:
    """A missing/None value uses the default."""
    Store = _load_store_class()
    result = Store._coercePort(None)
    assert result == 8000
    assert isinstance(result, int)


def test_coerce_port_respects_custom_default() -> None:
    """The default is configurable and returned for unparseable input."""
    Store = _load_store_class()
    assert Store._coercePort('${MISSING}', default=443) == 443


def test_coerce_port_int_out_of_range_falls_back_to_default() -> None:
    """Integers outside the 1-65535 TCP port range fall back to the default."""
    Store = _load_store_class()
    assert Store._coercePort(-1) == 8000
    assert Store._coercePort(0) == 8000
    assert Store._coercePort(99999) == 8000


def test_coerce_port_string_out_of_range_falls_back_to_default() -> None:
    """Numeric strings outside the 1-65535 range fall back to the default."""
    Store = _load_store_class()
    assert Store._coercePort('0') == 8000
    assert Store._coercePort('99999') == 8000


def test_coerce_port_whole_float_out_of_range_falls_back_to_default() -> None:
    """A whole-number float outside the 1-65535 range falls back to the default."""
    Store = _load_store_class()
    assert Store._coercePort(99999.0) == 8000


def test_coerce_port_in_range_boundaries_pass() -> None:
    """The 1 and 65535 boundaries (and an in-range whole float) pass through."""
    Store = _load_store_class()
    assert Store._coercePort(65535) == 65535
    assert Store._coercePort(1) == 1
    assert Store._coercePort(443.0) == 443
