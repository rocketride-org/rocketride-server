# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Network-free unit tests for the CrewAI Manager's opt-in planning flag.

The manager used to hardcode ``Crew(planning=True)``. CrewAI's planner runs a
task with ``output_pydantic=PlannerTaskPydanticOutput`` and drives it with our
``HostInvokeLLM``, but the host channel is text-in / text-out and cannot promise
JSON. When the plan text did not parse, crewai's converter dead-ended --
``utilities/converter.py:67`` passes ``agent=None`` into ``handle_partial_json``,
whose fallback ``convert_with_instructions`` raises
``TypeError: Agent must be provided if converter_cls is not specified`` -- and
even with that repaired ``planning_handler.py:78`` raises
``Failed to get the Planning output``. A crew that would otherwise have run
fine died during planning, on every kickoff.

Planning is therefore opt-in and off by default. These tests pin the contract at
the two seams that are checkable without the engine: the manifest the config
panel renders from, and ``IGlobal``'s parsing of the field.
"""

from __future__ import annotations

import json
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

_NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'agent_crewai'
_MANIFEST = json.loads((_NODE_DIR / 'services.manager.json').read_text(encoding='utf-8'))


class TestManifest:
    """The field the operator actually sees in the config panel."""

    def test_planning_field_exists(self):
        assert 'planning' in _MANIFEST['fields']

    def test_planning_defaults_to_off(self):
        assert _MANIFEST['fields']['planning']['default'] is False
        assert _MANIFEST['preconfig']['profiles']['default']['planning'] is False

    def test_planning_is_a_boolean_toggle(self):
        field = _MANIFEST['fields']['planning']
        assert field['type'] == 'boolean'
        assert field['enum'] == [[False, 'Off'], [True, 'On']]

    def test_planning_is_gated_behind_advanced_mode(self):
        conditional = _MANIFEST['fields']['advanced_mode']['conditional']
        advanced = next(c for c in conditional if c['value'] is True)
        assert 'planning' in advanced['properties']

    def test_description_warns_about_the_json_requirement(self):
        description = _MANIFEST['fields']['planning']['description']
        assert 'JSON' in description


# ---------------------------------------------------------------------------
# IGlobal wiring — stub the engine-only seams so the real module can be imported
# ---------------------------------------------------------------------------

_STUB_MODULE_NAMES = (
    'depends',
    'rocketlib',
    'ai',
    'ai.common',
    'ai.common.config',
    'agent_crewai',
    'agent_crewai.crewai_runner',
    'agent_crewai.crewai_manager',
    'agent_crewai.crewai_manager.manager',
)


class _StubConfig:
    """Stands in for ai.common.config.Config; returns whatever a test queued."""

    node_config: dict = {}

    @staticmethod
    def getNodeConfig(logical_type, conn_config):  # noqa: ARG004 — signature parity
        return _StubConfig.node_config


def _build_stubs() -> dict:
    mod_depends = types.ModuleType('depends')
    mod_depends.depends = lambda *args, **kwargs: None

    mod_rocketlib = types.ModuleType('rocketlib')

    class IGlobalBase:
        pass

    class _OpenMode:
        CONFIG = 'CONFIG'
        SOURCE = 'SOURCE'

    mod_rocketlib.IGlobalBase = IGlobalBase
    mod_rocketlib.OPEN_MODE = _OpenMode

    mod_ai = types.ModuleType('ai')
    mod_ai_common = types.ModuleType('ai.common')
    mod_config = types.ModuleType('ai.common.config')
    mod_config.Config = _StubConfig

    # Synthetic package parents so IGlobal's relative imports resolve without
    # dragging in crewai_runner / manager / crewai_base, none of which this test
    # exercises and all of which need the engine runtime.
    pkg = types.ModuleType('agent_crewai')
    pkg.__path__ = []
    sub_pkg = types.ModuleType('agent_crewai.crewai_manager')
    sub_pkg.__path__ = []

    mod_runner = types.ModuleType('agent_crewai.crewai_runner')
    mod_runner.get_shared_runner = lambda: object()

    mod_manager = types.ModuleType('agent_crewai.crewai_manager.manager')

    class CrewManager:
        def __init__(self, iGlobal):
            self.iGlobal = iGlobal

    mod_manager.CrewManager = CrewManager

    return {
        'depends': mod_depends,
        'rocketlib': mod_rocketlib,
        'ai': mod_ai,
        'ai.common': mod_ai_common,
        'ai.common.config': mod_config,
        'agent_crewai': pkg,
        'agent_crewai.crewai_runner': mod_runner,
        'agent_crewai.crewai_manager': sub_pkg,
        'agent_crewai.crewai_manager.manager': mod_manager,
    }


@contextmanager
def _scoped_stubs() -> Iterator[None]:
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


def _load_iglobal():
    """Load the real IGlobal module under its package name so relative imports work."""
    import importlib.util

    name = 'agent_crewai.crewai_manager.IGlobal'
    spec = importlib.util.spec_from_file_location(name, _NODE_DIR / 'crewai_manager' / 'IGlobal.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(name, None)
    return module


def _begin(config: dict):
    """Run beginGlobal against a stubbed engine and return the populated IGlobal."""
    with _scoped_stubs():
        iglobal_mod = _load_iglobal()
        _StubConfig.node_config = config

        instance = iglobal_mod.IGlobal()
        endpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='SOURCE'))
        instance.IEndpoint = endpoint
        instance.glb = types.SimpleNamespace(logicalType='agent_crewai_manager', connConfig={})

        instance.beginGlobal()
        return instance


class TestIGlobalWiring:
    def test_planning_defaults_to_false_when_absent(self):
        assert _begin({'goal': '', 'backstory': ''}).planning is False

    @pytest.mark.parametrize('value', [True, 1, 'yes'])
    def test_truthy_config_enables_planning(self, value):
        assert _begin({'planning': value}).planning is True

    @pytest.mark.parametrize('value', [False, 0, '', None])
    def test_falsy_config_keeps_planning_off(self, value):
        assert _begin({'planning': value}).planning is False

    def test_endglobal_resets_planning(self):
        instance = _begin({'planning': True})
        assert instance.planning is True
        instance.endGlobal()
        assert instance.planning is False
