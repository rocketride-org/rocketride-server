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

"""Shared import-time stubs for the hackjudge_* node tests.

The hackjudge DB nodes import ``rocketlib`` and ``ai.common`` at module level,
which only exist inside the engine. These tests exercise pure logic (password
hashing, input validation, op dispatch), so the seams are stubbed exactly the
way the agent_crewai tests do (see #1640 and the sys.modules guard): installed
around the import and restored afterwards, so a full ``builder nodes:test``
run with the real modules present is unaffected.
"""

from __future__ import annotations

import importlib
import sys
import types
from contextlib import contextmanager
from pathlib import Path

NODES_DIR = Path(__file__).resolve().parent.parent / 'src' / 'nodes'

_STUB_MODULE_NAMES = ('rocketlib', 'ai', 'ai.common', 'ai.common.schema', 'ai.common.config')


def _build_stubs() -> dict:
    mod_rocketlib = types.ModuleType('rocketlib')

    class IInstanceBase:
        def __init__(self, *args, **kwargs):
            pass

    class IGlobalBase:
        def __init__(self, *args, **kwargs):
            pass

    mod_rocketlib.IInstanceBase = IInstanceBase
    mod_rocketlib.IGlobalBase = IGlobalBase
    mod_rocketlib.OPEN_MODE = 0

    mod_ai = types.ModuleType('ai')
    mod_ai_common = types.ModuleType('ai.common')

    mod_schema = types.ModuleType('ai.common.schema')

    class Answer:
        def __init__(self, *args, **kwargs):
            pass

    class Question:
        def __init__(self, *args, **kwargs):
            pass

    mod_schema.Answer = Answer
    mod_schema.Question = Question

    mod_config = types.ModuleType('ai.common.config')

    class Config(dict):
        pass

    mod_config.Config = Config

    return {
        'rocketlib': mod_rocketlib,
        'ai': mod_ai,
        'ai.common': mod_ai_common,
        'ai.common.schema': mod_schema,
        'ai.common.config': mod_config,
    }


@contextmanager
def scoped_stubs():
    original = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    sys.modules.update(_build_stubs())
    try:
        yield
    finally:
        for name, module in original.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def import_node_module(node: str, module: str):
    """Import ``<node>.<module>`` under stubs, off nodes/src/nodes directly
    (importing through the ``nodes`` package would pull the engine-only
    ``depends``).
    """
    while str(NODES_DIR) in sys.path:
        sys.path.remove(str(NODES_DIR))
    sys.path.insert(0, str(NODES_DIR))
    with scoped_stubs():
        return importlib.import_module(f'{node}.{module}')
