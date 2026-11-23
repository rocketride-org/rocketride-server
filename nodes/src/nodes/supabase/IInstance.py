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
Shared instance base for the Supabase tool services.

A service tool is declared like this::

    @tool_function(input_schema={...}, description='... Needs the write access level.')
    @requires_access(WRITE)
    def create_user(self, args: dict) -> dict:
        email = require_str(args, 'email', tool_name=self._tool('create_user'))
        user = self._client().auth.admin.create_user({...})
        return self._output(user)

``@requires_access`` (always directly under ``@tool_function``):

1. checks the node's ``supabase.access`` level first and raises
   SupabaseAccessError (a PermissionError) when it is too low;
2. normalizes the raw tool input into a dict (``normalize_tool_input``);
3. lets ValueError / SupabaseAccessError / SupabaseError through (redacted);
4. turns any other exception into ``RuntimeError('<prefix>.<tool>: ...')``,
   redacted, without chaining the original (its args may hold secrets);
5. replaces any configured secret value that appears in the result.

The level is enforced in one place, :meth:`SupabaseInstanceBase._collect_tool_methods`,
the map the engine builds ``tool.query`` from and dispatches ``tool.invoke``
through: a tool above the node's level is neither listed to the agent nor
callable. The check inside ``@requires_access`` stays as a second wall for
direct calls. A service class with a ``@tool_function`` that has no
``@requires_access`` fails at import (``TypeError``), so it never loads.

