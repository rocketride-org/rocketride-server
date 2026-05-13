# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Root-level pytest conftest.

Responsibilities
----------------
1. Register a minimal ``rocketlib`` stub in ``sys.modules`` **before** any
   test module is imported.

Why here and not inline in each test file
-----------------------------------------
Test files that inject ``sys.modules`` stubs inline (in module-body code) are
order-dependent: whichever file pytest collects first wins, and a later file's
``setdefault`` call is silently ignored.  Moving the registration to a
``conftest.py`` at the pytest root guarantees it runs exactly once, before any
test module body executes, regardless of collection order or parallel workers.

What is stubbed
---------------
``rocketlib`` and ``rocketlib.types`` are closed-source C-extension modules
that are only present inside the compiled ``dist/server`` package tree.  Many
unit tests import production code that in turn imports from ``rocketlib``.
The stubs below satisfy those imports with no-op Python objects so that the
test environment does not require a running server process.

Symbols stubbed:
  rocketlib.IInstanceBase  — base class for pipeline node instances
  rocketlib.tool_function  — decorator that registers a method as an agent tool
  rocketlib.types.IInvokeOp, IInvokeTool, IInvokeMemory — protocol types used
                             by the agent host; tests never instantiate them,
                             only import them for type annotations.

If rocketlib gains new top-level symbols that tests transitively import, add
them here.  This is the single source of truth for all rocketlib stubs.
"""

import sys
import types


def _ensure_rocketlib_stub() -> None:
    """Register the rocketlib stub if the real package is not already present.

    Uses ``setdefault`` so that if the genuine compiled module *is* available
    on ``sys.path`` (e.g. in a full server environment) it takes precedence and
    is never overwritten.
    """
    # ---- rocketlib top-level module ----------------------------------------

    _rocketlib = types.ModuleType('rocketlib')

    class _IInstanceBase:
        """No-op base class stub for rocketlib.IInstanceBase."""

    def _tool_function(fn=None, **_kwargs):
        """No-op decorator stub for @tool_function.

        Supports both bare (@tool_function) and called (@tool_function(...))
        decorator forms.
        """
        if fn is not None:
            return fn
        return lambda f: f

    _rocketlib.IInstanceBase = _IInstanceBase  # type: ignore[attr-defined]
    _rocketlib.tool_function = _tool_function  # type: ignore[attr-defined]
    sys.modules.setdefault('rocketlib', _rocketlib)

    # ---- rocketlib.types sub-module ----------------------------------------
    # Must be registered as a separate entry in sys.modules so that
    #   from rocketlib.types import IInvokeOp
    # resolves correctly even when rocketlib itself is a stub ModuleType
    # (Python's import system looks up 'rocketlib.types' by its full key).

    _rocketlib_types = types.ModuleType('rocketlib.types')
    for _name in ('IInvokeOp', 'IInvokeTool', 'IInvokeMemory'):
        setattr(_rocketlib_types, _name, object)
    sys.modules.setdefault('rocketlib.types', _rocketlib_types)

    # Attach as an attribute so ``import rocketlib; rocketlib.types`` also works.
    effective_rocketlib = sys.modules['rocketlib']
    if not hasattr(effective_rocketlib, 'types'):
        effective_rocketlib.types = sys.modules['rocketlib.types']  # type: ignore[attr-defined]


# Run at import time — conftest.py is imported by pytest before any test module.
_ensure_rocketlib_stub()
