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
Semantic diff for RocketRide ``.pipe`` pipeline files.

``rocketride diff`` surfaces what actually changed between two pipeline
definitions — added/removed/reconfigured nodes and rewired edges — instead of the
raw JSON churn dominated by canvas coordinates. This package is the pure,
network-free implementation behind the CLI subcommand and the PR-comment GitHub
Action.

Public API:
    Data model:
        NodeChange, FieldChange, EdgeChange, PipeDiff
    Engine:
        load_pipe, diff_pipes, deep_diff_config, PipeDiffError
    Git resolution:
        resolve_git_ref
    Reporters (rendering):
        render_human, render_json, render_markdown
"""

from .engine import PipeDiffError, deep_diff_config, diff_pipes, load_pipe
from .gitref import resolve_git_ref
from .model import EdgeChange, FieldChange, NodeChange, PipeDiff
from .reporters import render_human, render_json, render_markdown

__all__ = [
    'NodeChange',
    'FieldChange',
    'EdgeChange',
    'PipeDiff',
    'PipeDiffError',
    'load_pipe',
    'diff_pipes',
    'deep_diff_config',
    'resolve_git_ref',
    'render_human',
    'render_json',
    'render_markdown',
]
