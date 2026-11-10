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

"""The resolver matrix for ``rocketlib.config.resolveConfig`` and ``ConfigView`` (plan §14 Step 2)."""

from __future__ import annotations

import copy

import pytest
from rocketlib.config import ConfigError, ConfigView, TenancyViolation, resolveConfig

from tests.rocketlib.schemas import CAP_GPU, CAP_MULTITENANT, DEPTH_ESTIMATE, GOOGLE_WORKSPACE, QDRANT, multitenant

# ==== Defaults and selectors =================================================


class TestDefaults:
    """Defaults come from the resolved schema and are never written back."""

    def test_defaults_from_schema(self):
        view = resolveConfig(GOOGLE_WORKSPACE, {'service': {'adminEmail': 'admin@example.com'}})
        assert view.authType == 'service'
        assert view.customerId == 'my_customer'
        assert view.access == 'readonly'
        assert view.type == 'tool_google_workspace'

    def test_defaults_never_written_back(self):
        stored = {'service': {'adminEmail': 'admin@example.com'}}
        before = copy.deepcopy(stored)
        view = resolveConfig(GOOGLE_WORKSPACE, stored)
        assert view.customerId == 'my_customer'
        assert stored == before

    def test_undeclared_default_is_none_not_missing(self):
        view = resolveConfig(GOOGLE_WORKSPACE, {'service': {'adminEmail': 'a@b.c'}})
        assert view.serviceKey is None
        assert 'serviceKey' in view

    def test_stored_non_none_wins_over_default(self):
        view = resolveConfig(QDRANT, {'score': 0.25, 'collection': None})
        assert view.score == 0.25
        assert view.collection == 'documents'

    def test_constant_resolves_to_its_default(self):
        view = resolveConfig(QDRANT, {'type': 'anything-the-editor-wrote'})
        assert view.type == 'store_qdrant'

    def test_editor_owned_name_is_tolerated(self):
        view = resolveConfig(QDRANT, {'name': 'My store'})
        assert 'name' not in view

    def test_engine_owned_secure_parameters_section_is_tolerated(self):
        # A saved pipeline carries the engine's encrypted-secret section at the
        # config root; re-validating it must not report it as an unknown key
        stored = {'mode': 'cloud', 'secureParameters': {'secure': ['cloud.apikey.key'], 'token': 'blob'}}
        view = resolveConfig(QDRANT, stored)
        assert 'secureParameters' not in view
        with pytest.raises(ConfigError, match='unknown config key "cloud.secureParameters"'):
            resolveConfig(QDRANT, {'mode': 'cloud', 'cloud': {'secureParameters': {}}})


class TestSelectors:
    """Branch selection, hoisting and nesting."""

    def test_default_branch_selected(self):
        view = resolveConfig(GOOGLE_WORKSPACE, {'service': {'adminEmail': 'a@b.c'}})
        assert set(view) == {'type', 'authType', 'access', 'customerId', 'adminEmail', 'serviceKey'}

    def test_selector_switch_flattens_to_the_other_branch(self):
        view = resolveConfig(GOOGLE_WORKSPACE, {'authType': 'user', 'user': {'userAuth': 'grant-1'}})
        assert view.userAuth == 'grant-1'
        assert 'customerId' not in view
        with pytest.raises(AttributeError):
            view.customerId

    def test_hoisted_leaf_shared_across_branches(self):
        service = resolveConfig(GOOGLE_WORKSPACE, {'access': 'readwrite', 'service': {'adminEmail': 'a@b.c'}})
        user = resolveConfig(GOOGLE_WORKSPACE, {'access': 'readwrite', 'authType': 'user'})
        assert service.access == 'readwrite'
        assert user.access == 'readwrite'
        assert service.path_of('access') == 'access'

    def test_branch_specific_leaf_not_shared(self):
        cloud = resolveConfig(QDRANT, {'cloud': {'host': 'https://x', 'apikey': {'key': 'abcd'}}})
        local = resolveConfig(QDRANT, {'mode': 'local'})
        assert cloud.host == 'https://x'
        assert cloud.path_of('host') == 'cloud.host'
        assert local.host == 'localhost'
        assert local.path_of('host') == 'local.host'
        assert 'port' in local and 'port' not in cloud

    def test_nested_selector(self):
        default = resolveConfig(QDRANT, {'cloud': {'apikey': {'key': 'abcd'}}})
        assert default.auth == 'apikey'
        assert default.key == 'abcd'
        assert 'token' not in default

        switched = resolveConfig(QDRANT, {'cloud': {'auth': 'token', 'token': {'token': 't'}}})
        assert switched.token == 't'
        assert 'key' not in switched

    def test_nested_selector_unreachable_when_outer_branch_not_selected(self):
        local = resolveConfig(QDRANT, {'mode': 'local'})
        assert 'auth' not in local

    def test_stale_selector_value_is_an_error(self):
        with pytest.raises(ConfigError, match='"authType" is set to \'ldap\''):
            resolveConfig(GOOGLE_WORKSPACE, {'authType': 'ldap'})

    def test_params_descriptors_returned(self):
        view = resolveConfig(DEPTH_ESTIMATE, {})
        assert view.params == DEPTH_ESTIMATE['params']
        assert view.param_keys == frozenset({'maxEdge'})


