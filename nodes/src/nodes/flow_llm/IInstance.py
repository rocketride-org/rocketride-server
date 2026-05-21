# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""flow.llm per-pipeline instance.

`checkCondition` delegates to a wired LLM via the engine's control plane.
The condition is a natural-language yes/no question; the LLM sees the
active payload plus the question and replies YES or NO.
"""

from __future__ import annotations

import base64
import re
from typing import Any

from rocketlib import error

from ..flow_base import FlowBaseIInstance
from .IGlobal import IGlobal


_SYSTEM_INSTRUCTION = 'You are a routing classifier. Read the user-supplied content and answer the user-supplied question with EXACTLY one word: either YES or NO. No explanation, no punctuation, no hedging. If the question cannot be answered from the content, reply NO.'

_FORMAT_INSTRUCTION = '\n\nReply with EXACTLY one word: YES or NO.'


# Binary lanes wrapped as data URLs for vision-capable LLMs.
_BINARY_LANES = {'image', 'audio', 'video'}
_DEFAULT_MIME = {
    'image': 'image/png',
    'audio': 'audio/mpeg',
    'video': 'video/mp4',
}

# Lanes that require a vision-capable LLM (audio/video go through 'llm' after STT/frame-grab).
_VISION_LANES = {'image'}

# Tokens accepted as YES/NO — tolerates prompt-driven drift (sí/no, true/false, 1/0).
_POSITIVE_TOKENS = frozenset({'YES', 'TRUE', 'SI', 'SÍ', 'Y', '1'})
_NEGATIVE_TOKENS = frozenset({'NO', 'FALSE', 'N', '0'})
_WORD_RE = re.compile(r'\w+', re.UNICODE)


def _select_invoke_channel(kwargs: dict) -> str:
    """Image bytes → 'vision' channel, everything else → 'llm'."""
    for lane_name in _VISION_LANES:
        value = kwargs.get(lane_name)
        if isinstance(value, (bytes, bytearray)) and value:
            return 'vision'
    return 'llm'


class IInstance(FlowBaseIInstance):
    """Routing flow with LLM-evaluated yes/no condition."""

    IGlobal: IGlobal

    def checkCondition(self, condition: str, **kwargs: Any) -> bool:
        """Ask the wired LLM the configured question against the active payload.
        Returns False on any failure (no LLM wired, invoke raises, malformed reply).
        """
        # Lazy imports so this module is loadable in pure-Python tests.
        from ai.common.schema import Question
        from rocketlib.types import IInvokeLLM

        if not isinstance(condition, str) or not condition.strip():
            return False

        invoke_channel = _select_invoke_channel(kwargs)

        try:
            llm_nodes = self.instance.getControllerNodeIds(invoke_channel)
        except Exception as e:
            error(f'flow.llm: getControllerNodeIds({invoke_channel!r}) raised: {e}')
            return False
        if not llm_nodes:
            error(f'flow.llm: no LLM wired on channel {invoke_channel!r}')
            return False
        if len(llm_nodes) > 1:
            error(f'flow.llm: expected one LLM on {invoke_channel!r}, found {len(llm_nodes)}')
            return False
        llm_node_id = llm_nodes[0]

        question_obj = Question()
        for lane_name, value in kwargs.items():
            if lane_name in _BINARY_LANES and isinstance(value, (bytes, bytearray)):
                mime_type = kwargs.get('mimeType') or _DEFAULT_MIME.get(lane_name, 'application/octet-stream')
                b64 = base64.b64encode(bytes(value)).decode('utf-8')
                question_obj.addContext(f'data:{mime_type};base64,{b64}')
            elif lane_name in ('mimeType', 'action'):
                continue
            elif value is not None:
                question_obj.addContext(str(value))

        question_obj.addQuestion(f'{_SYSTEM_INSTRUCTION}\n\nQuestion: {condition}{_FORMAT_INSTRUCTION}')

        # Override `lane` so the engine routes through the channel we resolved
        # (IInvokeLLM.Ask defaults to 'llm', wrong when we picked 'vision').
        try:
            param = IInvokeLLM.Ask(question=question_obj, lane=invoke_channel)
            invoke_result = self.instance.invoke(param, component_id=llm_node_id)
        except Exception as e:
            error(f'flow.llm: invocation failed: {e}')
            return False

        text = self._extract_answer_text(invoke_result)
        return self._parse_yes_no(text)

    def _extract_answer_text(self, result: Any) -> str:
        """Pull answer text out of whatever invoke() returned (Answer, str, wrapper)."""
        if result is None:
            return ''
        if hasattr(result, 'getText'):
            try:
                out = result.getText()
                if isinstance(out, str) and out.strip():
                    return out
            except Exception:
                pass
        if isinstance(result, str) and result.strip():
            return result
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
        for attr in ('output', 'text', 'response'):
            value = getattr(result, attr, None)
            if isinstance(value, str) and value.strip():
                return value
        return ''

    def _parse_yes_no(self, text: str) -> bool:
        """First YES/TRUE/SI/SÍ/Y/1 → True; first NO/FALSE/N/0 → False; else False."""
        if not isinstance(text, str):
            return False
        for match in _WORD_RE.finditer(text.upper()):
            word = match.group(0)
            if word in _POSITIVE_TOKENS:
                return True
            if word in _NEGATIVE_TOKENS:
                return False
        return False
