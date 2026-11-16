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

"""The multitenant certification gate (plan 4.3, 4.4, C.12).

A node certified ``multitenant`` may run on an engine shared across users, so
its IGlobal must hold no caller data and its instances must read IGlobal
through methods only. Two checks, per certified node:

* STATIC: ``IInstance`` opts into the methods-only facade
  (``iglobal_methods_only = True``) and its source reads nothing from
  ``self.IGlobal`` but methods (``glb`` and ``tool_description`` are the
  framework's reach-through), never ``IGlobal.config``.
* DYNAMIC (the exemplars): with the real rocketlib bases under the engine, the
  IGlobal is built once and its containers deep-frozen; two bindings with
  different callers run through it. A node that writes caller data to its
  IGlobal fails on the frozen container; the second binding sees nothing the
  first left behind.
"""

from __future__ import annotations

import importlib
import re
import sys
from pathlib import Path
from types import MappingProxyType, SimpleNamespace

import pytest

NODES = Path(__file__).resolve().parents[1] / 'src' / 'nodes'
READ = re.compile(r'self\.IGlobal\.([A-Za-z_][A-Za-z0-9_]*)([^A-Za-z0-9_(]|$)')
WHITELIST = frozenset({'glb', 'tool_description'})


def certified_nodes() -> list[str]:
    """Every catalog node whose service definition carries the multitenant capability."""
    found = []
    for folder in sorted(NODES.iterdir()):
        if not folder.is_dir():
            continue
        for name in folder.iterdir():
            if (
                name.name.startswith('services')
                and name.suffix == '.json'
                and '"multitenant"' in name.read_text(encoding='utf-8')
            ):
                found.append(folder.name)
                break
    return found


CERTIFIED = certified_nodes()


# =============================================================================
# STATIC
# =============================================================================


@pytest.mark.parametrize('node', CERTIFIED)
def test_a_certified_instance_is_methods_only_on_its_global(node):
    """The instance opts into the facade and reads its IGlobal through methods alone."""
    source = (NODES / node / 'IInstance.py').read_text(encoding='utf-8')
    assert re.search(r'^\s+iglobal_methods_only = True\s*$', source, re.M), f'{node}: IInstance has not opted in'
    reads = [m.group(1) for m in READ.finditer(source) if m.group(1) not in WHITELIST]
    assert reads == [], f'{node}: IInstance reads IGlobal data {sorted(set(reads))}; add accessors or use settings'
    assert 'self.IGlobal.config' not in source, (
        f'{node}: an instance reads IGlobal.config; per-call values come from settings'
    )


def test_the_certified_set_is_the_one_this_gate_knows():
    """The gate runs over every certified node (a new certification extends this list deliberately)."""
    assert set(CERTIFIED) >= {'prompt', 'response', 'question', 'dictionary', 'thumbnail', 'tool_pipe'}


# =============================================================================
# DYNAMIC: frozen IGlobal, two bindings
# =============================================================================


def _freeze(obj) -> None:
    """Deep-freeze an IGlobal's containers in place (harness only): dict -> MappingProxy, list -> tuple, set -> frozenset."""

    def frozen(value):
        if isinstance(value, dict):
            return MappingProxyType({k: frozen(v) for k, v in value.items()})
        if isinstance(value, list):
            return tuple(frozen(v) for v in value)
        if isinstance(value, set):
            return frozenset(value)
        return value

    for key, value in list(vars(obj).items()):
        if key == 'glb':
            continue
        setattr(obj, key, frozen(value))


class _FakeEngineInstance:
    """The engine's instance object a node writes its output through."""

    def __init__(self, node_id: str) -> None:
        self.pipeType = SimpleNamespace(id=node_id)
        self.written: list = []
        self.currentObject = SimpleNamespace(hasComponentId=False)

    def writeQuestions(self, question) -> None:
        self.written.append(('questions', question))

    def writeText(self, text) -> None:
        self.written.append(('text', text))

    def writeDocuments(self, documents) -> None:
        self.written.append(('documents', documents))

    def writeAnswers(self, answer) -> None:
        self.written.append(('answers', answer))


