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

"""
Conditional routing node.

Catalog: ``conditional_text``, ``conditional_questions``, and ``conditional_answers``
(one input lane each). Evaluates a sandboxed Python expression and routes to
``then`` (true) or ``else`` (false).

Chunks for a single object are buffered until ``close`` and the condition
is evaluated once over the full accumulated payload, so an object is never
split across both branches (e.g. text arriving as two chunks still matches
a phrase that spans the chunk boundary).
"""

from __future__ import annotations

from typing import Any, List

from rocketlib import Entry, IInstanceBase, debug

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def open(self, object: Entry):
        """Reset per-object buffers. Called once at the start of each object."""
        self._text_chunks: List[str] = []
        self._questions: List[Any] = []
        self._answers: List[Any] = []

    def writeText(self, text: str):
        # Do not forward yet — the branch decision must be made over the full
        # object payload, not per chunk.
        self._text_chunks.append(text)

    def writeQuestions(self, questions):
        self._questions.append(questions)

    def writeAnswers(self, answers):
        self._answers.append(answers)

    def close(self):
        """
        Evaluate the condition once over the full accumulated payload, then
        flush buffered chunks to the selected branch. Only one of the three
        lane buffers is populated in practice (each ``conditional_*`` service
        declares a single input lane), but all three are handled defensively.
        """
        try:
            if self._text_chunks:
                full_text = ''.join(self._text_chunks)
                self.instance.selectBranch(self._evaluate({'text': full_text}))
                for chunk in self._text_chunks:
                    self.instance.writeText(chunk)
                self.instance.clearBranchSelection()

            if self._questions:
                self.instance.selectBranch(self._evaluate({'questions': self._questions}))
                for q in self._questions:
                    self.instance.writeQuestions(q)
                self.instance.clearBranchSelection()

            if self._answers:
                self.instance.selectBranch(self._evaluate({'answers': self._answers}))
                for a in self._answers:
                    self.instance.writeAnswers(a)
                self.instance.clearBranchSelection()
        finally:
            # Always release the branch selection, even if a write raised, so
            # subsequent dispatches (e.g. close fan-out) are not misrouted.
            self.instance.clearBranchSelection()

    def _evaluate(self, scope: dict) -> int:
        """Return branch index: 0 (then) if the condition is true, else 1."""
        from ai.common.sandbox import execute_sandboxed

        try:
            code = f'result = bool({self.IGlobal.condition})'
            output = execute_sandboxed(code, extra_globals=scope)
            if output.get('exit_code', 1) != 0:
                raise RuntimeError(f'sandbox error: {output.get("stderr", "unknown")}')
            return 0 if output.get('result', False) else 1
        except Exception as exc:
            debug(f'conditional: evaluation error: {exc}')
            return 1
