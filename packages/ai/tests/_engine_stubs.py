"""Helpers for importing source modules without dist/server engine modules."""

import sys
import types
from importlib import import_module
from types import ModuleType
from typing import Any, Optional


def import_with_engine_stubs(module_name: str, rocketlib_attrs: Optional[dict[str, Any]] = None) -> ModuleType:
    """Import a module with temporary stubs and restore the import state."""
    stubs: dict[str, ModuleType] = {
        'depends': types.ModuleType('depends'),
        'rocketlib': types.ModuleType('rocketlib'),
    }
    stubs['depends'].depends = lambda *_args, **_kwargs: None  # type: ignore[attr-defined]
    for key, value in (rocketlib_attrs or {}).items():
        setattr(stubs['rocketlib'], key, value)

    saved_modules = sys.modules.copy()
    saved_parents = {}
    parts = module_name.split('.')
    for index in range(1, len(parts)):
        parent_name = '.'.join(parts[:index])
        parent = saved_modules.get(parent_name)
        if parent is not None:
            saved_parents[parent_name] = (parent, parent.__dict__.copy())

    sys.modules.update(stubs)
    sys.modules.pop(module_name, None)
    try:
        return import_module(module_name)
    finally:
        # Importing a submodule also mutates its already-loaded parent package
        # (for example, by assigning ``parent.child``). Restore both the module
        # registry and those parent dictionaries so this helper is collection-order
        # independent and leaves no dangling references behind.
        current_names = set(sys.modules)
        for name in current_names - saved_modules.keys():
            sys.modules.pop(name, None)
        for name, module in saved_modules.items():
            if sys.modules.get(name) is not module:
                sys.modules[name] = module
        for parent, saved_dict in saved_parents.values():
            parent.__dict__.clear()
            parent.__dict__.update(saved_dict)
