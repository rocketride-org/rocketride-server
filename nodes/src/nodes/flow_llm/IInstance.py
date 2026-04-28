# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow.llm per-pipeline instance.

Concrete subclass of `flow.base.FlowBaseIInstance` whose `checkCondition`
delegates the routing decision to a wired LLM via the engine's control
plane. The condition is a natural-language yes/no question; the LLM
sees the active payload (text inline, image as data URL) plus the
question and is instructed to reply with one word: YES or NO.
"""

from __future__ import annotations

import base64
import logging
from typing import Any

from ..flow_base import FlowBaseIInstance
from .IGlobal import IGlobal

_logger = logging.getLogger('rocketride.flow')


_SYSTEM_INSTRUCTION = 'You are a routing classifier. Read the user-supplied content and answer the user-supplied question with EXACTLY one word: either YES or NO. No explanation, no punctuation, no hedging. If the question cannot be answered from the content, reply NO.'

_FORMAT_INSTRUCTION = '\n\nReply with EXACTLY one word: YES or NO.'


# Lane names that carry binary payloads (bytes) — the driver wraps these
# as data URLs so vision-capable LLMs can ingest them. The MIME type
# defaults below are sane fallbacks when the upstream lane provides one.
_BINARY_LANES = {'image', 'audio', 'video'}
_DEFAULT_MIME = {
    'image': 'image/png',
    'audio': 'audio/mpeg',
    'video': 'video/mp4',
}


class IInstance(FlowBaseIInstance):
    """Routing flow with LLM-evaluated yes/no condition."""

    IGlobal: IGlobal

    def checkCondition(self, condition: str, **kwargs: Any) -> bool:
        """Send the active lane payload + the configured question to the
        wired LLM and route based on its YES/NO answer.

        Failure modes (LLM raises, no LLM wired, malformed response)
        all return False (fail-closed to ELSE).
        """
        # Lazy imports so this module is loadable in pure-Python tests.
        from ai.common.schema import Question
        from rocketlib.types import IInvokeLLM

        if not isinstance(condition, str) or not condition.strip():
            return False

        # Resolve the wired LLM target. Exactly one is required.
        try:
            llm_nodes = self.instance.getControllerNodeIds('llm')
        except Exception as exc:
            _logger.error('flow.llm getControllerNodeIds failed: %s', exc)
            return False
        if not llm_nodes:
            _logger.error('flow.llm requires an LLM node connected on the "llm" invoke channel — none found')
            return False
        if len(llm_nodes) > 1:
            _logger.error(
                'flow.llm expects exactly one LLM connected; found %d: %r',
                len(llm_nodes),
                llm_nodes,
            )
            return False
        llm_node_id = llm_nodes[0]

        # Build the Question. Binary lanes get a data URL; text-family
        # lanes inline the content.
        question_obj = Question()
        for lane_name, value in kwargs.items():
            if lane_name in _BINARY_LANES and isinstance(value, (bytes, bytearray)):
                mime_type = kwargs.get('mimeType') or _DEFAULT_MIME.get(lane_name, 'application/octet-stream')
                b64 = base64.b64encode(bytes(value)).decode('utf-8')
                question_obj.addContext(f'data:{mime_type};base64,{b64}')
            elif lane_name in ('mimeType', 'action'):
                # Skip — these are streaming metadata, not content.
                continue
            elif value is not None:
                question_obj.addContext(str(value))

        question_obj.addQuestion(f'{_SYSTEM_INSTRUCTION}\n\nQuestion: {condition}{_FORMAT_INSTRUCTION}')

        # Invoke the LLM via the control plane.
        try:
            param = IInvokeLLM.Ask(question=question_obj)
            self.instance.invoke(param, component_id=llm_node_id)
        except Exception as exc:
            _logger.error('flow.llm invocation failed: %s', exc)
            return False

        text = self._extract_answer_text(param)
        decision = self._parse_yes_no(text)
        _logger.info(
            'flow.llm question=%r answer=%r decision=%s',
            condition,
            text[:200] if isinstance(text, str) else repr(text)[:200],
            'YES' if decision else 'NO',
        )
        return decision

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _extract_answer_text(self, param: Any) -> str:
        """Pull the answer text out of the invoke param.

        Different LLM nodes populate the answer in slightly different
        shapes. Try the common ones in order.
        """
        # Most common: param.answer is an Answer-like object with getText().
        answer = getattr(param, 'answer', None)
        if answer is not None:
            if hasattr(answer, 'getText'):
                try:
                    out = answer.getText()
                    if isinstance(out, str) and out.strip():
                        return out
                except Exception:
                    pass
            if isinstance(answer, str) and answer.strip():
                return answer
        # Fallback — output / text fields directly on param.
        for attr in ('output', 'text', 'response'):
            value = getattr(param, attr, None)
            if isinstance(value, str) and value.strip():
                return value
        return ''

    def _parse_yes_no(self, text: str) -> bool:
        """Return True iff the LLM's answer starts with YES.

        Case-insensitive, ignores leading/trailing whitespace, surrounding
        quotes, and trailing punctuation so responses like ``"Yes."`` or
        ``Yes!`` still resolve correctly.
        """
        if not isinstance(text, str):
            return False
        normalized = text.strip().upper().lstrip('"\'').rstrip('.,!?"\'')
        return normalized.startswith('YES')
