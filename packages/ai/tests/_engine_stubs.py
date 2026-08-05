"""Helpers for importing source modules without dist/server engine modules."""

import sys
import types
from importlib import import_module
from types import ModuleType
from typing import Any


_MISSING = object()


def import_with_engine_stubs(module_name: str, rocketlib_attrs: dict[str, Any] | None = None) -> ModuleType:
    """Import a module with temporary stubs and restore the import state."""
    stubs: dict[str, ModuleType] = {
        'depends': types.ModuleType('depends'),
        'rocketlib': types.ModuleType('rocketlib'),
    }
    stubs['depends'].depends = lambda *_args, **_kwargs: None  # type: ignore[attr-defined]
    for key, value in (rocketlib_attrs or {}).items():
        setattr(stubs['rocketlib'], key, value)

    saved = {name: sys.modules.get(name, _MISSING) for name in (*stubs, module_name)}
    sys.modules.update(stubs)
    sys.modules.pop(module_name, None)
    try:
        return import_module(module_name)
    finally:
        for name, module in saved.items():
            if module is _MISSING:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
