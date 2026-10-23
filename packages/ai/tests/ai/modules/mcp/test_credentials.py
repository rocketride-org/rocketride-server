# Copyright 2026 Aparavi Software AG. MIT License.
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
                                'properties': [{'name': 'pat', 'secret': True, 'env': 'ROCKETRIDE_THING_PAT'}],
                            },
                            'local': {'title': 'Local', 'properties': [{'name': 'endpoint'}]},
                        },
                    },
                    {'name': 'advanced', 'properties': [{'name': 'seed', 'env': 'ROCKETRIDE_THING_SEED'}]},
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
    assert {f.path for f in fields} == {'pat', 'seed', 'hostKey'}
    assert {f.suggests for f in fields} == {
        'ROCKETRIDE_THING_PAT',
        'ROCKETRIDE_THING_SEED',
        'ROCKETRIDE_THING_HOST_KEY',
    }
    # `secret` decides kind; an env-carrying plain setting is not a secret.
    assert {f.path: f.kind for f in fields} == {'pat': 'secret', 'seed': 'text', 'hostKey': 'secret'}
