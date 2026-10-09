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
"""Ask every configured question about one item (one state) in a single System One call."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

from .client import SystemOneError
from .limits import (
    QUESTION_CHARS_PER_TOKEN,
    REQUEST_OVERHEAD_TOKENS,
    DecisionLimits,
    encode_json,
    estimate_tokens,
    json_bytes,
)
from .questions import ProtocolError, QuestionSpec, build_wire_questions, describe_questions, map_answer


@dataclass
class Outcome:
    """Result of one item: ``answers`` when decided, ``size`` when the input is too long for the model."""

    answers: dict | None = None
    usage: dict | None = None
    size: dict | None = None


class DecisionRunner:
    """Turns one state into answers with one backend call; never sends part of an input."""

    def __init__(
        self,
        client,
        model: str,
        specs: list[QuestionSpec],
        limits: DecisionLimits,
        *,
        state_metadata: tuple[str, ...] = (),
        debug: Callable[[str], None] = lambda _m: None,
    ):
        """Create a runner; ``client`` needs only ``decide(model, state, questions)``."""
        self._client = client
        self.model = model
        self.specs = specs
        self.questions = describe_questions(specs)
        self._limits = limits
        self._state_metadata = tuple(state_metadata)
        self._debug = debug
        self._wire = build_wire_questions(specs, limits)
        longest = max(len(str(q)) for q in self._wire.values())
        self._reserved_tokens = REQUEST_OVERHEAD_TOKENS + estimate_tokens('x' * longest, QUESTION_CHARS_PER_TOKEN)
        self._questions_bytes = json_bytes(self._wire) + json_bytes(model) + 64

    def state(self, content: str, metadata: dict | None = None):
        """Return the state for one document: the text, plus the configured metadata keys when present."""
        metadata = metadata or {}
        extras = {key: metadata[key] for key in self._state_metadata if metadata.get(key) is not None}
        return {'content': content, **extras} if extras else content

    def _tokens(self, state) -> int:
        text = state if isinstance(state, str) else encode_json(state).decode('utf-8')
        return self._reserved_tokens + estimate_tokens(text, self._limits.chars_per_token)

    def oversize(self, state) -> dict | None:
        """Return the measured size when ``state`` is over this backend's limits, else None."""
        tokens = self._tokens(state)
        if tokens > self._limits.max_state_tokens:
            return {'tokens': tokens, 'limit': self._limits.max_state_tokens}
        if self._limits.max_body_bytes is not None:
            body = self._questions_bytes + json_bytes(state)
            if body > self._limits.max_body_bytes:
                return {'bytes': body, 'limit': self._limits.max_body_bytes}
        return None

    def fit_question(self, state: dict) -> tuple[dict, dict | None]:
        """Drop history oldest-first, then documents last-first, until the question state fits (spec §4.2)."""
        size = self.oversize(state)
        if size is None:
            return state, None
        fitted = {**state, 'history': list(state['history']), 'documents': list(state['documents'])}
        while self.oversize(fitted) is not None:
            if fitted['history']:
                fitted['history'].pop(0)
            elif fitted['documents']:
                fitted['documents'].pop()
            else:
                raise ValueError(
                    f'the question does not fit the model limit ({size["limit"]}) even without history and documents'
                )
        return fitted, size

    def decide(self, state, *, source: str) -> Outcome:
        """Ask all questions about one state; a too-long state comes back as ``Outcome(size=...)``."""
        size = self.oversize(state)
        if size is not None:
            return Outcome(size=size)
        start_time = time.monotonic()
        try:
            reply = self._client.decide(self.model, state, self._wire)
        except SystemOneError as exc:
            # The backend body may echo the input, so it never goes above debug.
            if exc.body:
                self._debug(f'{source}: backend error body: {exc.body}')
            if exc.kind == 'too_large':
                return Outcome(
                    size={
                        'tokens': self._tokens(state),
                        'limit': self._limits.max_state_tokens,
                        'rejected_by': 'backend',
                    }
                )
            raise
        latency_ms = (time.monotonic() - start_time) * 1000
        if not isinstance(reply, dict) or not isinstance(reply.get('answers'), dict):
            raise ProtocolError(f'{source}: backend reply is not an object with an "answers" object')
        answers = {}
        for spec in self.specs:
            if spec.name not in reply['answers']:
                raise ProtocolError(f'{source}: {spec.name}: backend returned no answer')
            try:
                answers[spec.name] = map_answer(spec, reply['answers'][spec.name])
            except ProtocolError as exc:
                raise ProtocolError(f'{source}: {exc}') from exc
        raw_usage = reply.get('usage') if isinstance(reply.get('usage'), dict) else {}
        usage = {'calls': 1}
        for key in ('input_tokens', 'output_tokens'):
            value = raw_usage.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                usage[key] = value
        debug_line = (
            f'{source}: System One model={reply.get("model")} questions={len(self.specs)} '
            f'input_tokens={usage.get("input_tokens")} latency={latency_ms:.0f}ms'
        )
        request_id = getattr(self._client, 'last_request_id', None)
        if request_id:
            debug_line += f' request_id={request_id}'
        self._debug(debug_line)
        return Outcome(answers=answers, usage=usage)
