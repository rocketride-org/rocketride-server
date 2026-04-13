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

Evaluates a sandboxed Python expression against the incoming content
(``text``, ``questions`` or ``answers``) and routes it to one of two exclusive
branches: ``then`` (true) or ``else`` (false).
"""

from __future__ import annotations

from rocketlib import IInstanceBase, debug

from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def writeText(self, text: str):
        self.instance.selectBranch(self._evaluate({'text': text}))
        self.instance.writeText(text)

    def writeQuestions(self, questions):
        self.instance.selectBranch(self._evaluate({'questions': questions}))
        self.instance.writeQuestions(questions)

    def writeAnswers(self, answers):
        self.instance.selectBranch(self._evaluate({'answers': answers}))
        self.instance.writeAnswers(answers)

    def closing(self):
        pass

    def close(self):
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
