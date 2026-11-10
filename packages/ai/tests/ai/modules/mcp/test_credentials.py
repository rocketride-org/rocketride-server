# Copyright 2026 Aparavi Software AG. MIT License.
import pytest

from ai.modules.mcp import credentials as creds

# A service definition as `getServices` emits it: the credential is declared
# by the property itself, via "env".
DEFINITIONS = {
    'store_qdrant': {
        'title': 'Qdrant',
        'documentation': 'https://qdrant.tech/documentation/',
        'properties': [
            {
                'name': 'url',
                'title': 'Cluster URL',
                'type': 'string',
                'env': 'ROCKETRIDE_QDRANT_URL',
            },
            {
                'name': 'apikey',
                'title': 'API key',
                'type': 'string',
                'secret': True,
                'env': 'ROCKETRIDE_QDRANT_APIKEY',
            },
        ],
    },
}


def _spec():
    return creds.catalog_from_definitions(DEFINITIONS)['store_qdrant']


def test_exact_match_is_configured_with_wiring():
    state = creds.evaluate(_spec(), ['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY'])
    assert state['status'] == 'configured'
    assert state['wiring'] == {
        'url': '${ROCKETRIDE_QDRANT_URL}',
        'apikey': '${ROCKETRIDE_QDRANT_APIKEY}',
    }
    assert state['missing'] == []


def test_partial_match_lists_missing_and_is_unconfirmed():
    state = creds.evaluate(_spec(), ['ROCKETRIDE_QDRANT_URL'])
    assert state['status'] == 'unconfirmed'
    assert state['missing'] == ['ROCKETRIDE_QDRANT_APIKEY']
    assert state['wiring'] is None


def test_token_candidate_makes_unconfirmed():
    state = creds.evaluate(_spec(), ['ROCKETRIDE_QDRANT_PROD_KEY', 'ROCKETRIDE_ANTHROPIC_KEY'])
    assert state['status'] == 'unconfirmed'
    assert state['candidates'] == ['ROCKETRIDE_QDRANT_PROD_KEY']


def test_no_candidates_is_available():
    state = creds.evaluate(_spec(), ['ROCKETRIDE_ANTHROPIC_KEY'])
    assert state['status'] == 'available'
    assert state['candidates'] == []


def test_candidate_match_requires_part_boundary():
    """GIT must match GITHUB_TOKEN/GIT_PAT (part starts with token) but never
    DIGITALOCEAN_TOKEN (DI**GIT**ALOCEAN is a mid-part substring) — a wrong
    candidate is worse than none, because it gets proposed as a binding.
    """
    definitions = {
        'tool_git': {
            'title': 'tool_git',
            'properties': [
                {'name': 'token', 'type': 'string', 'secret': True, 'env': 'ROCKETRIDE_GIT_TOKEN'},
            ],
        },
    }
    spec = creds.catalog_from_definitions(definitions)['tool_git']

    state = creds.evaluate(spec, ['GITHUB_TOKEN', 'GIT_PAT', 'DIGITALOCEAN_TOKEN'])
    assert state['status'] == 'unconfirmed'
    assert state['candidates'] == ['GITHUB_TOKEN', 'GIT_PAT']

    state = creds.evaluate(spec, ['DIGITALOCEAN_TOKEN'])
    assert state['status'] == 'available'
    assert state['candidates'] == []


def test_env_error_is_unconfirmed_never_available():
    state = creds.evaluate(_spec(), None)
    assert state['status'] == 'unconfirmed'
    assert state['env_error'] is True


def test_node_tokens_drop_generic_prefixes():
    assert creds.node_tokens('store_qdrant') == frozenset({'QDRANT'})
    assert creds.node_tokens('llm_anthropic') == frozenset({'ANTHROPIC'})
    assert 'FALKORDB' in creds.node_tokens('graph_falkordb')


async def test_fetch_env_keys_swallows_errors():
    class Boom:
        async def get_environment_keys(self):
            raise RuntimeError('scope denied')

    assert await creds.fetch_env_keys(Boom()) is None


def test_setup_block_names_variables_and_how():
    block = creds.setup_block(_spec())
    assert block['variables'] == ['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY']
    assert 'rocketride' in block['how'].lower()
    assert block['docs'] == 'https://qdrant.tech/documentation/'


def test_node_without_env_is_not_an_integration():
    """A node with no credential needs no setup, so it must not show up as an
    integration the caller has to configure.
    """
    catalog = creds.catalog_from_definitions(
        {'tool_chartjs': {'title': 'Chart.js', 'properties': [{'name': 'theme', 'type': 'string'}]}}
    )
    assert catalog == {}


