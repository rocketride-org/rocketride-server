# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Loader for the adapter tool-builder tests: real LangChain and Pydantic, engine stubs only where needed.

Other test modules keep hand-built ``langchain_core`` stubs in ``sys.modules``: the
parser test from collection on, the DeepAgent envelope test while it runs. A tool
built on a stub ``BaseTool`` proves nothing about whether the framework accepts
``_rr_input_schema``, so these tests swap the stubs out and put them back afterwards.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
import types
from pathlib import Path
from typing import Any, Callable, Dict

import pytest

from ._sys_modules_guard import _is_stub_module

_NODES_SRC = Path(__file__).resolve().parents[1] / 'src' / 'nodes'
_REAL_PACKAGES = ('langchain_core', 'langchain', 'pydantic')


def _safe_str(value: Any) -> str:
    return '' if value is None else str(value)


# What each adapter imports from the engine at module level. Names with no symbols are parent packages.
LANGCHAIN_SYMBOLS: Dict[str, Dict[str, Any]] = {
    'rocketlib': {'ToolDescriptor': object},
    'ai': {},
    'ai.common': {},
    'ai.common.agent': {'AgentBase': object, 'AgentContext': object},
    'ai.common.agent.types': {'AgentRunResult': object},
    'ai.common.schema': {'Question': object},
    'ai.common.utils': {
        'langchain_messages_to_transcript': lambda *a, **kw: '',
        'normalize_bound_tools': lambda *a, **kw: [],
        'safe_str': _safe_str,
    },
}
DEEPAGENT_SYMBOLS: Dict[str, Dict[str, Any]] = {
    **LANGCHAIN_SYMBOLS,
    'rocketlib': {'ToolDescriptor': object, 'error': lambda *a, **kw: None},
}


def real_langchain_or_skip() -> Callable[[], None]:
    """Swap stubs out for the real packages and return the function that puts them back. Skip when not installed.

    For each package that had a stub, the function drops the real modules imported since the swap, and their
    attributes on parent modules, then puts the stubs back. A test module that keeps its own stubs then never finds a
    real submodule under a stub parent, whatever the test order. A package with no stub is left alone: dropping a real
    ``pydantic`` that was already loaded would make the next importer build second copies of its classes.
    """
    stubs = {
        name: module
        for name, module in sys.modules.items()
        if any(name == p or name.startswith(p + '.') for p in _REAL_PACKAGES) and _is_stub_module(module)
    }
    for name in stubs:
        del sys.modules[name]
    before = set(sys.modules)
    packages = {name.partition('.')[0] for name in stubs}

    def restore() -> None:
        for name in [n for n in sys.modules if n not in before and n.partition('.')[0] in packages]:
            module = sys.modules.pop(name)
            parent, _, child = name.rpartition('.')
            if getattr(sys.modules.get(parent), child, None) is module:
                delattr(sys.modules[parent], child)
        for name, module in stubs.items():
            sys.modules[name] = module
            parent, _, child = name.rpartition('.')
            if parent in sys.modules:
                setattr(sys.modules[parent], child, module)

    try:
        real = importlib.import_module('langchain_core.tools').BaseTool is not object
        importlib.import_module('pydantic')
    except Exception:
        real = False
    if not real:
        restore()
        pytest.skip('real langchain_core unavailable')
    return restore


def engine_stubs(symbols: Dict[str, Dict[str, Any]]) -> Callable[[], None]:
    """Stub each named module that cannot be imported and return the function that removes those stubs."""
    installed = []
    for name, attrs in symbols.items():
        try:
            importlib.import_module(name)
        except Exception:
            stub = types.ModuleType(name)
            for attr, value in attrs.items():
                setattr(stub, attr, value)
            sys.modules[name] = stub
            installed.append(name)

    def remove() -> None:
        for name in installed:
            sys.modules.pop(name, None)

    return remove


def load_adapter(relative_path: str, module_name: str, symbols: Dict[str, Dict[str, Any]]) -> types.ModuleType:
    """Load an adapter by file path, which skips the node package's engine-only ``__init__``."""
    remove = engine_stubs(symbols)
    try:
        spec = importlib.util.spec_from_file_location(module_name, _NODES_SRC / relative_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        remove()
    return module
