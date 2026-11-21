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

import copy
from types import SimpleNamespace

import pytest
import rocketlib.engine
from rocketlib.config import ConfigError, ConfigView, NodeInfo
from rocketlib.filters import NO_CALLER, Caller, IGlobalBase, IInstanceBase, IValidatorBase, freeze_caller

from tests.rocketlib.schemas import CAP_GPU, DEPTH_ESTIMATE, DETECTOR

# ==== Fixtures ===============================================================

SCHEMAS = {'depth_estimate': DEPTH_ESTIMATE, 'detector': DETECTOR}


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

    def test_no_caller_until_the_engine_binds_one(self):
        assert IInstanceBase._settings is None
        inst = _Instance(_Global())
        assert inst._caller is None
        assert inst.caller is NO_CALLER
        assert inst.caller.params == {}

    def test_settings_are_computed_once_per_binding(self):
        inst = _Instance(_Global())
        inst._caller = {'params': {'depth_estimate_1': {'maxEdge': 1024}}}
        assert inst.settings is inst.settings
        assert inst.settings.maxEdge == 1024

    def test_a_selector_param_reresolves_settings(self):
        glb = _Global('detector', node_id='detector_1', conn_config={'iqr': {'quantiles': 4}})
        inst = _Instance(glb, node_id='detector_1')
        inst._caller = {'params': {'detector_1': {'method': 'iqr', 'iqr.sensitivity': 0.5}}}
        assert (inst.settings.method, inst.settings.sensitivity, inst.settings.quantiles) == ('iqr', 0.5, 4)
        # The control's IGlobal still answers its own branch
        assert glb._resolved().method == 'z_score'
        with pytest.raises(ConfigError, match='"method" is a parameter'):
            glb.config.method

    def test_a_param_the_call_cannot_reach_fails_at_read(self):
        glb = _Global('detector', node_id='detector_1', conn_config={'iqr': {'quantiles': 4}})
        inst = _Instance(glb, node_id='detector_1')
        inst._caller = {'params': {'detector_1': {'iqr.sensitivity': 0.5}}}
        with pytest.raises(ConfigError, match='under a branch this call does not select'):
            inst.settings


class TestCaller:
    """``self.caller``: bound once by the engine, frozen, read-only (plan 4.1 rule 7)."""

    ENVELOPE = {
        'controlId': '=control/' + 'c' * 32,
        'userId': 'user-1',
        'teamId': 'team-1',
        'orgId': 'org-1',
        'address': 'acme.detect.webhook',
        'rung': 'spec',
        'traceLevel': 'none',
        'correlationId': 'r' * 32,
        'params': {'depth_estimate_1': {'maxEdge': 1024}, 'chunker_1': {'tags': ['a']}},
        'env': {'ROCKETRIDE_DEPTH_APIKEY': 'sk-1'},
        'config': [{'model': 'tiny'}],
    }

    def _bound(self) -> _Instance:
        inst = _Instance(_Global())
        inst._caller = copy.deepcopy(self.ENVELOPE)
        return inst

    def test_frozen_fields(self):
        caller = self._bound().caller
        assert isinstance(caller, Caller)
        assert (caller.userId, caller.teamId, caller.orgId, caller.rung) == ('user-1', 'team-1', 'org-1', 'spec')
        assert (caller.address, caller.traceLevel) == ('acme.detect.webhook', 'none')
        assert caller.params['depth_estimate_1']['maxEdge'] == 1024
        assert caller.env['ROCKETRIDE_DEPTH_APIKEY'] == 'sk-1'
        # The engine's config list is the engine's: it is not part of the caller
        assert not hasattr(caller, 'config')

    def test_a_second_write_raises(self):
        inst = self._bound()
        with pytest.raises(AttributeError, match='bound once'):
            inst._caller = {'userId': 'someone-else'}
        with pytest.raises(AttributeError, match='bound once'):
            inst._caller = None
        assert inst.caller.userId == 'user-1'

    def test_every_assignment_raises(self):
        caller = self._bound().caller
        with pytest.raises(AttributeError):
            caller.userId = 'x'
        with pytest.raises(TypeError):
            caller.params['depth_estimate_1'] = {}
        with pytest.raises(TypeError):
            caller.params['depth_estimate_1']['maxEdge'] = 1
        with pytest.raises(TypeError):
            caller.env['ROCKETRIDE_DEPTH_APIKEY'] = 'stolen'
        with pytest.raises(AttributeError):
            del self._bound()._caller

    def test_the_caller_is_a_private_copy(self):
        envelope = copy.deepcopy(self.ENVELOPE)
        inst = _Instance(_Global())
        inst._caller = envelope
        envelope['userId'] = 'changed'
        envelope['params']['depth_estimate_1']['maxEdge'] = 64
        envelope['params']['chunker_1']['tags'].append('b')
        assert inst.caller.userId == 'user-1'
        assert inst.caller.params['depth_estimate_1']['maxEdge'] == 1024
        assert inst.caller.params['chunker_1']['tags'] == ('a',)

    def test_nested_params_are_read_only_at_every_depth(self):
        frozen = freeze_caller({'params': {'n': {'items': [{'value': 1}], 'limits': {'max': 2}}}})
        with pytest.raises(TypeError):
            frozen.params['n']['items'][0]['value'] = 2
        with pytest.raises(TypeError):
            frozen.params['n']['limits']['max'] = 3
        with pytest.raises(AttributeError):
            frozen.params['n']['items'].append({'value': 3})
        assert frozen.params['n']['items'][0]['value'] == 1

    def test_frozen_arrays_and_objects_still_reach_settings(self):
        glb = _Global('detector', node_id='detector_1', conn_config={'iqr': {'quantiles': 4}})
        inst = _Instance(glb, node_id='detector_1')
        inst._caller = {'params': {'detector_1': {'frames': [1, 2], 'rules': [{'field': 'cpu', 'limit': 9}]}}}
        assert inst.settings.frames == [1, 2]
        assert inst.settings.rules == [{'field': 'cpu', 'limit': 9}]

    def test_freezing_is_idempotent_and_typed(self):
        frozen = freeze_caller(self.ENVELOPE)
        assert freeze_caller(frozen) is frozen
        assert frozen == freeze_caller(copy.deepcopy(self.ENVELOPE))
        with pytest.raises(TypeError):
            freeze_caller(['not', 'a', 'mapping'])

    def test_settings_read_the_frozen_params(self):
        assert self._bound().settings.maxEdge == 1024

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
