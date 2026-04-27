# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Zero-maintenance auto-gating for `flow_*` filter nodes.

Any filter whose job is "evaluate a condition per chunk, then route the
payload somewhere" — today `flow_if_else`, and any future flow_* router
built on this same scaffolding — needs to intercept *every* content-bearing
``writeXxx`` method the engine dispatches and run the same gating logic.
Writing one override per method is boilerplate, and silently breaks the day
the engine adds a new content lane (e.g. a future ``writeJson``) because
the inherited ``IInstanceBase.writeX`` default is ``pass`` → chunks are
dropped with no warning.

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

# AVI_ACTION constants for streaming-method detection. Imported lazily so
# that flow_base remains importable in pure-Python test environments
# where rocketlib (the engine binding) is stubbed out.
try:
    from rocketlib import AVI_ACTION as _AVI_ACTION  # type: ignore

    _AVI_BEGIN = _AVI_ACTION.BEGIN
    _AVI_WRITE = _AVI_ACTION.WRITE
    _AVI_END = _AVI_ACTION.END
    _AVI_AVAILABLE = True
except (ImportError, AttributeError):
    _AVI_BEGIN = _AVI_WRITE = _AVI_END = None
    _AVI_AVAILABLE = False


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
        # Also remember every other parameter name so the gated wrapper can
        # pass them as additional sandbox bindings (e.g. `mimeType`,
        # `action` for streaming methods like writeImage/Audio/Video).
        param_names = tuple(p.name for p in params)
        found[name] = (suffix_lower, payload_idx, param_names)
    return found


def _is_streaming_method(param_names: tuple) -> bool:
    """Return True if the method follows the rocketlib streaming convention.

    Streaming methods have an ``action`` parameter (``writeImage`` /
    ``writeAudio`` / ``writeVideo``). They come in BEGIN → WRITE … → END
    sequences and need stream-aware gating so the condition sees the
    complete payload, not a per-action fragment.
    """
    return _AVI_AVAILABLE and 'action' in param_names


def _stream_state_attr(method_name: str) -> str:
    """Per-method, per-instance attribute name that holds the in-flight
    streaming buffer (list of buffered calls + accumulated payload bytes).
    Scoped per method so simultaneous writeImage / writeAudio streams on
    the same instance don't collide.
    """
    return f'_flow_stream_state_{method_name}'


def _make_gated_streaming_method(method_name: str, payload_name: str, payload_idx: int, param_names: tuple) -> Callable:
    """Stream-aware gated method.

    Buffers BEGIN / WRITE+ / END calls internally and only evaluates the
    condition once — at END — with the **complete accumulated payload**.
    Then replays the buffered calls verbatim to the chosen target so the
    downstream node receives the same BEGIN / WRITE / END sequence it
    would have without the gate.

    This makes user expressions on streaming methods behave the same as
    on single-call methods (writeText / writeTable):

    - ``image[:4] == b'\\x89PNG'`` — sees full file bytes, not the empty
      buffer of BEGIN / END.
    - ``cond.length(image, min=N)`` — sees full file size.
    - ``mimeType == 'image/png'`` — also works because mimeType is
      stable across actions; both styles now route correctly.

    Without this wrapper, the same condition would be evaluated 3+ times
    per file — once per action — and the chunk's BEGIN, WRITE, and END
    could be split across distinct destinations, leaving each downstream
    with an incomplete stream.
    """
    state_attr = _stream_state_attr(method_name)
    try:
        action_idx = param_names.index('action')
    except ValueError:
        action_idx = 0  # defensive default — shouldn't happen for streaming

    def gated(self, *args: Any, **kwargs: Any) -> None:
        action = args[action_idx] if action_idx < len(args) else kwargs.get('action')

        # Initialise (or reset on a fresh BEGIN) the per-method state.
        state = getattr(self, state_attr, None)
        if state is None or action == _AVI_BEGIN:
            state = {'calls': [], 'buffer': bytearray()}
            setattr(self, state_attr, state)

        # Capture this call verbatim for later replay.
        state['calls'].append((args, kwargs))

        # Accumulate payload bytes (only WRITE carries data; BEGIN / END
        # have empty buffers).
        chunk = args[payload_idx] if payload_idx < len(args) else None
        if isinstance(chunk, (bytes, bytearray)) and chunk:
            state['buffer'].extend(chunk)

        # BEGIN and intermediate WRITE actions are buffered only —
        # decision and forward happen on END.
        if action != _AVI_END:
            return self.preventDefault()

        # END: evaluate condition with the full accumulated payload and
        # replay every buffered call to the chosen target.
        full_buffer = bytes(state['buffer'])

        # Build extras from the END-call args by name. Override `buffer`
        # alias (if the method uses that name) with the full payload so
        # both `image` and `buffer` bindings see the same complete bytes.
        extras: dict = {}
        for i, pname in enumerate(param_names):
            if pname == payload_name:
                continue
            if i < len(args):
                extras[pname] = args[i]
            elif pname in kwargs:
                extras[pname] = kwargs[pname]
        if 'buffer' in extras:
            extras['buffer'] = full_buffer

        buffered_calls = state['calls']

        def forward(_payload: Any) -> None:
            for a, kw in buffered_calls:
                getattr(self.instance, method_name)(*a, **kw)

        # Reset state before _gate runs in case the gate itself triggers
        # a re-entrant write (rare, but defensive).
        try:
            delattr(self, state_attr)
        except AttributeError:
            pass

        self._gate(full_buffer, payload_name, forward, extras=extras)

    gated.__name__ = method_name
    gated.__qualname__ = method_name
    gated.__doc__ = f'Stream-aware gated override of {method_name}. Buffers BEGIN/WRITE/END and evaluates the condition once with the complete accumulated {payload_name!r} payload.'
    return gated


def _make_gated_method(method_name: str, payload_name: str, payload_idx: int, param_names: tuple) -> Callable:
    """Build a writeXxx method that funnels the call through ``self._gate``.

    The returned method forwards the *complete* argument list verbatim when
    the gate elects to emit — the engine sees the exact same call it would
    have seen without the filter. Only which downstream receives it changes.

    Extra parameters beyond the payload (e.g. ``action``, ``mimeType`` on
    streaming methods) are exposed in the sandbox under their declared
    names so conditions can branch on them. This is the only way to write
    a condition that is stable across the BEGIN/WRITE/END streaming
    sequence — buffer changes per action, but ``mimeType`` does not.
    """

    def gated(self, *args: Any, **kwargs: Any) -> None:
        chunk = args[payload_idx] if payload_idx < len(args) else None

        # Build extra bindings from every named arg except the payload.
        extras: dict = {}
        for i, pname in enumerate(param_names):
            if pname == payload_name:
                continue
            if i < len(args):
                extras[pname] = args[i]
            elif pname in kwargs:
                extras[pname] = kwargs[pname]

        def forward(_payload: Any) -> None:
            getattr(self.instance, method_name)(*args, **kwargs)

        self._gate(chunk, payload_name, forward, extras=extras)

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

        for method_name, (payload_name, payload_idx, param_names) in _discover_content_write_methods(cls).items():
            if method_name in explicit:
                continue
            # Streaming methods (writeImage / writeAudio / writeVideo)
            # need BEGIN/WRITE/END buffered into one logical chunk so the
            # condition sees the full payload.
            if _is_streaming_method(param_names):
                factory = _make_gated_streaming_method
            else:
                factory = _make_gated_method
            setattr(cls, method_name, factory(method_name, payload_name, payload_idx, param_names))
