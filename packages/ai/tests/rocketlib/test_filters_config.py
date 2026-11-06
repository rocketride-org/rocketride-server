# =============================================================================
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

"""``IGlobalBase.config``, ``IInstanceBase.settings``, ``IValidatorBase`` and the methods-only IGlobal facade."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
import rocketlib.engine
from rocketlib.config import ConfigError, ConfigView, TenancyViolation
from rocketlib.filters import IGlobalBase, IInstanceBase, IValidatorBase

from tests.rocketlib.schemas import DEPTH_ESTIMATE, multitenant

# ==== Fixtures ===============================================================

SCHEMAS = {'depth_estimate': DEPTH_ESTIMATE, 'depth_estimate_mt': multitenant(DEPTH_ESTIMATE)}


@pytest.fixture(autouse=True)
def _engine_schemas(monkeypatch):
    """Serve the fixture schemas where the engine would serve the resolved one."""
    monkeypatch.setattr(rocketlib.engine, 'getServiceSchema', lambda logical_type: SCHEMAS.get(logical_type))


class _Global(IGlobalBase):
    """A node global the way the engine builds it: glb set before beginGlobal."""

    def __init__(self, logical_type: str = 'depth_estimate', conn_config=None):
        self.glb = SimpleNamespace(logicalType=logical_type, connConfig=conn_config or {})
        self.counter = 0

    def bump(self) -> int:
        self.counter += 1
        return self.counter


class _Instance(IInstanceBase):
    """A node instance the way the engine builds it: instance + IGlobal assigned by C++."""

    def __init__(self, glb: _Global, node_id: str = 'depth_estimate_1'):
        self.instance = SimpleNamespace(pipeType=SimpleNamespace(id=node_id))
        self.IGlobal = glb


class _MethodsOnlyInstance(_Instance):
    """A certified node that opted into the methods-only facade."""

    iglobal_methods_only = True


# ==== IGlobalBase.config =====================================================


class TestGlobalConfig:
    """Lazy, cached, flattened, and refusing per-caller keys with a teaching message."""

    def test_lazy_and_cached(self):
        glb = _Global(conn_config={'model': 'tiny'})
        assert glb._config_view is None
        first = glb.config
        assert isinstance(first, ConfigView)
        assert first.model == 'tiny'
        assert glb.config is first

    def test_typo_is_attribute_error(self):
        with pytest.raises(AttributeError, match='"mdoel" is not a config key'):
            _Global().config.mdoel

    def test_param_key_refused_with_teaching_error(self):
        with pytest.raises(TenancyViolation, match='"maxEdge" is a parameter; read it from self.settings in IInstance'):
            _Global().config.maxEdge

    def test_env_valued_key_served_on_uncertified_node(self):
        assert _Global().config.apikey == '${ROCKETRIDE_DEPTH_APIKEY}'

    def test_env_valued_key_refused_on_multitenant_node(self):
        with pytest.raises(TenancyViolation, match='"apikey" is set from the caller\'s environment'):
            _Global('depth_estimate_mt').config.apikey

    def test_invalid_config_fails_at_resolve(self):
        with pytest.raises(ConfigError, match='unknown config key "mdoel"'):
            _Global(conn_config={'mdoel': 'x'}).config

    def test_unknown_service(self):
        with pytest.raises(ConfigError, match='The service nope was not found'):
            _Global('nope').config

    def test_resolved_accessor_serves_everything(self):
        full = _Global(conn_config={'maxEdge': 128})._resolved()
        assert full.maxEdge == 128
        assert full.apikey == '${ROCKETRIDE_DEPTH_APIKEY}'


# ==== IValidatorBase =========================================================


class TestValidatorBase:
    """The default IValidator: resolving self.config is the schema validation."""

    def test_valid_config_passes(self):
        validator = IValidatorBase()
        validator.glb = SimpleNamespace(logicalType='depth_estimate', connConfig={'maxEdge': 128})
        validator.validateConfig()
        validator.validateConfig(True)

    def test_invalid_config_raises(self):
        validator = IValidatorBase()
        validator.glb = SimpleNamespace(logicalType='depth_estimate', connConfig={'maxEdge': 9000})
        with pytest.raises(ConfigError, match='"maxEdge" must be <= 4096'):
            validator.validateConfig()


# ==== IInstanceBase.settings =================================================


class TestInstanceSettings:
    """Per call: config + env expansion + the node's filtered params, read from the stamped self._caller."""

    def test_param_key_readable_via_settings(self):
        inst = _Instance(_Global())
        inst._caller = {'params': {'depth_estimate_1': {'maxEdge': 1024}}, 'env': {}}
        assert inst.settings.maxEdge == 1024
        assert inst.settings['maxEdge'] == 1024

    def test_params_apply_to_this_node_only(self):
        inst = _Instance(_Global())
        inst._caller = {'params': {'other_node': {'maxEdge': 1024}}}
        assert inst.settings.maxEdge == 640

    def test_env_expanded_from_caller(self):
        inst = _Instance(_Global())
        inst._caller = {'env': {'ROCKETRIDE_DEPTH_APIKEY': 'sk-caller'}}
        assert inst.settings.apikey == 'sk-caller'

    def test_two_callers_same_instance_see_their_own_values(self):
        glb = _Global()
        inst = _Instance(glb)
        inst._caller = {'params': {'depth_estimate_1': {'maxEdge': 640}}, 'env': {'ROCKETRIDE_DEPTH_APIKEY': 'a'}}
        assert (inst.settings.maxEdge, inst.settings.apikey) == (640, 'a')
        inst._caller = None
        inst._caller = {'params': {'depth_estimate_1': {'maxEdge': 1024}}, 'env': {'ROCKETRIDE_DEPTH_APIKEY': 'b'}}
        inst._settings = None
        assert (inst.settings.maxEdge, inst.settings.apikey) == (1024, 'b')
        assert glb._resolved().maxEdge == 640

    def test_no_context_is_plain_config(self):
        inst = _Instance(_Global(conn_config={'maxEdge': 128}))
        assert inst.settings.maxEdge == 128
        assert inst.settings.apikey == '${ROCKETRIDE_DEPTH_APIKEY}'

    def test_caller_and_cache_default_to_none_on_the_base(self):
        assert IInstanceBase._caller is None
        assert IInstanceBase._settings is None
        assert _Instance(_Global())._caller is None

    def test_cache_survives_caller_cleared_at_putpipe(self):
        inst = _Instance(_Global())
        inst._caller = {'params': {'depth_estimate_1': {'maxEdge': 1024}}}
        cached = inst.settings
        inst._caller = None
        assert inst.settings is cached
        assert inst.settings.maxEdge == 1024

    def test_cache_returned_while_not_reset(self):
        inst = _Instance(_Global())
        inst._caller = {'params': {'depth_estimate_1': {'maxEdge': 1024}}}
        assert inst.settings is inst.settings
        inst._caller = {'params': {'depth_estimate_1': {'maxEdge': 256}}}
        assert inst.settings.maxEdge == 1024

    def test_cache_reset_by_a_new_stamp(self):
        inst = _Instance(_Global())
        inst._caller = {'params': {'depth_estimate_1': {'maxEdge': 1024}}}
        assert inst.settings.maxEdge == 1024
        inst._caller = {'params': {'depth_estimate_1': {'maxEdge': 256}}}
        inst._settings = None
        assert inst.settings.maxEdge == 256
        inst._caller = None
        inst._settings = None
        assert inst.settings.maxEdge == 640

    def test_settings_never_refuse(self):
        inst = _Instance(_Global('depth_estimate_mt'))
        inst._caller = {'env': {'ROCKETRIDE_DEPTH_APIKEY': 'sk'}}
        assert inst.settings.apikey == 'sk'
        assert inst.settings.maxEdge == 640

    def test_settings_bypass_methods_only_facade(self):
        inst = _MethodsOnlyInstance(_Global())
        inst._caller = {'params': {'depth_estimate_1': {'maxEdge': 1024}}}
        assert inst.settings.maxEdge == 1024

    def test_settings_before_iglobal_bound(self):
        inst = _Instance.__new__(_Instance)
        inst.instance = SimpleNamespace(pipeType=SimpleNamespace(id='x'))
        with pytest.raises(AttributeError):
            inst.settings