def test_env_found_inside_enum_branch_group_and_array():
    """Credentials are collected wherever the author put them: an enum branch
    (one auth mode needs a token, another does not), a group, or an array
    item. A flat scan of top-level properties alone would miss all three.
    """
    catalog = creds.catalog_from_definitions(
        {
            'tool_thing': {
                'title': 'Thing',
                'properties': [
                    {
                        'name': 'authType',
                        'type': 'string',
                        'enum': {
                            'cloud': {
                                'title': 'Cloud',
                                'properties': [
                                    {'name': 'pat', 'path': 'cloud.pat', 'secret': True, 'env': 'ROCKETRIDE_THING_PAT'}
                                ],
                            },
                            'local': {'title': 'Local', 'properties': [{'name': 'endpoint'}]},
                        },
                    },
                    {
                        'name': 'advanced',
                        'properties': [{'name': 'seed', 'path': 'advanced.seed', 'env': 'ROCKETRIDE_THING_SEED'}],
                    },
                    {
                        'name': 'hosts',
                        'type': 'array',
                        'item': {'name': 'hostKey', 'secret': True, 'env': 'ROCKETRIDE_THING_HOST_KEY'},
                    },
                ],
            }
        }
    )
    fields = catalog['tool_thing'].fields
    # A nested leaf is reported at the `path` the schema stamps on it - that is
    # where the resolver reads the value - while a leaf without one (the array
    # item) falls back to its bare name.
    assert {f.path for f in fields} == {'cloud.pat', 'advanced.seed', 'hostKey'}
    assert {f.suggests for f in fields} == {
        'ROCKETRIDE_THING_PAT',
        'ROCKETRIDE_THING_SEED',
        'ROCKETRIDE_THING_HOST_KEY',
    }
    # `secret` decides kind; an env-carrying plain setting is not a secret.
    assert {f.path: f.kind for f in fields} == {'cloud.pat': 'secret', 'advanced.seed': 'text', 'hostKey': 'secret'}


# ==== Wiring shape ===========================================================


def _nested_spec():
    """A node whose only credential sits inside the `cloud` branch."""
    return creds.catalog_from_definitions(
        {
            'tool_thing': {
                'title': 'Thing',
                'properties': [
                    {
                        'name': 'authType',
                        'type': 'string',
                        'enum': {
                            'cloud': {
                                'properties': [
                                    {
                                        'name': 'apikey',
                                        'path': 'cloud.apikey',
                                        'secret': True,
                                        'env': 'ROCKETRIDE_THING_APIKEY',
                                    }
                                ],
                            },
                        },
                    }
                ],
            }
        }
    )['tool_thing']


def test_nest_wiring_materialises_the_path_as_a_tree():
    assert creds.nest_wiring({'cloud.apikey': '${A}', 'cloud.region': '${B}', 'url': '${C}'}) == {
        'cloud': {'apikey': '${A}', 'region': '${B}'},
        'url': '${C}',
    }


def test_nest_wiring_leaves_top_level_paths_alone():
    assert creds.nest_wiring({'url': '${A}', 'apikey': '${B}'}) == {'url': '${A}', 'apikey': '${B}'}


def test_nest_wiring_rejects_a_leaf_that_is_also_a_group():
    with pytest.raises(ValueError, match='cloud'):
        creds.nest_wiring({'cloud': '${A}', 'cloud.apikey': '${B}'})
    with pytest.raises(ValueError, match='cloud'):
        creds.nest_wiring({'cloud.apikey': '${B}', 'cloud': '${A}'})


def test_a_leaf_with_a_non_string_path_or_env_is_left_out_not_fatal():
    out = []
    creds._walk_properties(
        [
            {'name': 'ok', 'env': 'ROCKETRIDE_OK', 'path': 'ok'},
            {'name': 'bad_path', 'env': 'ROCKETRIDE_BAD', 'path': 7},
            {'name': 'bad_env', 'env': ['ROCKETRIDE_LIST'], 'path': 'bad_env'},
            {'name': 'group', 'properties': [{'name': 'inner', 'env': 'ROCKETRIDE_INNER', 'path': 'group.inner'}]},
        ],
        out,
    )
    assert [f.path for f in out] == ['ok', 'group.inner']


