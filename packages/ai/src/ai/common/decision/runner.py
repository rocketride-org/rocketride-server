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
"""Ask every configured question about one document in a single System One call."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

from .client import SystemOneError
from .limits import (
    QUESTION_CHARS_PER_TOKEN,
    REQUEST_OVERHEAD_TOKENS,
    DecisionLimits,
    estimate_tokens,
    fit_content,
    json_bytes,
    shrink,
)
from .questions import ProtocolError, QuestionSpec, build_wire_questions, error_decision, map_answer

# Configuration error kinds that always fail regardless of on_error mode.
CONFIG_ERROR_KINDS = frozenset({'auth', 'not_found'})


@dataclass
class DecisionResult:
    """Outcome of asking one document's questions."""

    decisions: dict
    usage: dict | None
    truncated: bool
    skipped: bool = False


class DecisionRunner:
    """Turns documents into decisions with one backend call each."""

    def __init__(
        self,
        client,
        model: str,
        specs: list[QuestionSpec],
        limits: DecisionLimits,
        *,
        state_metadata: tuple[str, ...] = (),
        on_error: str = 'fail',
        warn: Callable[[str], None] = print,
        debug: Callable[[str], None] = lambda _m: None,
    ):
        """Create a runner; ``client`` needs only ``decide(model, state, questions)``."""
        if on_error not in ('fail', 'pass_through'):
            raise ValueError(f'on_error must be "fail" or "pass_through", got {on_error!r}')
        self._client = client
        self._model = model
        self._specs = specs
        self._limits = limits
        self._state_metadata = tuple(state_metadata)
        self._on_error = on_error
        self._warn = warn
        self._debug = debug
        self._wire = build_wire_questions(specs, limits)
        longest = max(len(str(q)) for q in self._wire.values())
        self._reserved_tokens = REQUEST_OVERHEAD_TOKENS + estimate_tokens('x' * longest, QUESTION_CHARS_PER_TOKEN)
        self._questions_bytes = json_bytes(self._wire) + json_bytes(model) + 64

    def _extras(self, metadata: dict | None) -> dict:
        metadata = metadata or {}
        return {key: metadata[key] for key in self._state_metadata if metadata.get(key) is not None}

    def _state(self, content: str, extras: dict):
        return {'content': content, **extras} if extras else content

    def _ask(self, content: str, extras: dict):
        return self._client.decide(self._model, self._state(content, extras), self._wire)

    def decide(self, content: str | None, metadata: dict | None, *, source: str) -> DecisionResult:
        """Ask all questions about one document; never mutates its inputs."""
        if not content or not content.strip():
            self._warn(f'{source}: document has empty content; no decisions made')
            return DecisionResult({}, None, False, skipped=True)
        extras = self._extras(metadata)
        reserved_tokens = self._reserved_tokens + estimate_tokens(str(extras), self._limits.chars_per_token)
        reserved_bytes = self._questions_bytes + json_bytes(extras)
        kept, truncated = fit_content(content, self._limits, reserved_tokens, reserved_bytes)
        if truncated:
            self._warn(
                f'{source}: input truncated for the model from {len(content)} to {len(kept)} characters '
                f'(backend limit {self._limits.max_state_tokens} tokens); downstream still gets the full document'
            )
        try:
            try:
                start_time = time.monotonic()
                reply = self._ask(kept, extras)
                latency_ms = (time.monotonic() - start_time) * 1000
            except SystemOneError as exc:
                if exc.kind != 'too_large':
                    raise
                kept, truncated = shrink(kept), True
                self._warn(f'{source}: backend rejected the input as too large; retrying with {len(kept)} characters')
                start_time = time.monotonic()
                reply = self._ask(kept, extras)
                latency_ms = (time.monotonic() - start_time) * 1000
            answers = reply.get('answers') or {}
            decisions = {}
            for spec in self._specs:
                if spec.name not in answers:
                    raise ProtocolError(f'{spec.name}: backend returned no answer')
                decisions[spec.name] = map_answer(spec, answers[spec.name], model=reply.get('model'), source=source)
            # R3 & R11: Log debug info with request_id if available
            debug_line = (
                f'{source}: System One model={reply.get("model")} questions={len(self._specs)} '
                f'input_tokens={(reply.get("usage") or {}).get("input_tokens")} latency={latency_ms:.0f}ms'
            )
            request_id = getattr(self._client, 'last_request_id', None)
            if request_id:
                debug_line += f' request_id={request_id}'
            self._debug(debug_line)
            return DecisionResult(decisions, reply.get('usage'), truncated)
        except (SystemOneError, ProtocolError) as exc:
            error = exc if isinstance(exc, SystemOneError) else SystemOneError('protocol', str(exc))
            # R13: Configuration errors always fail regardless of on_error mode
            if isinstance(error, SystemOneError) and error.kind in CONFIG_ERROR_KINDS:
                raise error
            if self._on_error == 'fail':
                if error is exc:
                    raise
                raise error from exc
            # R3 & R11: Include request_id in warning if available when handling errors
            warn_msg = f'{source}: decision call failed ({error.kind}): {error}; passing document through'
            if isinstance(error, SystemOneError) and error.request_id:
                warn_msg += f' request_id={error.request_id}'
            self._warn(warn_msg)
            return DecisionResult(
                {s.name: error_decision(s, str(error), source=source) for s in self._specs}, None, truncated
            )


def merge_decisions(existing: dict | None, new: dict, *, warn: Callable[[str], None]) -> dict:
    """Merge ``new`` into a copy of ``existing``; warn when a name is overwritten."""
    merged = dict(existing or {})
    for name, decision in new.items():
        if name in merged:
            previous = (merged[name] or {}).get('source', 'an earlier node')
            warn(f'decisions.{name} written by {previous} is overwritten by {decision.get("source")}')
        merged[name] = decision
    return merged
