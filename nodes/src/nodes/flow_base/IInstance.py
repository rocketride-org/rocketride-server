# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Abstract base class for `flow_*` conditional routers.

Provides:
- Explicit `writeXxx` overrides for every content lane (text, table,
  image, audio, video, questions, answers, documents, classifications).
- Streaming-aware buffering for the AVI lanes (image / audio / video):
  BEGIN / WRITE+ / END are accumulated and the condition is evaluated
  once with the complete payload, then the buffered calls are replayed
  against the chosen branch's targets.
- Branch dispatch via `peer = self.instance.getInstance(node_id)` plus
  `peer.writeXxx(...)`. The peer's pybind11 trampoline routes the call
  into the target node's Python `writeXxx` override directly — no
  binder state, no broadcast fan-out.

Concrete subclasses implement only ``checkCondition(condition, **kwargs)``.
The lane handlers, the streaming buffer, the branch routing — all live
here so the only difference between a Python-eval flow and an
LLM-evaluated flow is the condition evaluation strategy.
"""

from __future__ import annotations

import logging
import os
import time
import traceback
from abc import abstractmethod
from typing import Any, Dict, List, Optional

from rocketlib import AVI_ACTION, IInstanceBase

_logger = logging.getLogger('rocketride.flow')

# The engine spawns the python instance as a subprocess so stdlib
# logging and rocketlib.warning go to a console the user never sees.
# Write the debug trace to a fixed file path the user can `tail -f`.
_FLOW_DEBUG_LOG = '/tmp/ifelse-debug.log'


def _flow_log(level: str, fmt: str, *args: Any) -> None:
    """Append one debug line to /tmp/ifelse-debug.log."""
    try:
        msg = fmt % args if args else fmt
    except Exception:
        msg = fmt + ' ' + repr(args)
    try:
        with open(_FLOW_DEBUG_LOG, 'a', buffering=1) as fh:
            fh.write(f'{time.strftime("%H:%M:%S")} pid={os.getpid()} '
                     f'{level.upper()}: {msg}\n')
    except Exception:
        pass


def _flow_log_exc(fmt: str, *args: Any) -> None:
    """Append a stack-traced error line."""
    try:
        msg = fmt % args if args else fmt
    except Exception:
        msg = fmt + ' ' + repr(args)
    try:
        with open(_FLOW_DEBUG_LOG, 'a', buffering=1) as fh:
            fh.write(f'{time.strftime("%H:%M:%S")} pid={os.getpid()} '
                     f'ERROR: {msg}\n')
            fh.write(traceback.format_exc())
    except Exception:
        pass


class FlowBaseIInstance(IInstanceBase):
    """Abstract base for two-branch conditional routers.

    Subclasses must:

    1. Override ``checkCondition(condition: str, **kwargs) -> bool``.
       Receives the configured condition string and the active lane's
       payload as kwargs (e.g. ``text='...'`` for writeText). Returns
       True to route to THEN, False to route to ELSE.

    2. Populate ``self.condition`` and ``self.branches`` from their own
       ``IGlobal`` config (typically in ``beginInstance`` or by reading
       ``self.IGlobal.*`` lazily on first chunk).

    The class assumes ``self.IGlobal`` has:

    - ``condition: str`` — the condition expression / question / criterion.
    - ``branches: Dict[str, List[str]]`` — ``{'then': [...], 'else': [...]}``
      with downstream node IDs.
    """

    # ------------------------------------------------------------------
    # Hook the subclass implements
    # ------------------------------------------------------------------

    @abstractmethod
    def checkCondition(self, condition: str, **kwargs: Any) -> bool:
        """Evaluate the routing decision.

        Args:
            condition: The configured condition string.
            **kwargs: The active lane's payload bound by lane name
                (e.g. ``text='...'`` for writeText invocations).

        Returns:
            True → THEN branch. False (and any exception caught
            internally) → ELSE branch (fail-closed).
        """
        raise NotImplementedError

    # ------------------------------------------------------------------
    # Routing primitive — used by every writeXxx override
    # ------------------------------------------------------------------

    def _node_id(self) -> str:
        node_id = getattr(self.instance, 'pipeType', None)
        return getattr(node_id, 'id', '') if node_id else ''

    def _resolve_targets(self, decision: bool) -> List[str]:
        branches: Dict[str, List[str]] = getattr(self.IGlobal, 'branches', {}) or {}
        return list(branches.get('then' if decision else 'else', []))

    def _route(self, lane: str, decision: bool, **write_kwargs: Any) -> None:
        """Dispatch a chunk to every node listed in the chosen branch's targets.

        Resolves each target node id to its peer ``IServiceFilterInstance*``
        via ``self.instance.getInstance(target_id)`` and hands the chunk
        to that peer through ``peer.acceptXxx(...)`` — which in C++
        invokes ``peer->writeXxx(...)`` virtual so the pybind11
        trampoline lands in the target node's own Python ``writeXxx``
        override (NOT in peer's downstream binder).
        """
        target_ids = self._resolve_targets(decision)
        node_id = self._node_id()
        branch_label = 'then' if decision else 'else'
        branches_dump: Dict[str, List[str]] = getattr(self.IGlobal, 'branches', {}) or {}

        _flow_log('warn',
            '_route ENTER node=%s lane=%s decision=%s branch=%s '
            'branches_cfg=%r resolved_targets=%r',
            node_id, lane, decision, branch_label, branches_dump, target_ids,
        )

        if not target_ids:
            _flow_log('warn',
                '_route DROP node=%s lane=%s branch=%s reason=no_targets_in_branch',
                node_id, lane, branch_label,
            )
            return self.preventDefault()

        accept_method_name = 'accept' + lane[0].upper() + lane[1:]
        for target_id in target_ids:
            _flow_log('warn',
                '_route resolving peer node=%s target=%r',
                node_id, target_id,
            )
            try:
                peer = self.instance.getInstance(target_id)
            except Exception as exc:
                _flow_log_exc(
                    'getInstance(%r) RAISED %s: %s',
                    target_id, type(exc).__name__, exc,
                )
                continue

            if peer is None:
                _flow_log('error',
                    'getInstance(%r) returned None — target node not found in pipe stack',
                    target_id,
                )
                continue

            peer_attrs = sorted(a for a in dir(peer) if a.startswith(('accept', 'write')))
            _flow_log('warn',
                'peer resolved target=%r type=%s has_accept_method=%s methods=%r',
                target_id, type(peer).__name__,
                hasattr(peer, accept_method_name), peer_attrs,
            )

            method = getattr(peer, accept_method_name, None)
            if method is None:
                _flow_log('error',
                    'peer %s has no %s method (acceptXxx not exposed — '
                    'engine may need rebuild)',
                    target_id, accept_method_name,
                )
                continue

            # Pybind binds acceptXxx as positional-only (no py::arg names).
            # Pass values in insertion order — matches arg0 / arg0,arg1,arg2.
            args = tuple(write_kwargs.values())
            try:
                _flow_log('warn',
                    'invoking %s on peer=%s args_count=%d kwargs_keys=%r',
                    accept_method_name, target_id, len(args),
                    list(write_kwargs.keys()),
                )
                method(*args)
                _flow_log('warn',
                    '%s on peer=%s RETURNED OK',
                    accept_method_name, target_id,
                )
            except Exception as exc:
                _flow_log_exc(
                    '%s on peer=%s RAISED %s: %s',
                    accept_method_name, target_id, type(exc).__name__, exc,
                )

        self.preventDefault()

    # ------------------------------------------------------------------
    # Per-lane explicit overrides — text family (single-call)
    # ------------------------------------------------------------------

    def writeText(self, text: str) -> None:
        decision = self._safe_check(text=text)
        self._route('text', decision, text=text)

    def writeTable(self, table: str) -> None:
        decision = self._safe_check(table=table)
        self._route('table', decision, table=table)

    def writeQuestions(self, question: Any) -> None:
        decision = self._safe_check(questions=question)
        self._route('questions', decision, questions=question)

    def writeAnswers(self, answer: Any) -> None:
        decision = self._safe_check(answers=answer)
        self._route('answers', decision, answers=answer)

    def writeDocuments(self, documents: Any) -> None:
        decision = self._safe_check(documents=documents)
        self._route('documents', decision, documents=documents)

    def writeClassifications(
        self,
        classifications: Any,
        classificationPolicy: Any,
        classificationRules: Any,
    ) -> None:
        decision = self._safe_check(classifications=classifications)
        target_ids = self._resolve_targets(decision)
        node_id = self._node_id()
        if not target_ids:
            return self.preventDefault()
        for target_id in target_ids:
            peer = self.instance.getInstance(target_id)
            if peer is None:
                _flow_log('error',
                    'flow node=%s lane=classifications — getInstance(%r) returned None',
                    node_id, target_id,
                )
                continue
            peer.acceptClassifications(
                classifications,
                classificationPolicy,
                classificationRules,
            )
        self.preventDefault()

    # ------------------------------------------------------------------
    # Streaming lanes (image / audio / video) — buffered until END
    # ------------------------------------------------------------------

    def writeImage(self, action: int, mimeType: str, buffer: bytes) -> None:
        self._stream_handler('image', action, mimeType, buffer)

    def writeAudio(self, action: int, mimeType: str, buffer: bytes) -> None:
        self._stream_handler('audio', action, mimeType, buffer)

    def writeVideo(self, action: int, mimeType: str, buffer: bytes) -> None:
        self._stream_handler('video', action, mimeType, buffer)

    def _stream_handler(
        self,
        lane: str,
        action: int,
        mimeType: str,
        buffer: bytes,
    ) -> None:
        """Buffer BEGIN/WRITE/END for image/audio/video and route on END.

        Accumulates the streaming chunks in a per-lane state attribute
        until END, then evaluates the condition with the complete payload
        and replays the BEGIN/WRITE/END sequence against the chosen
        branch's targets. Each replay is a peer-direct dispatch — no
        binder state, no fan-out.
        """
        state_attr = f'_stream_state_{lane}'
        state: Optional[Dict[str, Any]] = getattr(self, state_attr, None)

        if state is None or action == AVI_ACTION.BEGIN:
            state = {
                'buffer': bytearray(),
                'mime_type': mimeType,
                'calls': [],
            }
            setattr(self, state_attr, state)

        # Capture the call verbatim so we can replay it later.
        state['calls'].append((action, mimeType, buffer))
        state['mime_type'] = mimeType or state['mime_type']
        if isinstance(buffer, (bytes, bytearray)) and buffer:
            state['buffer'].extend(buffer)

        if action != AVI_ACTION.END:
            # Wait until END to make the routing decision with the
            # complete payload visible.
            return self.preventDefault()

        full_buffer = bytes(state['buffer'])
        decision = self._safe_check(**{lane: full_buffer, 'mimeType': state['mime_type'], 'action': action})

        target_ids = self._resolve_targets(decision)
        calls = state['calls']

        # Reset state before forwarding so re-entrant calls don't see stale
        # buffers.
        delattr(self, state_attr)

        node_id = self._node_id()
        branch_label = 'then' if decision else 'else'

        if not target_ids:
            _flow_log('warn',
                'stream node=%s lane=%s branch=%s targets=[] outcome=dropped',
                node_id, lane, branch_label,
            )
            return self.preventDefault()

        _flow_log('warn',
            'stream node=%s lane=%s branch=%s targets=%r outcome=forwarded',
            node_id, lane, branch_label, target_ids,
        )

        accept_method_name = 'accept' + lane[0].upper() + lane[1:]

        for target_id in target_ids:
            peer = self.instance.getInstance(target_id)
            if peer is None:
                _flow_log('error',
                    'stream node=%s lane=%s — getInstance(%r) returned None',
                    node_id, lane, target_id,
                )
                continue
            accept_method = getattr(peer, accept_method_name, None)
            if accept_method is None:
                _flow_log('error',
                    'stream node=%s lane=%s — peer %s has no %s method',
                    node_id, lane, target_id, accept_method_name,
                )
                continue
            try:
                for call_action, call_mime, call_buffer in calls:
                    accept_method(call_action, call_mime, call_buffer)
                _flow_log('warn',
                    'stream %s on peer=%s replayed %d calls OK',
                    accept_method_name, target_id, len(calls),
                )
            except Exception as exc:
                _flow_log_exc(
                    'stream %s on peer=%s RAISED %s: %s',
                    accept_method_name, target_id, type(exc).__name__, exc,
                )

        self.preventDefault()

    # ------------------------------------------------------------------
    # Helper — fail-closed wrapper around checkCondition
    # ------------------------------------------------------------------

    def _safe_check(self, **kwargs: Any) -> bool:
        """Call ``checkCondition`` with fail-closed-to-ELSE semantics.

        Any exception raised by the subclass's evaluator is caught and
        treated as a False (ELSE) decision so the pipeline doesn't break
        on a bad condition string or a transient failure.
        """
        condition = getattr(self.IGlobal, 'condition', '')
        kwargs_preview = {
            k: (f'<{type(v).__name__} len={len(v) if hasattr(v, "__len__") else "?"}>'
                if not isinstance(v, (int, float, bool)) else v)
            for k, v in kwargs.items()
        }
        _flow_log('warn',
            '_safe_check ENTER node=%s condition=%r kwargs=%r',
            self._node_id(), condition, kwargs_preview,
        )
        try:
            result = bool(self.checkCondition(condition, **kwargs))
            _flow_log('warn',
                '_safe_check RESULT node=%s decision=%s',
                self._node_id(), result,
            )
            return result
        except Exception as exc:
            _flow_log_exc(
                '_safe_check FAIL node=%s checkCondition raised %s: %s — '
                'failing closed to ELSE',
                self._node_id(), type(exc).__name__, exc,
            )
            return False


# Alias so subclasses can `from ..flow.base import IInstance` and use it as
# their parent class while keeping a distinct name for the flow base.
IInstance = FlowBaseIInstance
