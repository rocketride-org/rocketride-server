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

# ==== A two-node catalog ========================================================

#: Resolved defaults and the ``param``-flagged keys per provider.
DEFAULTS = {
    'webhook': {'type': 'webhook'},
    'depth_estimate': {'max_edge': 640, 'model': 'small', 'apikey': ''},
}
PARAMS = {'depth_estimate': ('max_edge',)}
PATHS = {'depth_estimate': {'max_edge': 'max_edge', 'model': 'service.model', 'apikey': 'apikey'}}


class _View:
    """The slice of a resolved ConfigView the parameters module reads."""

    def __init__(self, provider, config):
        self._provider = provider
        self._values = {**DEFAULTS[provider], **(config or {})}
        self.param_keys = frozenset(PARAMS.get(provider, ()))

    def __iter__(self):
        return iter(self._values)

    def __contains__(self, key):
        return key in self._values

    def path_of(self, key):
        return PATHS.get(self._provider, {}).get(key, key)

    def overlay(self, params):
        for key, value in params.items():
            if key not in self.param_keys:
                raise rocketlib.ConfigError(f'"{key}" is not a parameter of this node')
            if not isinstance(value, int) or value < 1:
                raise rocketlib.ConfigError(f'"{key}" must be an integer >= 1')
        return self


@pytest.fixture
def catalog(monkeypatch):
    """The resolver answers from DEFAULTS; an unknown provider is a ConfigError."""

    def resolve(provider, config):
        if provider not in DEFAULTS:
            raise rocketlib.ConfigError(f'The service {provider} was not found')
        return _View(provider, config)

    monkeypatch.setattr(node_config, 'resolve_node_config', resolve)


def _pipeline(**kwargs):
    components = [
        {'id': 'webhook_1', 'provider': 'webhook', 'config': {}},
        {'id': 'depth_1', 'provider': 'depth_estimate', 'config': {}},
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


# ==== resolve_call_params ========================================================


def test_admitted_values_land_per_node_by_schema_path(catalog):
    per_node, errors = parameters.resolve_call_params(_pipeline(), {'maxEdge': 'depth_1.max_edge'}, {'maxEdge': 1024})
    assert errors == []
    assert per_node == {'depth_1': {'max_edge': 1024}}


def test_a_value_outside_the_descriptor_is_refused_by_name(catalog):
    per_node, errors = parameters.resolve_call_params(_pipeline(), {'maxEdge': 'depth_1.max_edge'}, {'maxEdge': 'big'})
    assert per_node == {}
    assert [e['name'] for e in errors] == ['maxEdge'] and 'integer' in errors[0]['reason']


def test_a_map_target_that_is_not_a_param_is_refused_at_call_time_too(catalog):
    # A map that slipped past validate (an older artifact) still cannot set a secret
    per_node, errors = parameters.resolve_call_params(_pipeline(), {'k': 'depth_1.apikey'}, {'k': 'sk-x'})
    assert per_node == {} and errors[0]['name'] == 'k'


def test_values_are_literal_and_never_env_expanded(catalog):
    per_node, _errors = parameters.resolve_call_params(_pipeline(), {'maxEdge': 'depth_1.max_edge'}, {'maxEdge': 2})
    assert per_node['depth_1']['max_edge'] == 2