# ==== Methods-only IGlobal facade ============================================


class TestIGlobalFacade:
    """Opt-in: callables pass through, data reads and writes raise, whitelist reaches through."""

    def test_default_is_the_raw_global(self):
        glb = _Global()
        inst = _Instance(glb)
        assert inst.IGlobal is glb
        assert inst.IGlobal.counter == 0

    def test_methods_run_with_the_real_self(self):
        glb = _Global()
        inst = _MethodsOnlyInstance(glb)
        assert inst.IGlobal.bump() == 1
        assert glb.counter == 1

    def test_data_read_raises_teaching_error(self):
        inst = _MethodsOnlyInstance(_Global())
        with pytest.raises(TenancyViolation, match='IGlobal.counter is shared state read from an instance'):
            inst.IGlobal.counter

    def test_config_read_through_facade_raises(self):
        inst = _MethodsOnlyInstance(_Global())
        with pytest.raises(TenancyViolation):
            inst.IGlobal.config

    def test_writes_raise(self):
        inst = _MethodsOnlyInstance(_Global())
        with pytest.raises(TenancyViolation, match='cannot set IGlobal.counter'):
            inst.IGlobal.counter = 5
        with pytest.raises(TenancyViolation):
            del inst.IGlobal.counter

    def test_whitelist_reaches_through(self):
        glb = _Global()
        glb.tool_description = 'A database of world cities'
        inst = _MethodsOnlyInstance(glb)
        assert inst.IGlobal.glb.logicalType == 'depth_estimate'
        assert inst.IGlobal.tool_description == 'A database of world cities'
        assert inst._tool_config_description() == 'A database of world cities'

    def test_whitelist_missing_attribute_is_attribute_error(self):
        inst = _MethodsOnlyInstance(_Global())
        assert getattr(inst.IGlobal, 'tool_description', None) is None

    def test_class_level_access_is_none(self):
        assert IInstanceBase.IGlobal is None
        assert _MethodsOnlyInstance.IGlobal is None

    def test_reassignment_and_delete(self):
        first, second = _Global(), _Global()
        inst = _Instance(first)
        inst.IGlobal = second
        assert inst.IGlobal is second
        del inst.IGlobal
        assert inst.IGlobal is None
