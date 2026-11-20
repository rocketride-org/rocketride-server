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
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""The pipeline ``parameters`` map and the per-call values it admits (plan 5.2, 5.4)."""

import pytest
import rocketlib

from ai.common import node_config, parameters
from tests.rocketlib.schemas import DETECTOR

# ==== A three-node catalog: the real resolver over engine-shaped schemas =======

#: Resolved schemas as the engine emits them: a leaf's ``param`` flag lives in
#: the ``params`` descriptors only.
SCHEMAS = {
    'webhook': {
        'properties': [{'name': 'type', 'path': 'type', 'type': 'constant', 'default': 'webhook'}],
        'params': [],
    },
    'depth_estimate': {
        'properties': [
            {'name': 'max_edge', 'path': 'max_edge', 'type': 'integer', 'default': 640, 'minimum': 1},
            {
                'name': 'service',
                'properties': [{'name': 'model', 'path': 'service.model', 'type': 'string', 'default': 'small'}],
            },
            {'name': 'apikey', 'path': 'apikey', 'type': 'string', 'secret': True},
        ],
        'params': [{'field': 'max_edge', 'type': 'integer', 'default': 640, 'minimum': 1, 'tool': True}],
    },
    'detector': DETECTOR,
}


@pytest.fixture
def catalog(monkeypatch):
    """The resolver answers from SCHEMAS; an unknown provider is a ConfigError."""

    def resolve(provider, config):
        if provider not in SCHEMAS:
            raise rocketlib.ConfigError(f'The service {provider} was not found')
        return rocketlib.resolveConfig(SCHEMAS[provider], config)

    monkeypatch.setattr(node_config, 'resolve_node_config', resolve)


def _pipeline(**kwargs):
    components = [
        {'id': 'webhook_1', 'provider': 'webhook', 'config': {}},
        {'id': 'depth_1', 'provider': 'depth_estimate', 'config': {}},
        {'id': 'detect_1', 'provider': 'detector', 'config': {'iqr': {'quantiles': 4}}},
    ]
    return {'project_id': 'docBrain', 'source': 'webhook_1', 'components': components, **kwargs}


# ==== parse_target ==============================================================


def test_parse_target_splits_on_the_first_dot_and_keeps_the_key_path():
    assert parameters.parse_target('depth_1.max_edge') == ('depth_1', 'max_edge')
    assert parameters.parse_target('depth_1.service.model') == ('depth_1', 'service.model')


@pytest.mark.parametrize('target', ['depth_1', 'depth_1.', '.max_edge', 'a..b', {'node': 'depth_1'}, 7, None])
def test_parse_target_refuses_anything_but_two_or_more_segments(target):
    assert parameters.parse_target(target) is None


# ==== validate_parameters =========================================================


def test_a_valid_map_has_no_errors(catalog):
    assert parameters.validate_parameters(_pipeline(parameters={'maxEdge': 'depth_1.max_edge'})) == []
    assert parameters.validate_parameters(_pipeline()) == []


def test_the_map_must_be_an_object(catalog):
    errors = parameters.validate_parameters(_pipeline(parameters=['maxEdge']))
    assert [e['id'] for e in errors] == ['parameters']


@pytest.mark.parametrize('name', ['max-edge', 'max edge', '', 'max.edge'])
def test_public_names_are_identifier_like(catalog, name):
    errors = parameters.validate_parameters(_pipeline(parameters={name: 'depth_1.max_edge'}))
    assert len(errors) == 1 and 'must match' in errors[0]['message']


def test_a_target_must_be_a_node_dot_key_string(catalog):
    errors = parameters.validate_parameters(_pipeline(parameters={'maxEdge': {'node': 'depth_1', 'key': 'max_edge'}}))
    assert len(errors) == 1 and 'nodeId.configKey' in errors[0]['message']


def test_a_target_must_name_an_existing_component(catalog):
    errors = parameters.validate_parameters(_pipeline(parameters={'maxEdge': 'depth_9.max_edge'}))
    assert len(errors) == 1 and 'unknown component' in errors[0]['message']


def test_a_target_must_name_a_config_key_of_the_node(catalog):
    errors = parameters.validate_parameters(_pipeline(parameters={'maxEdge': 'depth_1.nope'}))
    assert errors == [{'id': 'depth_1', 'message': "parameter 'maxEdge': 'depth_1' has no config key 'nope'"}]


def test_a_target_must_be_a_param_flagged_key(catalog):
    # A secret and a plain non-param key are refused the same way: the
    # resolver's param set decides (selectors, secrets and env-valued keys
    # are never in it)
    for key in ('apikey', 'model'):
        errors = parameters.validate_parameters(_pipeline(parameters={'x': f'depth_1.{key}'}))
        assert len(errors) == 1 and 'not a per-call parameter' in errors[0]['message']


def test_a_schema_path_names_the_leaf_too(catalog):
    # 'service.model' is model's path; it resolves, and is then refused as a non-param
    errors = parameters.validate_parameters(_pipeline(parameters={'m': 'depth_1.service.model'}))
    assert len(errors) == 1 and 'not a per-call parameter' in errors[0]['message']


def test_a_component_that_does_not_resolve_is_not_a_second_error(catalog):
    pipeline = _pipeline(parameters={'x': 'ghost_1.key'})
    pipeline['components'].append({'id': 'ghost_1', 'provider': 'unknown_node', 'config': {}})
    assert parameters.validate_parameters(pipeline) == []


def test_a_selector_and_a_leaf_of_any_branch_may_be_exposed(catalog):
    # The stored config selects z_score; the iqr branch's leaf is still a
    # parameter of the node (plan 5.1): the call's selector picks the branch
    mapping = {'method': 'detect_1.method', 'iqrSensitivity': 'detect_1.iqr.sensitivity', 'frames': 'detect_1.frames'}
    assert parameters.validate_parameters(_pipeline(parameters=mapping)) == []
    errors = parameters.validate_parameters(_pipeline(parameters={'q': 'detect_1.iqr.quantiles'}))
    assert len(errors) == 1 and 'not a per-call parameter' in errors[0]['message']


# ==== resolve_call_params ========================================================


def test_admitted_values_land_per_node_by_schema_path(catalog):
    per_node, errors = parameters.resolve_call_params(_pipeline(), {'maxEdge': 'depth_1.max_edge'}, {'maxEdge': 1024})
    assert errors == []
    assert per_node == {'depth_1': {'max_edge': 1024}}


def test_a_value_outside_the_descriptor_is_refused_by_name(catalog):
    per_node, errors = parameters.resolve_call_params(_pipeline(), {'maxEdge': 'depth_1.max_edge'}, {'maxEdge': 'big'})
    assert per_node == {}
    assert [e['name'] for e in errors] == ['maxEdge'] and 'integer' in errors[0]['reason']


def test_two_names_for_one_leaf_never_hide_a_value(catalog):
    aliases = {'goodEdge': 'depth_1.max_edge', 'badEdge': 'depth_1.max_edge'}
    _per_node, errors = parameters.resolve_call_params(_pipeline(), aliases, {'badEdge': 'invalid', 'goodEdge': 640})
    reasons = {e['name']: e['reason'] for e in errors}
    assert 'integer' in reasons['badEdge']
    assert "same config key as 'badEdge'" in reasons['goodEdge']
    # One name of the two is an ordinary call
    per_node, errors = parameters.resolve_call_params(_pipeline(), aliases, {'goodEdge': 640})
    assert errors == [] and per_node == {'depth_1': {'max_edge': 640}}


def test_a_map_target_that_is_not_a_param_is_refused_at_call_time_too(catalog):
    # A map that slipped past validate (an older artifact) still cannot set a secret
    per_node, errors = parameters.resolve_call_params(_pipeline(), {'k': 'depth_1.apikey'}, {'k': 'sk-x'})
    assert per_node == {} and errors[0]['name'] == 'k'


def test_values_are_literal_and_never_env_expanded(catalog):
    per_node, _errors = parameters.resolve_call_params(_pipeline(), {'maxEdge': 'depth_1.max_edge'}, {'maxEdge': 2})
    assert per_node['depth_1']['max_edge'] == 2
    per_node, _errors = parameters.resolve_call_params(
        _pipeline(), {'metric': 'detect_1.criticalThreshold'}, {'metric': 4.0}
    )
    assert per_node == {'detect_1': {'criticalThreshold': 4.0}}


# ==== Selector, branch and array parameters (plan 5.1) =========================

DETECT_MAP = {
    'method': 'detect_1.method',
    'iqrSensitivity': 'detect_1.iqr.sensitivity',
    'zWindow': 'detect_1.z_score.windowSize',
    'frames': 'detect_1.frames',
}


def test_selector_values_apply_first_then_the_branch_leaf_is_reachable(catalog):
    per_node, errors = parameters.resolve_call_params(_pipeline(), DETECT_MAP, {'iqrSensitivity': 0.5, 'method': 'iqr'})
    assert errors == []
    assert per_node == {'detect_1': {'method': 'iqr', 'iqr.sensitivity': 0.5}}


def test_a_leaf_the_calls_branch_set_does_not_reach_is_refused_by_name(catalog):
    # No selector value in the call: the stored branch (z_score) is the set
    per_node, errors = parameters.resolve_call_params(_pipeline(), DETECT_MAP, {'iqrSensitivity': 0.5})
    assert per_node == {}
    assert errors == [{'name': 'iqrSensitivity', 'reason': 'is under a branch this call does not select'}]

    # The call's selector moves the set away from a leaf it also names
    per_node, errors = parameters.resolve_call_params(_pipeline(), DETECT_MAP, {'method': 'iqr', 'zWindow': 50})
    assert per_node == {}
    assert [e['name'] for e in errors] == ['zWindow']


def test_a_selector_whose_branch_does_not_resolve_is_refused_by_name(catalog):
    pipeline = _pipeline()
    pipeline['components'][2]['config'] = {}
    per_node, errors = parameters.resolve_call_params(pipeline, DETECT_MAP, {'method': 'iqr'})
    assert per_node == {}
    assert [e['name'] for e in errors] == ['method']
    assert '"iqr.quantiles" is required' in errors[0]['reason']


def test_an_array_is_one_param_validated_by_its_item(catalog):
    per_node, errors = parameters.resolve_call_params(_pipeline(), DETECT_MAP, {'frames': [1, 456, 712]})
    assert errors == [] and per_node == {'detect_1': {'frames': [1, 456, 712]}}
    per_node, errors = parameters.resolve_call_params(_pipeline(), DETECT_MAP, {'frames': [1, -1]})
    assert per_node == {}
    assert errors[0]['name'] == 'frames' and 'must be >= 0' in errors[0]['reason']


def test_the_views_cache_resolves_each_component_once(catalog, monkeypatch):
    calls = []
    real = node_config.resolve_node_config
    monkeypatch.setattr(node_config, 'resolve_node_config', lambda p, c: calls.append(p) or real(p, c))
    views = {}
    for value in (0.5, 0.6, 0.7):
        per_node, errors = parameters.resolve_call_params(
            _pipeline(), DETECT_MAP, {'method': 'iqr', 'iqrSensitivity': value}, views
        )
        assert errors == [] and per_node['detect_1']['iqr.sensitivity'] == value
    assert calls == ['detector']
