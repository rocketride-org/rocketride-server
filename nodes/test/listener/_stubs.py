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

"""Import the listener node's modules under engine stubs, then restore sys.modules."""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes'
_STUBBED = (
    'rocketlib',
    'ai',
    'ai.common',
    'ai.common.schema',
    'nodes',
    'nodes.core',
    'nodes.core.laserdata_tasking',
    'listener',
    'listener.engine',
    'listener.adapters',
    'listener.adapters.laserdata',
)
MONITOR: list = []


class FakeQuestion:
    """Stand-in for ai.common.schema.Question."""

    def __init__(self, role=''):
        self.role, self.questions = role, []

    def addQuestion(self, text):
        """Record one question text."""
        self.questions.append(text)


def load(*names):
    """Import the named listener modules (e.g. 'listener.engine') under stubs; return them in order."""
    saved = {n: sys.modules.get(n) for n in _STUBBED}
    try:
        rl = types.ModuleType('rocketlib')
        rl.getObject = lambda obj: types.SimpleNamespace(obj=obj, response=None)
        rl.monitorCompleted = lambda n: MONITOR.append(('completed', n))
        rl.monitorFailed = lambda n: MONITOR.append(('failed', n))
        rl.debug = lambda *a, **k: None
        sys.modules['rocketlib'] = rl
        for name in ('ai', 'ai.common', 'ai.common.schema'):
            sys.modules[name] = types.ModuleType(name)
        sys.modules['ai'].__path__ = []
        sys.modules['ai.common'].__path__ = []
        sys.modules['ai.common.schema'].Question = FakeQuestion
        nodes = types.ModuleType('nodes')
        nodes.__path__ = [str(_SRC)]
        core = types.ModuleType('nodes.core')
        core.__path__ = [str(_SRC / 'core')]
        sys.modules['nodes'], sys.modules['nodes.core'] = nodes, core
        pkg = types.ModuleType('listener')
        pkg.__path__ = [str(_SRC / 'listener')]
        sys.modules['listener'] = pkg
        return tuple(importlib.import_module(n) for n in names)
    finally:
        for n, m in saved.items():
            if m is None:
                sys.modules.pop(n, None)
            else:
                sys.modules[n] = m