def test_a_credential_path_collision_degrades_that_node_instead_of_failing(caplog):
    # A group and its child both carrying env: the tree cannot hold both; the
    # node is reported unconfirmed, the listing survives
    spec = creds.Integration(
        name='odd_node',
        title='Odd',
        docs='',
        fields=(
            creds.CredField(path='cloud', title='Cloud', kind='text', required=True, suggests='ROCKETRIDE_ODD_CLOUD'),
            creds.CredField(
                path='cloud.apikey', title='Key', kind='secret', required=True, suggests='ROCKETRIDE_ODD_KEY'
            ),
        ),
    )
    state = creds.evaluate(spec, ['ROCKETRIDE_ODD_CLOUD', 'ROCKETRIDE_ODD_KEY'])
    assert state['status'] == 'unconfirmed'
    assert state['wiring'] is None
    assert state['candidates'] == [], 'candidates are variable names a caller may bind, never paths'
    assert 'credential paths collide' in state['definition_error']
    assert 'credential paths collide' in caplog.text
    shaped = creds.describe_state(spec, state)
    assert shaped['status'] == 'unconfirmed' and 'setup' in shaped
    assert shaped['definition_error'] == state['definition_error'], (
        'the caller must see the defect is in the definition'
    )


def test_configured_wiring_is_nested_where_the_resolver_and_encrypt_walk_read():
    """A caller copying `wiring` into config.parameters must land the secret at
    its nested path: that is where the engine's encrypt walk looks for it.
    """
    state = creds.evaluate(_nested_spec(), ['ROCKETRIDE_THING_APIKEY'])
    assert state['status'] == 'configured'
    assert state['wiring'] == {'cloud': {'apikey': '${ROCKETRIDE_THING_APIKEY}'}}


def test_resolver_refuses_a_flat_dotted_leaf_so_the_wiring_must_nest():
    """Pins WHY the wiring is nested: the engine's encrypt walk descends object by
    object, so a secret written as one flat dotted key would stay plaintext. The
    resolver therefore refuses the flat form outright; nesting is the only shape.
    """
    from rocketlib.config import ConfigError, resolveConfig

    from tests.rocketlib.schemas import GOOGLE_WORKSPACE

    nested = resolveConfig(GOOGLE_WORKSPACE, {'service': {'adminEmail': 'a@b', 'serviceKey': 'k'}})
    assert nested.serviceKey == 'k'
    with pytest.raises(ConfigError, match='"service.serviceKey" must be written nested'):
        resolveConfig(GOOGLE_WORKSPACE, {'service': {'adminEmail': 'a@b'}, 'service.serviceKey': 'k'})


# ==== Array-row credentials ==================================================


@pytest.mark.parametrize(
    'required_setting', [{}, {'required': True}, {'required': False}], ids=['omitted', 'true', 'false']
)
@pytest.mark.parametrize('row_variable_present', [False, True], ids=['variable_absent', 'variable_present'])
def test_array_row_credential_is_described_but_never_required_or_wired(required_setting, row_variable_present):
    """A credential the node reads inside list rows (an array item's property) must not
    gate readiness, request setup, or produce a top-level binding the node would
    ignore; it stays described so its variable name is discoverable. The
    item's own `required` cannot override this, whatever it says.
    """
    definitions = {
        'tool_x': {
            'title': 'X',
            'properties': [
                {'name': 'token', 'title': 'Token', 'secret': True, 'env': 'ROCKETRIDE_X_TOKEN'},
                {
                    'name': 'rows',
                    'type': 'array',
                    'item': {
                        'type': 'object',
                        'properties': [
                            {
                                'name': 'rowValue',
                                'path': 'rows.rowValue',
                                'title': 'Row value',
                                'secret': True,
                                'env': 'ROCKETRIDE_X_ROW_VALUE',
                                **required_setting,
                            }
                        ],
                    },
                },
            ],
        }
    }
    spec = creds.catalog_from_definitions(definitions)['tool_x']
    assert [f.auto_wire for f in spec.fields] == [True, False]
    assert [f.required for f in spec.fields] == [True, False]
    assert creds.setup_block(spec)['variables'] == ['ROCKETRIDE_X_TOKEN']
    assert creds.evaluate(spec, [])['missing'] == ['ROCKETRIDE_X_TOKEN']
    env_keys = ['ROCKETRIDE_X_TOKEN']
    if row_variable_present:
        env_keys.append('ROCKETRIDE_X_ROW_VALUE')
    state = creds.evaluate(spec, env_keys)
    assert state['status'] == 'configured'
    assert state['missing'] == []
    assert state['wiring'] == {'token': '${ROCKETRIDE_X_TOKEN}'}
