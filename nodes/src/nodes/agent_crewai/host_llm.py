# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
CrewAI LLM adapter that routes calls through Aparavi host services.

Important: this module must NOT import crewai at module import time.
We expose a factory function that lazily imports CrewAI types after
node dependencies are installed via IGlobal.beginGlobal().
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Union

from ai.common.schema import Question
from aparavi.types import IInvokeLLM


def _safe_str(v: Any) -> str:
    try:
        return '' if v is None else str(v)
    except Exception:
        return ''


def _extract_text(result: Any) -> str:
    """Best-effort extraction across engine response shapes."""
    try:
        if hasattr(result, 'getText') and callable(getattr(result, 'getText')):
            return (result.getText() or '').strip()  # type: ignore[attr-defined]
        if hasattr(result, 'getJson') and callable(getattr(result, 'getJson')):
            data = result.getJson()  # type: ignore[attr-defined]
            if isinstance(data, dict):
                for k in ('answer', 'content', 'text'):
                    if k in data and data[k] is not None:
                        return _safe_str(data[k]).strip()
            return _safe_str(data).strip()
        return _safe_str(result).strip()
    except Exception:
        return _safe_str(result).strip()


def make_host_llm(
    *,
    host: Any,
    model: str = 'aparavi-host-llm',
    temperature: Optional[float] = None,
    question_role: str = 'You are a helpful assistant.',
) -> Any:
    """
    Return a CrewAI BaseLLM instance backed by Aparavi host LLM invoke seam.

    - `host` is the AgentHostServices instance (host.llm.invoke is used).
    - Lazy imports CrewAI to keep module import safe before depends().
    """
    from crewai import BaseLLM  # type: ignore

    class HostInvokeLLM(BaseLLM):
        def __init__(self):
            super().__init__(model=model, temperature=temperature)

        def supports_function_calling(self) -> bool:
            return False

        def supports_stop_words(self) -> bool:
            return False

        def call(
            self,
            messages: Union[str, List[Dict[str, str]]],
            tools: Optional[List[dict]] = None,
            callbacks: Optional[List[Any]] = None,
            available_functions: Optional[Dict[str, Any]] = None,
            **kwargs: Any,
        ) -> Union[str, Any]:
            # Normalize into a single prompt transcript.
            if isinstance(messages, str):
                transcript = messages
            else:
                parts: List[str] = []
                for m in messages:
                    if not isinstance(m, dict):
                        continue
                    role = _safe_str(m.get('role') or 'user')
                    content = _safe_str(m.get('content') or '')
                    if content:
                        parts.append(f'{role}: {content}')
                transcript = '\n'.join(parts)

            q = Question(role=question_role)
            q.addQuestion(transcript)
            result = host.llm.invoke(IInvokeLLM(op='ask', question=q))
            text = _extract_text(result)

            # Manual stop-word truncation if needed (CrewAI may set BaseLLM.stop).
            stop_words = getattr(self, 'stop', None)
            if isinstance(stop_words, list) and text:
                for sw in stop_words:
                    ssw = _safe_str(sw)
                    if ssw and ssw in text:
                        text = text.split(ssw)[0]
                        break

            return text

    return HostInvokeLLM()

