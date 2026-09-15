# Copyright 2026 Aparavi Software AG. MIT License.
from ai.modules.mcp import credentials as creds

RAW = {
    'store_qdrant': {
        'title': 'Qdrant',
        'docs': 'https://qdrant.tech/documentation/',
        'fields': [
            {
                'path': 'qdrant.url',
                'title': 'Cluster URL',
                'kind': 'endpoint',
                'required': True,
                'suggests': 'ROCKETRIDE_QDRANT_URL',
            },
            {
                'path': 'qdrant.apikey',
                'title': 'API key',
                'kind': 'secret',
                'required': True,
                'suggests': 'ROCKETRIDE_QDRANT_APIKEY',
            },
        ],
    },
}


def _spec():
    return creds.catalog_from_dict(RAW)['store_qdrant']


def test_exact_match_is_configured_with_wiring():
    state = creds.evaluate(_spec(), ['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY'])
    assert state['status'] == 'configured'
    assert state['wiring'] == {
        'qdrant.url': '${ROCKETRIDE_QDRANT_URL}',
        'qdrant.apikey': '${ROCKETRIDE_QDRANT_APIKEY}',
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
    raw = {
        'tool_git': {
            'title': 'tool_git',
            'fields': [
                {'path': 'git.token', 'kind': 'secret', 'required': True, 'suggests': 'ROCKETRIDE_GIT_TOKEN'},
            ],
        },
    }
    spec = creds.catalog_from_dict(raw)['tool_git']

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


def test_shipped_catalog_loads():
    catalog = creds.load_catalog()
    assert 'llm_anthropic' in catalog
    for integration in catalog.values():
        for field in integration.fields:
            assert field.suggests
            assert field.suggests.startswith('ROCKETRIDE_')


# A node that needs its key only on some profiles (the llm_nemotron shape:
# NVIDIA-cloud profiles need the key, the self-hosted `custom` profile does not).
RAW_CONDITIONAL = {
    'llm_nimlike': {
        'title': 'NIM-like LLM',
        'docs': 'https://example.invalid/docs',
        'fields': [
            {
                'path': 'llm.apikey',
                'title': 'Cloud API key',
                'kind': 'secret',
                'required': True,
                'required_for_profiles': ['cloud-a', 'cloud-b'],
                'suggests': 'ROCKETRIDE_NIMLIKE_KEY',
            },
        ],
    },
}


def _conditional_spec():
    return creds.catalog_from_dict(RAW_CONDITIONAL)['llm_nimlike']


def test_conditional_field_present_is_configured():
    state = creds.evaluate(_conditional_spec(), ['ROCKETRIDE_NIMLIKE_KEY'])
    assert state['status'] == 'configured'
    assert state['missing'] == []
    assert state['wiring'] == {'llm.apikey': '${ROCKETRIDE_NIMLIKE_KEY}'}
    assert state['conditional'] == [
        {
            'variable': 'ROCKETRIDE_NIMLIKE_KEY',
            'path': 'llm.apikey',
            'required_for_profiles': ['cloud-a', 'cloud-b'],
            'configured': True,
        }
    ]


def test_conditional_field_missing_is_partial_not_hidden():
    """A gap only in a profile-conditional field must not read as 'not configured':
    the keyless profiles work now, and the caller is told which profiles still
    need the variable.
    """
    spec = _conditional_spec()
    state = creds.evaluate(spec, ['ROCKETRIDE_ANTHROPIC_KEY'])
    assert state['status'] == 'partial'
    assert state['missing'] == ['ROCKETRIDE_NIMLIKE_KEY']
    assert state['candidates'] == []
    assert state['conditional'][0]['configured'] is False
    assert state['conditional'][0]['required_for_profiles'] == ['cloud-a', 'cloud-b']

    shaped = creds.describe_state(spec, state)
    assert shaped['status'] == 'partial'
    assert 'wiring' not in shaped
    assert shaped['setup']['variables'] == ['ROCKETRIDE_NIMLIKE_KEY']
    assert shaped['conditional'] == state['conditional']


def test_conditional_field_does_not_mask_an_unconditional_gap():
    raw = {
        'llm_nimlike': {
            'title': 'NIM-like LLM',
            'fields': [
                {'path': 'llm.endpoint', 'kind': 'endpoint', 'required': True, 'suggests': 'ROCKETRIDE_NIMLIKE_URL'},
                {
                    'path': 'llm.apikey',
                    'kind': 'secret',
                    'required': True,
                    'required_for_profiles': ['cloud-a'],
                    'suggests': 'ROCKETRIDE_NIMLIKE_KEY',
                },
            ],
        },
    }
    spec = creds.catalog_from_dict(raw)['llm_nimlike']
    state = creds.evaluate(spec, ['ROCKETRIDE_ANTHROPIC_KEY'])
    assert state['status'] == 'available'
    assert state['missing'] == ['ROCKETRIDE_NIMLIKE_URL', 'ROCKETRIDE_NIMLIKE_KEY']
    assert creds.describe_state(spec, state)['setup']['variables'] == [
        'ROCKETRIDE_NIMLIKE_URL',
        'ROCKETRIDE_NIMLIKE_KEY',
    ]


def test_conditional_field_env_error_is_unconfirmed_with_unknown_state():
    state = creds.evaluate(_conditional_spec(), None)
    assert state['status'] == 'unconfirmed'
    assert state['env_error'] is True
    assert state['conditional'][0]['configured'] is None


def test_unconditional_entries_report_no_conditional_block():
    state = creds.evaluate(_spec(), ['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY'])
    assert state['conditional'] == []
    assert 'conditional' not in creds.describe_state(_spec(), state)


def test_shipped_catalog_gates_the_nemotron_key_on_cloud_profiles_only():
    field = creds.load_catalog()['llm_nemotron'].fields[0]
    assert field.suggests == 'ROCKETRIDE_NVIDIA_KEY'
    assert field.required is True
    assert field.required_for_profiles == ('nemotron-3-super', 'nemotron-3-ultra', 'nemotron-3-5-lightning')
    assert 'custom' not in field.required_for_profiles
