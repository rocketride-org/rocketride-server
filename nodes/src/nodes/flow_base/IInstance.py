# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Abstract base for `flow_*` conditional routers.

Subclasses implement `checkCondition`; lane handlers, AVI streaming
buffer, and peer-direct branch dispatch live here.
"""

from __future__ import annotations

from abc import abstractmethod
from typing import Any, Dict, List, Optional

from rocketlib import AVI_ACTION, IInstanceBase, error, warning


class FlowBaseIInstance(IInstanceBase):
    """Abstract base for two-branch conditional routers.

    Subclasses override ``checkCondition(condition, **kwargs) -> bool``
    (True → THEN, False → ELSE). ``self.IGlobal`` must expose
    ``condition: str`` and ``branches: {'then': [...], 'else': [...]}``.
    """

    @abstractmethod
    def checkCondition(self, condition: str, **kwargs: Any) -> bool:
        """Return True for THEN branch, False for ELSE. Exceptions in the
        caller's `_safe_check` wrapper are treated as False (fail-closed).
        """
        raise NotImplementedError

    def _node_id(self) -> str:
        node_id = getattr(self.instance, 'pipeType', None)
        return getattr(node_id, 'id', '') if node_id else ''

    def _resolve_targets(self, decision: bool) -> List[str]:
        branches: Dict[str, List[str]] = getattr(self.IGlobal, 'branches', {}) or {}
        return list(branches.get('then' if decision else 'else', []))

    def _route(self, lane: str, decision: bool, **write_kwargs: Any) -> None:
        """Peer-direct dispatch to each node in the chosen branch via
        ``peer.acceptXxx(...)``, which fires the target's writeXxx
        trampoline (not the binder broadcast).
        """
        target_ids = self._resolve_targets(decision)
        if not target_ids:
            return self.preventDefault()

        accept_method_name = 'accept' + lane[0].upper() + lane[1:]
        for target_id in target_ids:
            try:
                peer = self.instance.getInstance(target_id)
            except Exception as e:
                error(f'flow: getInstance({target_id!r}) raised: {e}')
                continue

            if peer is None:
                warning(f'flow: target {target_id!r} not found in pipe stack')
                continue

            method = getattr(peer, accept_method_name, None)
            if method is None:
                warning(f'flow: peer {target_id} has no {accept_method_name} method')
                continue

            # Pybind binds acceptXxx as positional-only; pass in insertion order.
            args = tuple(write_kwargs.values())
            try:
                method(*args)
            except Exception as e:
                error(f'flow: {accept_method_name} on peer={target_id} raised: {e}')

        self.preventDefault()

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
        if not target_ids:
            return self.preventDefault()
        for target_id in target_ids:
            try:  # fail-closed per target, like _route
                peer = self.instance.getInstance(target_id)
                if peer is None:
                    warning(f'flow: classifications target {target_id!r} not found')
                    continue
                peer.acceptClassifications(
                    classifications,
                    classificationPolicy,
                    classificationRules,
                )
            except Exception as e:
                error(f'flow: classifications dispatch to {target_id!r} raised: {e}')
        self.preventDefault()

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
        """Buffer BEGIN/WRITE/END for image/audio/video; on END, evaluate the
        condition with the complete payload and replay the call sequence to
        the chosen branch's targets.
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

        state['calls'].append((action, mimeType, buffer))
        state['mime_type'] = mimeType or state['mime_type']
        if isinstance(buffer, (bytes, bytearray)) and buffer:
            state['buffer'].extend(buffer)

        if action != AVI_ACTION.END:
            return self.preventDefault()

        full_buffer = bytes(state['buffer'])
        decision = self._safe_check(**{lane: full_buffer, 'mimeType': state['mime_type'], 'action': action})

        target_ids = self._resolve_targets(decision)
        calls = state['calls']
        delattr(self, state_attr)

        if not target_ids:
            return self.preventDefault()

        accept_method_name = 'accept' + lane[0].upper() + lane[1:]

        for target_id in target_ids:
            peer = self.instance.getInstance(target_id)
            if peer is None:
                warning(f'flow: stream {lane}: target {target_id!r} not found')
                continue
            accept_method = getattr(peer, accept_method_name, None)
            if accept_method is None:
                warning(f'flow: stream {lane}: peer {target_id} has no {accept_method_name} method')
                continue
            try:
                for call_action, call_mime, call_buffer in calls:
                    accept_method(call_action, call_mime, call_buffer)
            except Exception as e:
                error(f'flow: stream {accept_method_name} on peer={target_id} raised: {e}')

        self.preventDefault()

    def _safe_check(self, **kwargs: Any) -> bool:
        """Wrap ``checkCondition`` with fail-closed-to-ELSE semantics."""
        condition = getattr(self.IGlobal, 'condition', '')
        try:
            return bool(self.checkCondition(condition, **kwargs))
        except Exception as e:
            error(f'flow: checkCondition raised — failing closed to ELSE: {e}')
            return False


IInstance = FlowBaseIInstance
