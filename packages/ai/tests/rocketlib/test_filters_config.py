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

"""``IGlobalBase.config``, ``IInstanceBase.settings`` and ``IValidatorBase``: one IGlobal per control."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
import rocketlib.engine
from rocketlib.config import ConfigError, ConfigView, NodeInfo
from rocketlib.filters import IGlobalBase, IInstanceBase, IValidatorBase

from tests.rocketlib.schemas import CAP_GPU, DEPTH_ESTIMATE

# ==== Fixtures ===============================================================

SCHEMAS = {'depth_estimate': DEPTH_ESTIMATE}


@pytest.fixture(autouse=True)
def _engine_schemas(monkeypatch):
    """Serve the fixture schemas where the engine would serve the resolved one."""
    monkeypatch.setattr(rocketlib.engine, 'getServiceSchema', lambda logical_type: SCHEMAS.get(logical_type))


class _Global(IGlobalBase):
    """A node global the way the engine builds it for ONE control: glb set before beginGlobal."""

    def __init__(
        self,
        logical_type: str = 'depth_estimate',
        conn_config=None,
        control_id: str = 'control-1',
        node_id: str = 'depth_estimate_1',
        name: str = 'Depth estimate',
        capabilities: int = 0,
    ):
        # glb as the engine stamps it: the config.node identity fields and
        # connConfig, the control's configuration as an owned dict
        self.glb = SimpleNamespace(
            controlId=control_id,
            id=node_id,
            name=name,
            logicalType=logical_type,
            physicalType='python',
            capabilities=capabilities,
            connConfig=conn_config or {},
        )
        self.counter = 0

    def bump(self) -> int:
        self.counter += 1
        return self.counter


class _Instance(IInstanceBase):
    """A node instance the way the engine builds it: instance + its control's IGlobal assigned by C++."""

    def __init__(self, glb: _Global, node_id: str = 'depth_estimate_1'):
        self.instance = SimpleNamespace(pipeType=SimpleNamespace(id=node_id))
        self.IGlobal = glb


# ==== IGlobalBase.config =====================================================


class TestGlobalConfig:
    """Lazy, cached, flattened, the control's own values; refusing a per-call key with a teaching message."""

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
        with pytest.raises(ConfigError, match='"maxEdge" is a parameter; read it from self.settings in IInstance'):
            _Global().config.maxEdge
        with pytest.raises(ConfigError):
            _Global().config['maxEdge']

    def test_env_valued_key_is_served_as_the_server_delivered_it(self):
        # The server expands ${ROCKETRIDE_*} from the control's environment
        # before the config reaches the engine: the global reads a value
        assert _Global(conn_config={'apikey': 'sk-control'}).config.apikey == 'sk-control'

    def test_a_placeholder_the_server_left_is_served_as_written(self):
        assert _Global().config.apikey == '${ROCKETRIDE_DEPTH_APIKEY}'

    def test_two_controls_two_globals_two_configs(self):
        a = _Global(conn_config={'model': 'tiny', 'apikey': 'sk-a'}, control_id='control-a')
        b = _Global(conn_config={'model': 'base', 'apikey': 'sk-b'}, control_id='control-b')
        assert (a.glb.controlId, a.config.model, a.config.apikey) == ('control-a', 'tiny', 'sk-a')
        assert (b.glb.controlId, b.config.model, b.config.apikey) == ('control-b', 'base', 'sk-b')

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
        validator.glb = SimpleNamespace(controlId='', logicalType='depth_estimate', connConfig={'maxEdge': 128})
        validator.validateConfig()
        validator.validateConfig(True)

    def test_invalid_config_raises(self):
        validator = IValidatorBase()
        validator.glb = SimpleNamespace(controlId='', logicalType='depth_estimate', connConfig={'maxEdge': 9000})
        with pytest.raises(ConfigError, match='"maxEdge" must be <= 4096'):
            validator.validateConfig()


# ==== IInstanceBase.settings =================================================