No ``@tool_function`` may live on this base: the engine collects tools with
``dir(type(self))``, so a tool here would appear on every service.
"""

from __future__ import annotations

import functools
import json
from typing import Any, Callable, Dict, Iterable, Optional

from ai.common.utils import normalize_tool_input, optional_str, require_str
from rocketlib import IInstanceBase, warning

from . import supabase_client as sc
from .IGlobal import SupabaseGlobalBase
from .supabase_client import ADMIN, READ, WRITE  # noqa: F401  (re-exported for services)

ACCESS_ATTR = '__supabase_access__'


def requires_access(level: str) -> Callable:
    """Declare the access level a tool needs and wrap it with the shared checks."""
    if level not in sc.ACCESS_LEVELS:
        raise ValueError(f'requires_access: level must be one of {list(sc.ACCESS_LEVELS)}, got {level!r}')

    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        def wrapper(self: 'SupabaseInstanceBase', args: Any = None) -> Any:
            tool = self._tool(fn.__name__)
            glb = self.IGlobal
            redact = glb.redact
            if getattr(glb, 'connection', None) is None:
                raise RuntimeError(f'{tool}: node is not open')
            sc.require_access(glb.access, level, tool)
            normalized = normalize_tool_input(args, tool_name=tool)
            try:
                result = fn(self, normalized)
            except sc.SupabaseAccessError as e:
                raise sc.SupabaseAccessError(redact(str(e))) from None
            except sc.SupabaseError as e:
                message = redact(str(e))
                if not message.startswith(tool):
                    message = f'{tool}: {message}'
                raise sc.SupabaseError(message, status=e.status) from None
            except ValueError as e:
                message = redact(str(e))
                if message == str(e):
                    raise
                raise ValueError(message) from None
            except Exception as e:
                raise RuntimeError(f'{tool}: {redact(sc.describe_exception(e))}') from None
            return glb.redactor.scrub(result) if glb.redactor is not None else result

        setattr(wrapper, ACCESS_ATTR, level)
        return wrapper

    return decorator


def tool_access_level(method: Any) -> Optional[str]:
    """Return the level a tool declared with @requires_access, or None."""
    return getattr(method, ACCESS_ATTR, None)


def _declared_tools(cls: type) -> Dict[str, Optional[str]]:
    """Every @tool_function on ``cls`` (found as the engine finds them) -> its declared level or None."""
    tools = {}
    for name in dir(cls):
        attr = getattr(cls, name, None)
        if attr is not None and hasattr(attr, '__tool_meta__'):
            tools[name] = tool_access_level(attr)
    return tools


class SupabaseInstanceBase(IInstanceBase):
    """Shared accessors and helpers. Services add their @tool_function methods."""

    IGlobal: SupabaseGlobalBase

    def __init_subclass__(cls, **kwargs: Any) -> None:
        """Refuse a service class whose tool does not declare its access level.

        Such a tool would never be offered (``_collect_tool_methods`` fails
        closed), so the mistake is made loud where the developer sees it: the
        module does not import, and every test of the service fails.
        """
        super().__init_subclass__(**kwargs)
        undeclared = sorted(name for name, level in _declared_tools(cls).items() if level is None)
        if undeclared:
            raise TypeError(
                f'{cls.__module__}.{cls.__qualname__}: tool(s) {", ".join(undeclared)} declare no access level. '
                'Put @requires_access(READ | WRITE | ADMIN) directly under @tool_function.'
            )

    # ------------------------------------------------------------------
    # Engine hooks
    # ------------------------------------------------------------------

    def _collect_tool_methods(self) -> Dict[str, Callable]:
        """Offer only the tools the node's access level allows.

        The engine builds ``tool.query`` from this map and dispatches
        ``tool.invoke`` through it, so a tool left out is neither shown to
        the agent nor callable (the invoke falls through to "no node owns
        it"). A tool with no declared level is left out too: it fails
        closed. ``__init_subclass__`` already refuses such a class, so that
        branch only covers a tool attached some other way, and says so.
        """
        level = self.IGlobal.access
        offered: Dict[str, Callable] = {}
        for name, method in super()._collect_tool_methods().items():
            needed = tool_access_level(method)
            if needed is None:
                warning(f'{self._tool(name)}: not offered, because it declares no access level (@requires_access)')
                continue
            if sc.access_allows(level, needed):
                offered[name] = method
        return offered

    def beginInstance(self) -> None:
        """Say once per node, at start, when its access level offers the agent no tool at all.

        Otherwise a node left at the default ``read`` on a service whose tools
        all need ``write`` (Messaging, Edge Functions) looks broken: the agent
        sees no tool and nothing says why.
        """
        super().beginInstance()
        glb = self.IGlobal
        # _lock exists once beginGlobal opened the node; in CONFIG mode nothing runs.
        if glb._lock is None or self._collect_tool_methods():
            return
        levels = set(_declared_tools(type(self)).values())
        lowest = next((lvl for lvl in sc.ACCESS_LEVELS if lvl in levels), None)
        if lowest is None:  # a class with no tools at all has no level to suggest
            return
        # One message per node, not one per pipeline thread.
        with glb._lock:
            if glb.no_tools_reported:
                return
            glb.no_tools_reported = True
        warning(
            f'{glb.PRODUCT}: the access level is "{glb.access}", which offers the agent no tools. '
            f'Set "Access level" on the node to "{lowest}" to turn them on.'
        )

    # ------------------------------------------------------------------
    # Accessors
    # ------------------------------------------------------------------

    def _tool(self, name: str) -> str:
        """Qualified tool name for messages: '<prefix>.<tool>'."""
        return f'{self.IGlobal.SERVICE}.{name}'

    def _client(self) -> Any:
        """Shared supabase-py client (API services)."""
        return self.IGlobal.get_client()

    def _api(self) -> sc.SupabaseApi:
        """Shared HTTP helper (API services)."""
        return self.IGlobal.get_api()

    def _postgres(self):
        """Context manager yielding a psycopg2 connection (Postgres services)."""
        return self.IGlobal.postgres()

    # ------------------------------------------------------------------
    # Argument helpers (string/int helpers come from ai.common.utils)
    #
    # Convention for every service: a tool body computes its qualified name
    # once (``tool = self._tool('x')``) and every helper takes that qualified
    # name as ``tool_name``, the keyword ai.common.utils uses.
    # ------------------------------------------------------------------

    @staticmethod
    def _bounded_str(args: dict, key: str, *, tool_name: str, max_len: int, required: bool = True) -> Optional[str]:
        """A string arg of at most ``max_len`` characters.

        Required: missing or blank raises (``require_str``). Optional: missing
        or blank returns None, otherwise the trimmed value.
        """
        if required:
            value = require_str(args, key, tool_name=tool_name)
        else:
            value = optional_str(args, key, tool_name=tool_name)
            if value is None or not value.strip():
                return None
            value = value.strip()
        if len(value) > max_len:
            raise ValueError(f'{tool_name}: "{key}" must be at most {max_len} characters')
        return value

    @staticmethod
    def _enum_arg(
        args: dict, key: str, allowed: tuple, default: Optional[str], *, tool_name: str = ''
    ) -> Optional[str]:
        """Read an optional enum arg, defaulting on absence and rejecting unknown values."""
        value = args.get(key)
        if value is None or value == '':
            return default
        if value not in allowed:
            prefix = f'{tool_name}: ' if tool_name else ''
            raise ValueError(f'{prefix}"{key}" must be one of {list(allowed)}, got {value!r}')
        return value

    @staticmethod
    def _dict_arg(args: dict, key: str, *, default: Any = None, tool_name: str = '') -> Any:
        """Read an optional JSON object arg."""
        value = args.get(key)
        if value is None:
            return default
        if not isinstance(value, dict):
            prefix = f'{tool_name}: ' if tool_name else ''
            raise ValueError(f'{prefix}"{key}" must be a JSON object')
        return value

    @staticmethod
    def _json_size(value: Any) -> int:
        """Bytes of ``value`` as compact UTF-8 JSON (values JSON cannot hold are written as text)."""
        return len(json.dumps(value, separators=(',', ':'), default=str).encode('utf-8'))

    @classmethod
    def _check_json_size(cls, value: Any, key: str, *, tool_name: str, limit_kb: int, setting: str) -> int:
        """Refuse a JSON argument above ``limit_kb`` KB before it is sent; return its size in bytes.

        ``setting`` is the node field's label, so the message says what to raise.
        """
        size = cls._json_size(value)
        if size > limit_kb * 1024:
            raise ValueError(
                f'{tool_name}: "{key}" is {size} bytes; the limit is {limit_kb} KB ({setting} on the node)'
            )
        return size

    # ------------------------------------------------------------------
    # Output helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _output(value: Any, *, drop: Iterable[str] = (), keep: Iterable[str] = ()) -> Any:
        """JSON-safe copy of a supabase-py result with secret fields removed."""
        return sc.drop_secret_fields(sc.to_plain(value), extra=drop, keep=keep)
