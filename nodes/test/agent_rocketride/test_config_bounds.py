# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for agent_rocketride config bounds (max_waves clamping)."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

# Self-sufficient bootstrap: importing the module pulls engine runtime modules
# (depends/rocketlib/ai.common) plus jmespath via the executor; stub them if
# absent so this file never depends on a sibling test having run first, then
# drop what we added.
_added = []
for _name in (
    'depends',
    'rocketlib',
    'jmespath',
    'ai',
    'ai.common',
    'ai.common.agent',
    'ai.common.agent.types',
    'ai.common.config',
    'ai.common.schema',
    'ai.common.utils',
):
    if _name not in sys.modules:
        _stub = MagicMock()
        if _name == 'depends':
            _stub.depends = lambda *a, **k: None
        if _name == 'ai.common.agent':
            _stub.AgentBase = object
        sys.modules[_name] = _stub
        _added.append(_name)

_fresh_nodes = 'nodes' not in sys.modules
from nodes.agent_rocketride import rocketride_agent

for _name in _added:
    sys.modules.pop(_name, None)
if _fresh_nodes:
    for _name in [k for k in list(sys.modules) if k == 'nodes' or k.startswith('nodes.')]:
        sys.modules.pop(_name, None)


def test_in_range_value_passes_through():
    assert rocketride_agent._resolve_max_waves(25) == 25
    assert rocketride_agent._resolve_max_waves(1) == 1
    assert rocketride_agent._resolve_max_waves(50) == 50


def test_value_above_schema_maximum_is_clamped():
    assert rocketride_agent._resolve_max_waves(60) == 50


def test_value_below_schema_minimum_is_clamped():
    assert rocketride_agent._resolve_max_waves(0) == 1
    assert rocketride_agent._resolve_max_waves(-5) == 1


def test_non_numeric_value_falls_back_to_default():
    assert rocketride_agent._resolve_max_waves('lots') == rocketride_agent._DEFAULT_MAX_WAVES
    assert rocketride_agent._resolve_max_waves(None) == rocketride_agent._DEFAULT_MAX_WAVES


def test_numeric_string_is_accepted_and_clamped():
    assert rocketride_agent._resolve_max_waves('30') == 30
    assert rocketride_agent._resolve_max_waves('99') == 50
