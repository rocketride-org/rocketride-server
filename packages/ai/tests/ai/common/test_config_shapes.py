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

And #1839 defect 2: array/object config values arrive from the engine as
IJson, not list/dict, so a node that type-checks its own declared field
(``isinstance(value, list)``) silently falls through to its default. The
fake ``IJson`` stub below mirrors the real ``rocketlib.types.IJson`` closely
enough (wraps a value, recursive ``toDict``) to exercise this — see
``TestNativeConfigTypes``.

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
            'default': {
                'instructions': [],
                'agent_description': '',
                'role': 'Assistant',
                'require_tool_call': False,
                'entityTypes': [],
            },
        },
    }
}


class _FakeIJson:
    """Stands in for rocketlib.types.IJson: wraps a value and exposes a
    recursive ``toDict`` that unwraps nested ``_FakeIJson``/dict/list values,
    matching the real implementation closely enough to exercise #1839
    defect 2 (array/object fields arriving as IJson instead of list/dict).
    """

    def __init__(self, value):
        """Wrap `value` (typically a dict or list) as this stub would arrive from the engine."""
        self.value = value

    def get(self, key, default=None):
        """Dict-like `.get`, delegating to the wrapped value when it's a dict."""
        if isinstance(self.value, dict):
            return self.value.get(key, default)
        return default

    def items(self):
        """Dict-like `.items`, delegating to the wrapped value when it's a dict."""
        if isinstance(self.value, dict):
            return self.value.items()
        return ()

    @staticmethod
    def toDict(obj):
        """Recursively unwrap `_FakeIJson`/dict/list values into native dict/list."""
        if isinstance(obj, _FakeIJson):
            return _FakeIJson.toDict(obj.value)
        if isinstance(obj, dict):
            return {key: _FakeIJson.toDict(value) for key, value in obj.items()}
        if isinstance(obj, list):
            return [_FakeIJson.toDict(value) for value in obj]
        return obj


def _load_config():
    """Load config.py with rocketlib/json5 stubbed; patch getServiceDefinition."""
    saved = {k: sys.modules.get(k) for k in ('rocketlib', 'json5')}

    rl = types.ModuleType('rocketlib')
    rl.IJson = _FakeIJson
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
        """Fields written directly at the top level (no "default" nesting) resolve."""
        cfg = Config.getNodeConfig('agent_x', {'instructions': ['a', 'b'], 'agent_description': 'desc'})
        assert cfg['instructions'] == ['a', 'b']
        assert cfg['agent_description'] == 'desc'

    def test_empty_conn_config_uses_profile_defaults(self):
        """An empty connConfig falls back entirely to the default profile's values."""
        cfg = Config.getNodeConfig('agent_x', {})
        assert cfg['instructions'] == []
        assert cfg['role'] == 'Assistant'


class TestNestedShape:
    def test_nested_under_default_resolves(self):
        """Fields nested under connConfig["default"] (Shape A) resolve too."""
        cfg = Config.getNodeConfig('agent_x', {'default': {'instructions': ['a', 'b'], 'agent_description': 'desc'}})
        assert cfg['instructions'] == ['a', 'b']
        assert cfg['agent_description'] == 'desc'

    def test_nested_advanced_field_resolves(self):
        """A single nested field resolves without requiring every field to be present."""
        cfg = Config.getNodeConfig('agent_x', {'default': {'role': 'Analyst'}})
        assert cfg['role'] == 'Analyst'


class TestMixedShapePrecedence:
    def test_real_top_level_beats_empty_nested_default(self):
        """A real top-level value wins even when the nested block sets the same field to empty."""
        cfg = Config.getNodeConfig('agent_x', {'instructions': ['real'], 'default': {'instructions': []}})
        assert cfg['instructions'] == ['real']

    def test_top_level_overrides_nested_value(self):
        """A real top-level value wins over a different, populated nested value."""
        cfg = Config.getNodeConfig('agent_x', {'instructions': ['top'], 'default': {'instructions': ['nested']}})
        assert cfg['instructions'] == ['top']

    def test_explicit_none_top_level_does_not_clobber_nested(self):
        """A None placeholder at the top level must not override a populated nested value."""
        cfg = Config.getNodeConfig('agent_x', {'role': None, 'default': {'role': 'Analyst'}})
        assert cfg['role'] == 'Analyst'