def _binding(node: str, glb, caller: dict):
    """Construct one binding's instance the way the binder does: inject, stamp the caller, begin."""
    module = importlib.import_module(f'nodes.{node}.IInstance')
    instance = module.IInstance()
    instance.instance = _FakeEngineInstance(f'{node}_1')
    instance.IGlobal = glb
    instance._caller = caller
    if hasattr(instance, 'beginInstance'):
        instance.beginInstance()
    return instance


def _global(node: str, conn_config: dict | None = None):
    """Construct and begin the node's IGlobal as the engine does."""
    rocketlib = importlib.import_module('rocketlib')
    if rocketlib.getServiceSchema(node) is None:
        pytest.skip(f'{node} is not registered with the engine')
    module = importlib.import_module(f'nodes.{node}.IGlobal')
    glb = module.IGlobal()
    glb.glb = SimpleNamespace(logicalType=node, connConfig=conn_config or {})
    glb.beginGlobal()
    return glb


def _question(text: str):
    from ai.common.schema import Question

    question = Question()
    question.addQuestion(text)
    return question


def _run_prompt_binding(glb, caller: dict, text: str):
    instance = _binding('prompt', glb, caller)
    instance.open(SimpleNamespace(url='test://doc.txt'))
    for step in (lambda: instance.writeText(text), instance.closing):
        try:
            step()
        except Exception as e:
            # preventDefault is how a lane method tells the engine it consumed the input
            if 'PreventDefault' not in type(e).__name__ and 'PreventDefault' not in str(e):
                raise
    if hasattr(instance, 'endInstance'):
        instance.endInstance()
    return instance


@pytest.mark.parametrize('node', ['prompt', 'question'])
def test_two_bindings_with_different_callers_leave_nothing_on_a_frozen_global(node):
    """The exemplar's IGlobal, frozen after beginGlobal, serves two callers: no write reaches it, and the second
    binding's output carries nothing of the first's.
    """
    glb = _global(node)
    _freeze(glb)
    caller_a = {'userId': 'user-a', 'orgId': 'org-1', 'params': {}, 'env': {}}
    caller_b = {'userId': 'user-b', 'orgId': 'org-2', 'params': {}, 'env': {}}

    if node == 'prompt':
        first = _run_prompt_binding(glb, caller_a, 'alpha context')
        second = _run_prompt_binding(glb, caller_b, 'beta context')
        texts = [str(q.getPrompt()) for lane, q in second.instance.written if lane == 'questions']
        assert texts and all('alpha' not in t for t in texts), texts
        assert first is not second and first.question is not second.question
    else:
        first = _binding(node, glb, caller_a)
        second = _binding(node, glb, caller_b)
        for instance, text in ((first, 'alpha?'), (second, 'beta?')):
            try:
                instance.writeText(text)
            except Exception as e:
                if 'PreventDefault' not in type(e).__name__ and 'PreventDefault' not in str(e):
                    raise
        written = [str(q.getPrompt()) for lane, q in second.instance.written if lane == 'questions']
        assert written and all('alpha' not in t for t in written), written
    # The facade is live: a data read from an instance is refused (the
    # wrapped global's own namespace is data, never a method)
    with pytest.raises(Exception, match='methods-only'):
        getattr(first.IGlobal, '__dict__')


def test_the_frozen_global_refuses_a_caller_write():
    """The harness's freeze is real: a node that stashed caller data on IGlobal would fail here."""
    glb = _global('prompt')
    glb.scratch = {'calls': []}
    _freeze(glb)
    with pytest.raises((TypeError, AttributeError)):
        glb.scratch['calls'].append('user-a')
    with pytest.raises(TypeError):
        glb.scratch['other'] = 1


# Keep the module importable where the nodes package is not on the path (collection only)
if __name__ == '__main__':  # pragma: no cover
    sys.exit(pytest.main([__file__]))