# ==== Hard errors ============================================================


class TestHardErrors:
    """Unknown keys, unreachable-branch keys and out-of-range values are hard errors naming the key."""

    def test_unknown_key(self):
        with pytest.raises(ConfigError, match='unknown config key "mdoel"'):
            resolveConfig(DEPTH_ESTIMATE, {'mdoel': 'x'})

    def test_unknown_nested_key(self):
        with pytest.raises(ConfigError, match='unknown config key "tuning.thread"'):
            resolveConfig(DEPTH_ESTIMATE, {'tuning': {'thread': 3}})

    def test_old_profile_shape_is_unknown(self):
        with pytest.raises(ConfigError, match='unknown config key "profile"'):
            resolveConfig(DEPTH_ESTIMATE, {'profile': 'default', 'default': {'model': 'm'}})

    def test_unreachable_branch_key_is_tolerated(self):
        stored = {'service': {'adminEmail': 'a@b.c'}, 'user': {'userAuth': 'g'}}
        before = copy.deepcopy(stored)
        view = resolveConfig(GOOGLE_WORKSPACE, stored)
        assert 'userAuth' not in view
        assert stored == before
        switched = resolveConfig(GOOGLE_WORKSPACE, {**stored, 'authType': 'user'})
        assert switched.userAuth == 'g'
        assert 'adminEmail' not in switched

    def test_unreachable_nested_branch_key_is_tolerated(self):
        stored = {'cloud': {'apikey': {'key': 'abcd'}, 'token': {'token': 't'}}}
        view = resolveConfig(QDRANT, stored)
        assert view.key == 'abcd'
        assert 'token' not in view
        assert resolveConfig(QDRANT, {'cloud': {**stored['cloud'], 'auth': 'token'}}).token == 't'

    def test_unreachable_branch_value_is_not_validated(self):
        view = resolveConfig(QDRANT, {'mode': 'local', 'cloud': {'apikey': {'key': 'x'}}})
        assert view.host == 'localhost'
        assert 'key' not in view

    def test_out_of_range(self):
        with pytest.raises(ConfigError, match='"maxEdge" must be <= 4096, got 9000'):
            resolveConfig(DEPTH_ESTIMATE, {'maxEdge': 9000})
        with pytest.raises(ConfigError, match='"score" must be >= 0'):
            resolveConfig(QDRANT, {'score': -0.1})

    def test_type_mismatch(self):
        with pytest.raises(ConfigError, match='"maxEdge" expects integer, got str'):
            resolveConfig(DEPTH_ESTIMATE, {'maxEdge': '640'})
        with pytest.raises(ConfigError, match='"tuning.tags" expects array'):
            resolveConfig(DEPTH_ESTIMATE, {'tuning': {'tags': 'a,b'}})

    def test_enum_violation(self):
        with pytest.raises(ConfigError, match='"access" must be one of'):
            resolveConfig(GOOGLE_WORKSPACE, {'access': 'admin', 'service': {'adminEmail': 'a@b.c'}})

    def test_required(self):
        with pytest.raises(ConfigError, match='"service.adminEmail" is required'):
            resolveConfig(GOOGLE_WORKSPACE, {})

    def test_min_length(self):
        with pytest.raises(ConfigError, match='"cloud.apikey.key" must be at least 4 characters'):
            resolveConfig(QDRANT, {'cloud': {'apikey': {'key': 'ab'}}})

    def test_all_problems_reported_together(self):
        with pytest.raises(ConfigError) as info:
            resolveConfig(DEPTH_ESTIMATE, {'maxEdge': 1, 'bogus': True})
        assert '"maxEdge" must be >= 64' in str(info.value)
        assert 'unknown config key "bogus"' in str(info.value)

    def test_an_empty_block_for_a_branch_with_only_hoisted_leaves_is_allowed(self):
        # Every leaf of both branches is hoisted to the selector's level, so no
        # path lies under the branch; a stored empty block for it is still a
        # declared block, not an unknown key
        from tests.rocketlib.schemas import _leaf

        schema = {
            'properties': [
                {
                    'name': 'mode',
                    'path': 'mode',
                    'type': 'string',
                    'default': 'a',
                    'enum': {
                        'a': {'properties': [_leaf('shared', 'shared', type='string', default='x')]},
                        'b.1': {'properties': [_leaf('shared', 'shared', type='string', default='x')]},
                    },
                },
                _leaf('shared', 'shared', type='string', default='x'),
            ],
            'params': [],
            'capabilities': 0,
        }
        assert resolveConfig(schema, {'mode': 'a', 'a': {}, 'b.1': {}}).shared == 'x'
        assert resolveConfig(schema, {'mode': 'b.1', 'b.1': {}}).mode == 'b.1'

    def test_a_flat_dotted_group_key_is_refused(self):
        # "cloud.apikey" written as one key with the leaf beneath it: the
        # encrypt walk would never reach the secret, so the shape is refused
        with pytest.raises(ConfigError, match='"cloud.apikey" must be written nested'):
            resolveConfig(QDRANT, {'mode': 'cloud', 'cloud.apikey': {'key': 'abcd'}})
        with pytest.raises(ConfigError, match='"cloud.apikey.key" must be written nested'):
            resolveConfig(QDRANT, {'mode': 'cloud', 'cloud': {'apikey.key': 'abcd'}})
        assert resolveConfig(QDRANT, {'mode': 'cloud', 'cloud': {'apikey': {'key': 'abcd'}}}).key == 'abcd'

    def test_array_items_validated(self):
        with pytest.raises(ConfigError, match=r'"tuning.tags\[1\]" expects string'):
            resolveConfig(DEPTH_ESTIMATE, {'tuning': {'tags': ['ok', 2]}})

    def test_array_of_scalars_resolves_as_the_list(self):
        # A stored array is a LEAF value, not a nested level: it is kept whole,
        # its elements are checked against the item descriptor, and the default
        # applies when nothing is stored
        view = resolveConfig(DEPTH_ESTIMATE, {'tuning': {'tags': ['fast', 'gpu']}})
        assert view.tags == ['fast', 'gpu']
        assert view['tags'] == ['fast', 'gpu']
        assert resolveConfig(DEPTH_ESTIMATE, {}).tags == []
        assert resolveConfig(DEPTH_ESTIMATE, {'tuning': {'tags': []}}).tags == []


