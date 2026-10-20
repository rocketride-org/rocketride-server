# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Every `nodes` root gets its baseline installed: `nodes` is a namespace package."""

from types import SimpleNamespace

import ai


def test_each_nodes_root_installs_its_baseline(monkeypatch):
    installed = []
    spec = SimpleNamespace(submodule_search_locations=['/server/nodes', '/run/nodes'])
    monkeypatch.setattr(ai.importlib.util, 'find_spec', lambda name: spec if name == 'nodes' else None)
    monkeypatch.setattr(ai, 'depends', installed.append)

    ai.install_node_baseline()

    assert installed == ['/server/nodes/requirements.txt', '/run/nodes/requirements.txt']


def test_no_nodes_package_installs_nothing(monkeypatch):
    installed = []
    monkeypatch.setattr(ai.importlib.util, 'find_spec', lambda name: None)
    monkeypatch.setattr(ai, 'depends', installed.append)

    ai.install_node_baseline()

    assert installed == []