class TestExplicitProfileBranchNestedShape:
    def test_explicit_profile_reads_nested(self):
        """With an explicit "profile" key, fields nested under that profile name resolve."""
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
        """A key written at the top level resolves even with "profile" set."""
        cfg = Config.getNodeConfig(
            'agent_x', {'profile': 'default', 'instructions': ['a', 'b'], 'agent_description': 'desc'}
        )
        assert cfg['instructions'] == ['a', 'b']
        assert cfg['agent_description'] == 'desc'

    def test_top_level_overrides_nested_value_with_explicit_profile(self):
        """A real top-level value wins over the same key nested under the profile."""
        cfg = Config.getNodeConfig(
            'agent_x', {'profile': 'default', 'instructions': ['top'], 'default': {'instructions': ['nested']}}
        )
        assert cfg['instructions'] == ['top']

    def test_explicit_none_top_level_does_not_clobber_nested_with_explicit_profile(self):
        """A None placeholder at the top level must not override a populated nested value."""
        cfg = Config.getNodeConfig(
            'agent_x', {'profile': 'default', 'role': None, 'default': {'role': 'Analyst'}}
        )
        assert cfg['role'] == 'Analyst'

    def test_profile_selector_key_is_not_leaked_into_resolved_config(self):
        """"profile" is the branch selector, not a node field; it must not appear in the result."""
        cfg = Config.getNodeConfig('agent_x', {'profile': 'default', 'instructions': ['a']})
        assert 'profile' not in cfg


class TestNativeConfigTypes:
    """Pins the fix for #1839 defect 2: array/object config values arrive
    from the engine as IJson, not list/dict, so a node that type-checks its
    own declared field (``isinstance(value, list)``) silently falls through
    to its default. ``getNodeConfig`` now normalizes its return value with
    ``IJson.toDict`` so callers always see native types.
    """

    def test_ijson_array_value_arrives_as_native_list(self):
        """A field wrapped in IJson (as the engine delivers it) resolves to a plain list."""
        cfg = Config.getNodeConfig('agent_x', {'entityTypes': _FakeIJson(['PERSON', 'EMAIL'])})
        assert cfg['entityTypes'] == ['PERSON', 'EMAIL']
        assert isinstance(cfg['entityTypes'], list)

    def test_ijson_nested_object_arrives_as_native_dict(self):
        """Nested IJson values (list-of-dict) are also converted recursively."""
        cfg = Config.getNodeConfig(
            'agent_x', {'entityTypes': _FakeIJson(['PERSON', _FakeIJson({'nested': ['LOCATION']})])}
        )
        assert cfg['entityTypes'] == ['PERSON', {'nested': ['LOCATION']}]
        assert isinstance(cfg['entityTypes'][1], dict)
        assert isinstance(cfg['entityTypes'][1]['nested'], list)

    def test_native_list_value_is_unaffected(self):
        """A plain list (e.g. the profile default, already native) passes through unchanged."""
        cfg = Config.getNodeConfig('agent_x', {})
        assert cfg['entityTypes'] == []
        assert isinstance(cfg['entityTypes'], list)


class TestRequireToolCallResolution:
    """The require_tool_call guard flag resolves through getNodeConfig exactly
    as AgentBase.__init__ reads it: ``bool(config.get('require_tool_call', False))``.
    Covers flat, nested, and default shapes so an operator can enable it either way.
    """

    def _flag(self, conn):
        """Resolve require_tool_call through getNodeConfig exactly as AgentBase.__init__ reads it."""
        return bool(Config.getNodeConfig('agent_x', conn).get('require_tool_call', False))

    def test_default_is_off(self):
        """With no configuration at all, the guard defaults to off."""
        assert self._flag({}) is False

    def test_explicit_true_top_level(self):
        """A top-level True enables the guard."""
        assert self._flag({'require_tool_call': True}) is True

    def test_explicit_false_top_level(self):
        """A top-level False keeps the guard off."""
        assert self._flag({'require_tool_call': False}) is False

    def test_nested_true_under_default(self):
        """A True nested under "default" also enables the guard."""
        assert self._flag({'default': {'require_tool_call': True}}) is True

    def test_nested_false_stays_off(self):
        """A False nested under "default" keeps the guard off."""
        assert self._flag({'default': {'require_tool_call': False}}) is False

    def test_top_level_true_beats_nested_false(self):
        """A real top-level True wins over a conflicting nested False."""
        assert self._flag({'require_tool_call': True, 'default': {'require_tool_call': False}}) is True