# ==== ConfigView =============================================================


class TestConfigView:
    """Schema-only, read-only, attribute and item access, param and env awareness."""

    @pytest.fixture
    def view(self) -> ConfigView:
        return resolveConfig(DEPTH_ESTIMATE, {'model': 'tiny'})

    def test_attribute_and_item_access(self, view):
        assert view.model == 'tiny'
        assert view['model'] == 'tiny'
        assert view.get('revision') == 'main'

    def test_typo_is_attribute_error(self, view):
        with pytest.raises(AttributeError, match='"mdoel" is not a config key'):
            view.mdoel
        with pytest.raises(KeyError):
            view['mdoel']

    def test_read_only(self, view):
        with pytest.raises(TypeError):
            view.model = 'x'
        with pytest.raises(TypeError):
            view['model'] = 'x'
        with pytest.raises(TypeError):
            del view.model

    def test_knows_param_and_env_keys(self, view):
        assert view.param_keys == frozenset({'maxEdge'})
        assert view.env_keys == frozenset({'apikey'})
        assert view.capabilities == CAP_GPU
        assert not view.capabilities & CAP_MULTITENANT
        assert resolveConfig(multitenant(DEPTH_ESTIMATE), {}).capabilities & CAP_MULTITENANT

    def test_restricted_refuses_param_always(self, view):
        restricted = view.restricted(refuse_params=True, refuse_env=False)
        with pytest.raises(TenancyViolation, match='"maxEdge" is a parameter; read it from self.settings in IInstance'):
            restricted.maxEdge
        with pytest.raises(TenancyViolation):
            restricted['maxEdge']
        assert restricted.apikey == '${ROCKETRIDE_DEPTH_APIKEY}'

    def test_restricted_refuses_env_when_asked(self, view):
        restricted = view.restricted(refuse_params=True, refuse_env=True)
        with pytest.raises(TenancyViolation, match='"apikey" is set from the caller\'s environment'):
            restricted.apikey
        assert restricted.model == 'tiny'

    def test_expand_env(self, view):
        expanded = view.expand_env({'ROCKETRIDE_DEPTH_APIKEY': 'sk-123'})
        assert expanded.apikey == 'sk-123'
        assert expanded.env_keys == frozenset()
        assert view.apikey == '${ROCKETRIDE_DEPTH_APIKEY}'

    def test_expand_env_leaves_unknown_names(self, view):
        assert view.expand_env({'ROCKETRIDE_OTHER': 'x'}).apikey == '${ROCKETRIDE_DEPTH_APIKEY}'

    def test_expand_env_coerces_and_validates(self):
        view = resolveConfig(DEPTH_ESTIMATE, {'maxEdge': '${ROCKETRIDE_EDGE}'})
        assert view.expand_env({'ROCKETRIDE_EDGE': '1024'}).maxEdge == 1024
        with pytest.raises(ConfigError, match='"maxEdge" must be <= 4096'):
            view.expand_env({'ROCKETRIDE_EDGE': '9000'})

    def test_overlay_params_by_path_or_name(self, view):
        assert view.overlay({'maxEdge': 1024}).maxEdge == 1024
        assert view.overlay({view.path_of('maxEdge'): 256}).maxEdge == 256
        assert view.maxEdge == 640

    def test_overlay_refuses_non_param(self, view):
        with pytest.raises(ConfigError, match='"model" is not a parameter'):
            view.overlay({'model': 'other'})
        with pytest.raises(ConfigError, match='"nope" is not a config key'):
            view.overlay({'nope': 1})

    def test_overlay_validates(self, view):
        with pytest.raises(ConfigError, match='"maxEdge" must be <= 4096'):
            view.overlay({'maxEdge': 9000})

    def test_group_leaves_flatten(self, view):
        assert view.threads == 2
        assert view.path_of('threads') == 'tuning.threads'
        assert resolveConfig(DEPTH_ESTIMATE, {'tuning': {'threads': 8}}).threads == 8

    def test_short_name_collision_is_an_error(self):
        schema = copy.deepcopy(DEPTH_ESTIMATE)
        schema['properties'].append({'name': 'threads', 'path': 'threads', 'type': 'integer', 'default': 1})
        with pytest.raises(ConfigError, match='both resolve to "threads"'):
            resolveConfig(schema, {})
