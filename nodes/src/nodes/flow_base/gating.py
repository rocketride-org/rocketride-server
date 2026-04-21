# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Zero-maintenance auto-gating for `flow_*` filter nodes.

Any filter whose job is "evaluate a condition per chunk, then route the
payload somewhere" — `flow_if_else`, `flow_switch`, `flow_for`, `flow_while`,
`flow_filter`, … — needs to intercept *every* content-bearing `writeXxx`
method the engine dispatches and run the same gating logic. Writing one
override per method is boilerplate, and silently breaks the day the engine
adds a new content lane (e.g. a future ``writeJson``) because the inherited
``IInstanceBase.writeX`` default is ``pass`` → chunks are dropped with no
warning.

``AutoGatingMixin`` closes that gap. Subclasses inherit from both
``IInstanceBase`` and ``AutoGatingMixin``, define a single ``_gate`` method,
and get every writeXxx override synthesised at class-creation time. When
the engine eventually adds a new content lane, rocketlib's ``IInstanceBase``
grows one more ``writeXxx(value) -> None: pass`` stub, and every
flow node picks it up automatically — no code change, no release bump.

Discovery:
- Inspects the concrete ``IInstanceBase`` in the subclass's MRO (not the
  Protocol — that one exists only for typing and is never dispatched to).
- Filters to ``write[A-Z]…`` methods with at least one non-self parameter.
- Excludes tag/framing signals (``writeTag``, ``writeTagBegin*``, …) that
  are lifecycle events, not content.

Payload inference:
- If a parameter's name equals the lowercased type suffix
  (``writeText(text)`` → ``'text'``, ``writeJson(json)`` → ``'json'``),
  that parameter is treated as the chunk for condition evaluation.
- Otherwise, the *last* positional parameter is used. This captures the
  ``(action, mimeType, buffer)`` pattern of streaming media methods
  (``writeImage``, ``writeAudio``, ``writeVideo``) where the buffer sits
  at the end.

Explicit overrides in the subclass body always win — the mixin never
replaces a method that was hand-written.
"""

from __future__ import annotations

import inspect
from typing import Any, Callable, Dict, Tuple


# Tag / framing lifecycle methods. These carry pipeline structure, not a
# content payload, so the gating logic doesn't apply to them.
_FRAMING_METHODS = frozenset(
    {
        'writeTag',
        'writeTagBeginObject',
        'writeTagBeginStream',
        'writeTagData',
        'writeTagEndObject',
        'writeTagEndStream',
    }
)


def _discover_content_write_methods(cls: type) -> Dict[str, Tuple[str, int]]:
    """Return a map ``{method_name: (payload_name, payload_arg_index)}`` for every
    content-bearing ``writeXxx`` on ``cls`` (walking the MRO).

    - ``payload_name`` is the binding name user expressions will use
      (e.g. ``'text'`` in ``cond.length(text, min=1)``).
    - ``payload_arg_index`` is the positional index of the payload among
      the method's non-``self`` parameters.
    """
    found: Dict[str, Tuple[str, int]] = {}
    for name, method in inspect.getmembers(cls, predicate=inspect.isfunction):
        if not name.startswith('write'):
            continue
        if name in _FRAMING_METHODS:
            continue
        suffix = name[5:]
        if not suffix or not suffix[0].isupper():
            continue
        try:
            sig = inspect.signature(method)
        except (TypeError, ValueError):
            continue
        params = [p for p in sig.parameters.values() if p.name != 'self']
        if not params:
            continue

        suffix_lower = suffix.lower()

        # Preferred: a parameter named exactly like the type suffix.
        payload_idx = next((i for i, p in enumerate(params) if p.name == suffix_lower), None)
        if payload_idx is None:
            # Fallback: last positional arg (streaming (action, mime, buffer) pattern).
            payload_idx = len(params) - 1

        # Binding name the user's expression sees. Use the suffix-lower so
        # `writeJson` binds as `json`, `writeImage` binds as `image`, etc.
        found[name] = (suffix_lower, payload_idx)
    return found


def _make_gated_method(method_name: str, payload_name: str, payload_idx: int) -> Callable:
    """Build a writeXxx method that funnels the call through ``self._gate``.

    The returned method forwards the *complete* argument list verbatim when
    the gate elects to emit — the engine sees the exact same call it would
    have seen without the filter. Only which downstream receives it changes.
    """

    def gated(self, *args: Any, **kwargs: Any) -> None:
        chunk = args[payload_idx] if payload_idx < len(args) else None

        def forward(_payload: Any) -> None:
            getattr(self.instance, method_name)(*args, **kwargs)

        self._gate(chunk, payload_name, forward)

    gated.__name__ = method_name
    gated.__qualname__ = method_name
    gated.__doc__ = f'Auto-gated override of {method_name}. Evaluates the filter condition with the incoming {payload_name!r} payload and routes the chunk to the selected branch.'
    return gated


class AutoGatingMixin:
    """Inherit alongside ``IInstanceBase`` to auto-gate every content writeXxx.

    The subclass must define:

    - ``_gate(chunk: Any, payload_name: str, forward: Callable[[Any], None]) -> None``

    The mixin synthesises every content ``writeXxx`` on class creation.
    Methods explicitly declared in the subclass body are left alone —
    they shadow the auto-generated versions.
    """

    def __init_subclass__(cls, **kwargs: Any) -> None:
        """Install auto-gated overrides for every content writeXxx on the MRO.

        Runs once per subclass creation. Methods explicitly defined in the
        subclass body are detected via ``vars(cls)`` and left untouched.
        """
        super().__init_subclass__(**kwargs)

        # Hand-written overrides in this class body win.
        explicit = set(vars(cls).keys())

        for method_name, (payload_name, payload_idx) in _discover_content_write_methods(cls).items():
            if method_name in explicit:
                continue
            setattr(cls, method_name, _make_gated_method(method_name, payload_name, payload_idx))