class TestInstanceSettings:
    """Per call: the control's config + the node's filtered params, read from the stamped self._caller."""

    def test_param_key_readable_via_settings(self):
        inst = _Instance(_Global())
        inst._caller = {'controlId': 'control-1', 'params': {'depth_estimate_1': {'maxEdge': 1024}}}
        assert inst.settings.maxEdge == 1024
        assert inst.settings['maxEdge'] == 1024

    def test_params_apply_to_this_node_only(self):
        inst = _Instance(_Global())
        inst._caller = {'params': {'other_node': {'maxEdge': 1024}}}
        assert inst.settings.maxEdge == 640

    def test_settings_are_the_controls_config_plus_params(self):
        inst = _Instance(_Global(conn_config={'apikey': 'sk-control'}))
        inst._caller = {'params': {'depth_estimate_1': {'maxEdge': 1024}}}
        assert (inst.settings.apikey, inst.settings.maxEdge) == ('sk-control', 1024)

    def test_no_context_is_the_controls_config(self):
        inst = _Instance(_Global(conn_config={'maxEdge': 128}))
        assert inst.settings.maxEdge == 128
        assert inst.settings.apikey == '${ROCKETRIDE_DEPTH_APIKEY}'

    def test_instances_of_two_controls_read_their_own_global(self):
        a = _Global(conn_config={'model': 'tiny'}, control_id='control-a')
        b = _Global(conn_config={'model': 'base'}, control_id='control-b')
        inst_a, inst_b = _Instance(a), _Instance(b)
        inst_a._caller = {'controlId': 'control-a'}
        inst_b._caller = {'controlId': 'control-b'}
        assert inst_a.IGlobal is a and inst_b.IGlobal is b
        assert (inst_a.settings.model, inst_b.settings.model) == ('tiny', 'base')

    def test_iglobal_is_the_plain_object(self):
        # No facade: an instance reaches only its own control's IGlobal, so
        # its data is read and written directly
        glb = _Global()
        inst = _Instance(glb)
        assert inst.IGlobal is glb
        assert inst.IGlobal.bump() == 1
        assert inst.IGlobal.counter == 1
        inst.IGlobal.counter = 5
        assert glb.counter == 5
        assert IInstanceBase.IGlobal is None

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
        inst = _Instance(_Global(conn_config={'apikey': 'sk-control'}))
        assert inst.settings.apikey == 'sk-control'
        assert inst.settings.maxEdge == 640

    def test_settings_do_not_touch_the_globals_cached_config(self):
        glb = _Global()
        inst = _Instance(glb)
        inst._caller = {'params': {'depth_estimate_1': {'maxEdge': 1024}}}
        assert inst.settings.maxEdge == 1024
        assert glb._resolved().maxEdge == 640
        with pytest.raises(ConfigError):
            glb.config.maxEdge

    def test_settings_before_iglobal_bound(self):
        inst = _Instance.__new__(_Instance)
        inst.instance = SimpleNamespace(pipeType=SimpleNamespace(id='x'))
        with pytest.raises(AttributeError):
            inst.settings


class TestNodeRecord:
    """``config.node``: the identity the engine stamps on glb, read through the view (plan 5.6.4)."""

    def test_record_from_glb(self):
        glb = _Global(node_id='depth_7', name='Depth seven', capabilities=CAP_GPU)
        assert glb.config.node == NodeInfo(
            id='depth_7',
            name='Depth seven',
            provider='depth_estimate',
            physicalType='python',
            capabilities=CAP_GPU,
            controlId='control-1',
        )

    def test_name_defaults_to_the_id(self):
        glb = _Global(node_id='depth_7', name='')
        assert glb.config.node.name == 'depth_7'

    def test_settings_carry_the_record(self):
        inst = _Instance(_Global())
        inst._caller = {'params': {'depth_estimate_1': {'maxEdge': 1024}}}
        assert inst.settings.node == inst.IGlobal.config.node
        assert inst.settings.node.id == 'depth_estimate_1'
        assert inst.settings.maxEdge == 1024

    def test_settings_key_params_by_config_node_id(self):
        # The old spelling (instance.pipeType.id) names another id on purpose:
        # the params that apply are the ones keyed by config.node.id
        glb = _Global(node_id='renamed_node')
        inst = _Instance(glb, node_id='depth_estimate_1')
        inst._caller = {'params': {'renamed_node': {'maxEdge': 1024}, 'depth_estimate_1': {'maxEdge': 256}}}
        assert inst.settings.maxEdge == 1024

    def test_old_spellings_still_answer(self):
        # Until C.24 moves the reads, glb.* and instance.pipeType.* keep working
        glb = _Global()
        inst = _Instance(glb)
        assert glb.glb.logicalType == 'depth_estimate'
        assert glb.glb.physicalType == 'python'
        assert inst.instance.pipeType.id == 'depth_estimate_1'

    def test_validator_record_has_no_control(self):
        validator = IValidatorBase()
        validator.glb = SimpleNamespace(
            controlId='',
            id='depth_estimate',
            name='',
            logicalType='depth_estimate',
            physicalType='python',
            capabilities=0,
            connConfig={},
        )
        validator.validateConfig()
        assert validator.config.node == NodeInfo(
            id='depth_estimate',
            name='depth_estimate',
            provider='depth_estimate',
            physicalType='python',
            capabilities=0,
            controlId='',
        )
