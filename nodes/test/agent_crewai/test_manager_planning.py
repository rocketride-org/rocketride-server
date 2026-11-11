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

import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from rocketlib.config import ConfigError

# Imported package-relative: putting nodes/test on sys.path would let its node-named
# subpackages shadow the real node packages under src/nodes (see #1687).
from ..test_contracts import parse_service_json

_NODE_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'agent_crewai'
_MANIFEST = parse_service_json(_NODE_DIR / 'services.manager.json')


class TestManifest:
    """The field the operator actually sees in the config panel."""

    def test_planning_field_exists(self):
        assert 'planning' in _MANIFEST['propertyDefinitions']

    def test_planning_defaults_to_off(self):
        assert _MANIFEST['propertyDefinitions']['planning']['default'] is False

    def test_planning_is_a_boolean_toggle(self):
        assert _MANIFEST['propertyDefinitions']['planning']['type'] == 'boolean'

    def test_planning_is_shown_in_the_config_panel(self):
        assert 'planning' in _MANIFEST['properties']

    def test_description_warns_about_the_json_requirement(self):
        description = _MANIFEST['propertyDefinitions']['planning']['description']
        assert 'JSON' in description


# ---------------------------------------------------------------------------
# IGlobal wiring — stub the CrewAI seams so the real module can be imported;
# rocketlib is the real one, so the config goes through the real resolver
# ---------------------------------------------------------------------------

_STUB_MODULE_NAMES = (
    'depends',
    'agent_crewai',
    'agent_crewai.crewai_runner',
    'agent_crewai.crewai_manager',
    'agent_crewai.crewai_manager.manager',
)


def _build_stubs() -> dict:
    mod_depends = types.ModuleType('depends')
    mod_depends.depends = lambda *args, **kwargs: None

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
    """Run beginGlobal on the real resolver (stored config ``config``) and return the populated IGlobal."""
    with _scoped_stubs():
        iglobal_mod = _load_iglobal()

        instance = iglobal_mod.IGlobal()
        instance.glb = types.SimpleNamespace(logicalType='agent_crewai_manager', connConfig=config)

        instance.beginGlobal()
        return instance


class TestIGlobalWiring:
    def test_planning_defaults_to_false_when_absent(self):
        assert _begin({'goal': '', 'backstory': ''}).planning is False

    def test_true_enables_planning(self):
        assert _begin({'planning': True}).planning is True

    @pytest.mark.parametrize('value', [False, None])
    def test_false_or_unset_keeps_planning_off(self, value):
        """None is "unset" to the resolver, so the schema default (off) applies."""
        assert _begin({'planning': value}).planning is False

    @pytest.mark.parametrize('value', [1, 'yes', 0])
    def test_a_non_boolean_is_refused_by_the_schema(self, value):
        """The field is a boolean: a stringified or numeric flag is a config error, never a guess."""
        with pytest.raises(ConfigError, match='"planning" expects boolean'):
            _begin({'planning': value})

    def test_endglobal_resets_planning(self):
        instance = _begin({'planning': True})
        assert instance.planning is True
        instance.endGlobal()
        assert instance.planning is False
