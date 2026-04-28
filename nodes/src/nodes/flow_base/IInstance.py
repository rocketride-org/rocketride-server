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
- Branch dispatch via the per-call `targetNodeId` argument that the
  engine's Binder accepts on every writeXxx — no state on the binder,
  no magic mixin.

Concrete subclasses implement only ``checkCondition(condition, **kwargs)``.
The lane handlers, the streaming buffer, the branch routing — all live
here so the only difference between a Python-eval flow and an
LLM-evaluated flow is the condition evaluation strategy.
"""

from __future__ import annotations

import logging
from abc import abstractmethod
from typing import Any, Dict, List, Optional

from rocketlib import AVI_ACTION, IInstanceBase

_logger = logging.getLogger('rocketride.flow')


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

    def _route(self, lane: str, decision: bool, **write_kwargs: Any) -> None:
        """Dispatch a chunk to every node listed in the chosen branch's targets.

        Looks up ``self.IGlobal.branches['then' if decision else 'else']``
        and forwards via the engine's per-call ``targetNodeId`` argument
        on the matching ``writeXxx`` of the engine instance. The binder
        then delivers only to the listener whose ``pipeType.id`` matches —
        no broadcast, no state.

        ``write_kwargs`` is passed verbatim through to the engine's
        ``writeXxx``; lifecycle args like ``action`` and ``mimeType`` are
        included for streaming lanes so the downstream sees the same
        BEGIN/WRITE/END sequence it would receive without the gate.
        """
        branches: Dict[str, List[str]] = getattr(self.IGlobal, 'branches', {}) or {}
        target_ids = list(branches.get('then' if decision else 'else', []))

        node_id = getattr(self.instance, 'pipeType', None)
        node_id = getattr(node_id, 'id', '') if node_id else ''

        if not target_ids:
            # Branch has no wires — drop the chunk silently. Mirror the
            # engine's default by raising preventDefault so the binder
            # also doesn't broadcast on its own.
            _logger.info(
                'flow node=%s lane=%s branch=%s targets=[] outcome=dropped',
                node_id,
                lane,
                'then' if decision else 'else',
            )
            return self.preventDefault()

        _logger.info(
            'flow node=%s lane=%s branch=%s targets=%r outcome=forwarded',
            node_id,
            lane,
            'then' if decision else 'else',
            target_ids,
        )

        write_method_name = 'write' + lane[0].upper() + lane[1:]
        for target_id in target_ids:
            method = getattr(self.instance, write_method_name, None)
            if method is None:
                _logger.error(
                    'flow node=%s lane=%s — engine instance has no %s method',
                    node_id,
                    lane,
                    write_method_name,
                )
                continue
            method(*([] if not write_kwargs else []), targetNodeId=target_id, **write_kwargs)

        # Block the engine's default fan-out — we already delivered to
        # the chosen targets explicitly.
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
        # Classifications has 3 args at the engine level — forward all of
        # them so the downstream sees the same call shape.
        branches: Dict[str, List[str]] = getattr(self.IGlobal, 'branches', {}) or {}
        target_ids = list(branches.get('then' if decision else 'else', []))
        if not target_ids:
            return self.preventDefault()
        for target_id in target_ids:
            self.instance.writeClassifications(
                classifications,
                classificationPolicy,
                classificationRules,
                targetNodeId=target_id,
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
        branch's targets. Each replay is a per-call `targetNodeId`
        dispatch — no binder state, no fan-out.
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

        branches: Dict[str, List[str]] = getattr(self.IGlobal, 'branches', {}) or {}
        target_ids = list(branches.get('then' if decision else 'else', []))

        # Reset state before forwarding so re-entrant calls don't see stale
        # buffers.
        delattr(self, state_attr)

        node_id = getattr(self.instance, 'pipeType', None)
        node_id = getattr(node_id, 'id', '') if node_id else ''

        if not target_ids:
            _logger.info(
                'flow node=%s lane=%s branch=%s targets=[] outcome=dropped',
                node_id,
                lane,
                'then' if decision else 'else',
            )
            return self.preventDefault()

        _logger.info(
            'flow node=%s lane=%s branch=%s targets=%r outcome=forwarded',
            node_id,
            lane,
            'then' if decision else 'else',
            target_ids,
        )

        write_method_name = 'write' + lane[0].upper() + lane[1:]
        write_method = getattr(self.instance, write_method_name)

        for target_id in target_ids:
            for call_action, call_mime, call_buffer in state['calls']:
                write_method(
                    call_action,
                    call_mime,
                    call_buffer,
                    targetNodeId=target_id,
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
        try:
            return bool(self.checkCondition(condition, **kwargs))
        except Exception as exc:
            node_id = getattr(self.instance, 'pipeType', None)
            node_id = getattr(node_id, 'id', '') if node_id else ''
            _logger.error(
                'flow node=%s checkCondition raised %s: %s — failing closed to ELSE',
                node_id,
                type(exc).__name__,
                exc,
            )
            return False


# Alias so subclasses can `from ..flow.base import IInstance` and use it as
# their parent class while keeping a distinct name for the flow base.
IInstance = FlowBaseIInstance
