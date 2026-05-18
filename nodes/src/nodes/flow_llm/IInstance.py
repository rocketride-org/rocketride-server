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
import re
from typing import Any

from ..flow_base import FlowBaseIInstance
from ..flow_base.IInstance import _flow_log, _flow_log_exc
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

# Lanes that require a vision-capable LLM. Audio/video need upstream
# preprocessing (STT, frame grabber) before reaching flow.llm and are
# evaluated through the text 'llm' channel.
_VISION_LANES = {'image'}

# Tokens accepted as a positive routing decision. flow.llm asks the LLM
# for YES/NO, but the wired node may have a user-configured systemPrompt
# that nudges it toward "true/false", "sí/no", "1/0", etc. The router
# accepts these variants so the decision survives reasonable provider
# replies and prompt drift.
_POSITIVE_TOKENS = frozenset({'YES', 'TRUE', 'SI', 'SÍ', 'Y', '1'})
_NEGATIVE_TOKENS = frozenset({'NO', 'FALSE', 'N', '0'})
_WORD_RE = re.compile(r'\w+', re.UNICODE)


def _select_invoke_channel(kwargs: dict) -> str:
    """Pick the invoke channel based on the active lane payload.

    Image bytes go through the 'vision' channel (vision-capable LLMs).
    Everything else routes through the text 'llm' channel.
    """
    for lane_name in _VISION_LANES:
        value = kwargs.get(lane_name)
        if isinstance(value, (bytes, bytearray)) and value:
            return 'vision'
    return 'llm'


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

        # Pick the invoke channel based on the active lane payload: image
        # bytes go through 'vision', everything else through 'llm'.
        invoke_channel = _select_invoke_channel(kwargs)
        _flow_log(
            'warn',
            'flow.llm checkCondition ENTER channel=%r kwargs_keys=%r',
            invoke_channel,
            list(kwargs.keys()),
        )

        # Resolve the wired LLM target on that channel. Exactly one is required.
        try:
            llm_nodes = self.instance.getControllerNodeIds(invoke_channel)
        except Exception as exc:
            _flow_log_exc('flow.llm getControllerNodeIds(%r) raised: %s', invoke_channel, exc)
            return False
        _flow_log('warn', 'flow.llm controllers on %r = %r', invoke_channel, llm_nodes)
        if not llm_nodes:
            _flow_log(
                'error',
                'flow.llm NO LLM wired on channel %r — failing to ELSE',
                invoke_channel,
            )
            return False
        if len(llm_nodes) > 1:
            _flow_log(
                'error',
                'flow.llm expects exactly one LLM on %r; found %d: %r — failing to ELSE',
                invoke_channel,
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

        # Invoke the LLM via the control plane. Override `lane` so the
        # engine routes through the channel we actually picked — the
        # IInvokeLLM.Ask default ('llm') is wrong when we resolved the
        # target through the 'vision' channel.
        _flow_log(
            'warn',
            'flow.llm invoke target=%s lane=%r question_chars=%d context_items=%d',
            llm_node_id,
            invoke_channel,
            sum(len(q.text) for q in (question_obj.questions or [])),
            len(question_obj.context or []),
        )
        try:
            param = IInvokeLLM.Ask(question=question_obj, lane=invoke_channel)
            invoke_result = self.instance.invoke(param, component_id=llm_node_id)
        except Exception as exc:
            _flow_log_exc('flow.llm invocation failed: %s', exc)
            return False

        text = self._extract_answer_text(invoke_result)
        decision = self._parse_yes_no(text)
        _flow_log(
            'warn',
            'flow.llm DECISION channel=%r condition=%r answer=%r decision=%s',
            invoke_channel,
            condition,
            text[:300] if isinstance(text, str) else repr(text)[:300],
            'YES' if decision else 'NO',
        )
        return decision

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _extract_answer_text(self, result: Any) -> str:
        """Pull the answer text out of whatever ``self.instance.invoke()`` returned.

        Typical shape is an ``Answer`` object with ``getText()``. Falls back to
        plain strings and param-style wrappers exposing ``.answer`` / text
        fields so legacy callers keep working.
        """
        if result is None:
            return ''
        # Answer-like with getText()
        if hasattr(result, 'getText'):
            try:
                out = result.getText()
                if isinstance(out, str) and out.strip():
                    return out
            except Exception:
                pass
        # Bare string
        if isinstance(result, str) and result.strip():
            return result
        # Wrapper with .answer
        answer = getattr(result, 'answer', None)
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
        # Last resort: scan typical text-bearing attributes
        for attr in ('output', 'text', 'response'):
            value = getattr(result, attr, None)
            if isinstance(value, str) and value.strip():
                return value
        return ''

    def _parse_yes_no(self, text: str) -> bool:
        """Return True iff the answer reads as a positive routing decision.

        Scans the whole response for the first occurrence of a known
        positive or negative token (YES/TRUE/SI/SÍ/Y/1 vs NO/FALSE/N/0).
        Whichever appears first wins. This tolerates partially-obedient
        replies like ``"Yes, there is a dog."`` or ``"It's a dog. Yes."``.
        Fails closed (returns False) when neither token is found.
        """
        if not isinstance(text, str):
            return False
        for match in _WORD_RE.finditer(text.upper()):
            word = match.group(0)
            if word in _POSITIVE_TOKENS:
                return True
            if word in _NEGATIVE_TOKENS:
                return False
        return False
