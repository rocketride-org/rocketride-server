"""Unit tests for Config.getNodeConfig shape handling.

Pins the fix for the agent config-shape bug: the VS Code form nests a node's
fields under a sub-object named after the default profile (e.g.
``connConfig["default"] = {"instructions": [...]}``), but the runtime reads them
top-level. ``getNodeConfig`` now overlays that nested object so both the flat
(Shape B) and nested (Shape A) shapes resolve, with real top-level values
winning over a stale/empty nested block.

Also pins the fix for #1839 defect 1: that overlay previously only ran when
"profile" was absent. With an explicit "profile" key set, the other branch
read only ``connConfig[profile]``, so a key written at the top level (e.g.
"apikey" alongside "profile") was silently dropped — see
``TestExplicitProfileBranchTopLevelFields``.

Loaded by file path with ``rocketlib``/``json5`` stubbed so no engine runtime is
needed — run with ``pytest --noconftest``.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

_CONFIG_PATH = Path(__file__).resolve().parents[3] / 'src' / 'ai' / 'common' / 'config.py'

# Fake service definition: single "default" profile with empty field defaults.
# `require_tool_call` mirrors the boolean guard field added to the agent nodes.
_SERVICE = {
    'preconfig': {
        'default': 'default',
        'profiles': {
            'default': {'instructions': [], 'agent_description': '', 'role': 'Assistant', 'require_tool_call': False},
        },
    }
}


def _load_config():
    """Load config.py with rocketlib/json5 stubbed; patch getServiceDefinition."""
    saved = {k: sys.modules.get(k) for k in ('rocketlib', 'json5')}

    rl = types.ModuleType('rocketlib')

    class _IJson:
        @staticmethod
        def toDict(x):
            return dict(x) if isinstance(x, dict) else x

    rl.IJson = _IJson
    rl.warning = lambda *a, **k: None
    rl.getServiceDefinition = lambda logical_type: _SERVICE
    sys.modules['rocketlib'] = rl
    sys.modules['json5'] = types.ModuleType('json5')

    try:
        spec = importlib.util.spec_from_file_location('rr_real_config', _CONFIG_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.Config
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v


Config = _load_config()


class TestFlatShape:
    def test_top_level_fields_resolve(self):
        cfg = Config.getNodeConfig('agent_x', {'instructions': ['a', 'b'], 'agent_description': 'desc'})
        assert cfg['instructions'] == ['a', 'b']
        assert cfg['agent_description'] == 'desc'

    def test_empty_conn_config_uses_profile_defaults(self):
        cfg = Config.getNodeConfig('agent_x', {})
        assert cfg['instructions'] == []
        assert cfg['role'] == 'Assistant'


class TestNestedShape:
    def test_nested_under_default_resolves(self):
        cfg = Config.getNodeConfig('agent_x', {'default': {'instructions': ['a', 'b'], 'agent_description': 'desc'}})
        assert cfg['instructions'] == ['a', 'b']
        assert cfg['agent_description'] == 'desc'

    def test_nested_advanced_field_resolves(self):
        cfg = Config.getNodeConfig('agent_x', {'default': {'role': 'Analyst'}})
        assert cfg['role'] == 'Analyst'


class TestMixedShapePrecedence:
    def test_real_top_level_beats_empty_nested_default(self):
        cfg = Config.getNodeConfig('agent_x', {'instructions': ['real'], 'default': {'instructions': []}})
        assert cfg['instructions'] == ['real']

    def test_top_level_overrides_nested_value(self):
        cfg = Config.getNodeConfig('agent_x', {'instructions': ['top'], 'default': {'instructions': ['nested']}})
        assert cfg['instructions'] == ['top']

    def test_explicit_none_top_level_does_not_clobber_nested(self):
        # A None placeholder at the top level must not override a populated nested value.
        cfg = Config.getNodeConfig('agent_x', {'role': None, 'default': {'role': 'Analyst'}})
        assert cfg['role'] == 'Analyst'


class TestExplicitProfileBranchNestedShape:
    def test_explicit_profile_reads_nested(self):
        cfg = Config.getNodeConfig('agent_x', {'profile': 'default', 'default': {'instructions': ['x']}})
        assert cfg['instructions'] == ['x']


class TestExplicitProfileBranchTopLevelFields:
    """Pins the fix for #1839 defect 1: with a "profile" key set, the
    explicit-profile branch used to read only connConfig[profile] and
    silently drop every key written at the top level (e.g. an "apikey"
    sitting alongside "profile" instead of nested under the profile name).
    Mirrors TestMixedShapePrecedence so both branches of getNodeConfig
    agree on where a caller's configuration can live.
    """

    def test_top_level_fields_resolve_with_explicit_profile(self):
        cfg = Config.getNodeConfig(
            'agent_x', {'profile': 'default', 'instructions': ['a', 'b'], 'agent_description': 'desc'}
        )
        assert cfg['instructions'] == ['a', 'b']
        assert cfg['agent_description'] == 'desc'

    def test_top_level_overrides_nested_value_with_explicit_profile(self):
        cfg = Config.getNodeConfig(
            'agent_x', {'profile': 'default', 'instructions': ['top'], 'default': {'instructions': ['nested']}}
        )
        assert cfg['instructions'] == ['top']

    def test_explicit_none_top_level_does_not_clobber_nested_with_explicit_profile(self):
        cfg = Config.getNodeConfig(
            'agent_x', {'profile': 'default', 'role': None, 'default': {'role': 'Analyst'}}
        )
        assert cfg['role'] == 'Analyst'

    def test_profile_selector_key_is_not_leaked_into_resolved_config(self):
        cfg = Config.getNodeConfig('agent_x', {'profile': 'default', 'instructions': ['a']})
        assert 'profile' not in cfg


class TestRequireToolCallResolution:
    """The require_tool_call guard flag resolves through getNodeConfig exactly
    as AgentBase.__init__ reads it: ``bool(config.get('require_tool_call', False))``.
    Covers flat, nested, and default shapes so an operator can enable it either way.
    """

    def _flag(self, conn):
        return bool(Config.getNodeConfig('agent_x', conn).get('require_tool_call', False))

    def test_default_is_off(self):
        assert self._flag({}) is False

    def test_explicit_true_top_level(self):
        assert self._flag({'require_tool_call': True}) is True

    def test_explicit_false_top_level(self):
        assert self._flag({'require_tool_call': False}) is False

    def test_nested_true_under_default(self):
        assert self._flag({'default': {'require_tool_call': True}}) is True

    def test_nested_false_stays_off(self):
        assert self._flag({'default': {'require_tool_call': False}}) is False

    def test_top_level_true_beats_nested_false(self):
        assert self._flag({'require_tool_call': True, 'default': {'require_tool_call': False}}) is True
