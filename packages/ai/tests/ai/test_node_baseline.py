# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Every `nodes` root gets its baseline installed: `nodes` is a namespace package.

The install is run-path work: `node.py` calls `ai.install_node_baseline()` before
the pipeline loads, and importing `ai` installs nothing for the nodes.
"""

import importlib
import os
import sys
from types import SimpleNamespace

import ai


def _root(tmp_path, name, with_requirements=True):
    """Create a `nodes` root under `tmp_path`, with or without a requirements file."""
    root = tmp_path / name / 'nodes'
    root.mkdir(parents=True)
    if with_requirements:
        (root / 'requirements.txt').write_text('requests\n')
    return str(root)


def test_each_nodes_root_installs_its_baseline(monkeypatch, tmp_path):
    installed = []
    roots = [_root(tmp_path, 'server'), _root(tmp_path, 'run')]
    spec = SimpleNamespace(submodule_search_locations=roots)
    monkeypatch.setattr(ai.importlib.util, 'find_spec', lambda name: spec if name == 'nodes' else None)
    monkeypatch.setattr(ai, 'depends', installed.append)

    ai.install_node_baseline()

    assert installed == [os.path.join(root, 'requirements.txt') for root in roots]


def test_a_root_without_requirements_is_skipped(monkeypatch, tmp_path):
    installed = []
    roots = [_root(tmp_path, 'server'), _root(tmp_path, 'run', with_requirements=False)]
    spec = SimpleNamespace(submodule_search_locations=roots)
    monkeypatch.setattr(ai.importlib.util, 'find_spec', lambda name: spec if name == 'nodes' else None)
    monkeypatch.setattr(ai, 'depends', installed.append)

    ai.install_node_baseline()

    assert installed == [os.path.join(roots[0], 'requirements.txt')]


def test_a_plain_nodes_module_installs_nothing(monkeypatch, tmp_path):
    (tmp_path / 'nodes.py').write_text('')
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.delitem(sys.modules, 'nodes', raising=False)
    installed = []
    monkeypatch.setattr(ai, 'depends', installed.append)

    ai.install_node_baseline()

    assert installed == []


def test_no_nodes_package_installs_nothing(monkeypatch):
    installed = []
    monkeypatch.setattr(ai.importlib.util, 'find_spec', lambda name: None)
    monkeypatch.setattr(ai, 'depends', installed.append)

    ai.install_node_baseline()

    assert installed == []


def test_importing_ai_installs_no_node_baseline(monkeypatch):
    """`import ai` resolves ai's own requirements only; the node baseline waits for the run path."""
    import depends as depends_module

    installed = []
    with monkeypatch.context() as patch:
        patch.setattr(depends_module, 'depends', installed.append)
        importlib.reload(ai)
    try:
        assert installed == [ai.CONST_AI_REQUIREMENTS]
    finally:
        # Put the real `depends` back on the module for every later test.
        importlib.reload(ai)
