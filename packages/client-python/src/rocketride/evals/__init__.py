# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Golden-Dataset Evaluation for RocketRide Pipelines.

This package implements ``rocketride eval``: a golden-dataset evaluation
runner for ``.pipe`` pipeline files. An eval spec (``<name>.eval.json``)
declares a pipeline plus named cases with inputs and assertions; the runner
starts the pipeline on the engine, sends each case input through chat, and
checks the output against deterministic assertions or an LLM-as-judge (the
judge itself is a ``.pipe`` run on the same engine).

Public API:
    load_spec / EvalSpec / EvalCase / AssertionSpec / EvalSpecError: Spec model
    run_spec: Execute one spec against a connected client
    evaluate_assertion / AssertionResult: Assertion evaluation
    make_judge / build_judge_prompt / parse_judge_verdict / JudgeVerdict /
        JudgeParseError: LLM-as-judge support
    CaseResult / EvalReport / render_human / render_json / render_junit:
        Result model and reporters
"""

from .assertions import AssertionResult, evaluate_assertion
from .judge import (
    JudgeParseError,
    JudgeVerdict,
    build_judge_prompt,
    make_judge,
    parse_judge_verdict,
)
from .reporters import CaseResult, EvalReport, render_human, render_json, render_junit
from .runner import default_judge_pipeline_path, run_spec
from .spec import AssertionSpec, EvalCase, EvalSpec, EvalSpecError, load_spec

__all__ = [
    'AssertionResult',
    'AssertionSpec',
    'CaseResult',
    'EvalCase',
    'EvalReport',
    'EvalSpec',
    'EvalSpecError',
    'JudgeParseError',
    'JudgeVerdict',
    'build_judge_prompt',
    'default_judge_pipeline_path',
    'evaluate_assertion',
    'load_spec',
    'make_judge',
    'parse_judge_verdict',
    'render_human',
    'render_json',
    'render_junit',
    'run_spec',
]
