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
"""System One decision models: one writer of the generic decisions contract."""

from .client import SystemOneClient, SystemOneError
from .limits import DecisionLimits
from .questions import (
    PICK_ONE,
    RUBRIC,
    YES_NO,
    ProtocolError,
    QuestionConfigError,
    QuestionSpec,
    build_wire_questions,
    describe_questions,
    error_decision,
    map_answer,
    parse_questions,
)
from .runner import DecisionResult, DecisionRunner, merge_decisions

__all__ = [
    'DecisionLimits',
    'DecisionResult',
    'DecisionRunner',
    'PICK_ONE',
    'ProtocolError',
    'RUBRIC',
    'SystemOneClient',
    'SystemOneError',
    'YES_NO',
    'QuestionConfigError',
    'QuestionSpec',
    'build_wire_questions',
    'describe_questions',
    'error_decision',
    'map_answer',
    'merge_decisions',
    'parse_questions',
]
