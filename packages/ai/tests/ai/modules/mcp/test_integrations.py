# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for the integration-discovery tool (`tools/integrations.py`):
`list_integrations`, and the account readiness tool (`tools/account.py`):
`account_status`, which reads saved keys through the same credentials catalog.
"""

import copy

import pytest

from ai.constants import CONST_ACCOUNT_WAITLISTED, CONST_NO_DEV_TEAM
from ai.modules.mcp.tools import account as account_tool

from ai.modules.mcp import credentials as credentials_mod
from ai.modules.mcp.tooling import ToolRegistry
from ai.modules.mcp.tools import integrations
from ai.modules.mcp.tools import register_all

from .conftest import FakeEngineClient

# A small, self-contained catalog -- must not depend on the shipped
# credentials.json's 55 real nodes/83 fields.
_CATALOG_RAW = {
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
    'store_pinecone': {
        'title': 'Pinecone',
        'docs': 'https://docs.pinecone.io/',
        'fields': [
            {
                'path': 'pinecone.apikey',
                'title': 'API key',
                'kind': 'secret',
                'required': True,
                'suggests': 'ROCKETRIDE_PINECONE_APIKEY',
            },
        ],
    },
}


def _fake_catalog():
    return credentials_mod.catalog_from_dict(_CATALOG_RAW)


def _services_with_catalog_nodes():
    return {
        'services': {
            'ocr': {
                'title': 'OCR',
                'protocol': 'ocr',
                'classType': ['source'],
                'description': 'Optical character recognition component',
            },
            'store_qdrant': {
                'title': 'Qdrant',
                'protocol': 'qdrant',
                'classType': ['store'],
                'description': 'Vector store',
            },
            # store_pinecone deliberately absent from this engine's
            # get_services() -- proves the bare list intersects, not just
            # dumps the whole catalog.
        },
        'version': 'x',
    }


# --- registration -----------------------------------------------------------


def test_register_all_registers_list_integrations_last():
    registry = ToolRegistry()

    register_all(registry)

    assert 'list_integrations' in registry.names()
    assert registry.names()[-1] == 'list_integrations'


def test_integrations_register_binds_handler_directly():
    registry = ToolRegistry()

    integrations.register(registry)

    assert registry.handler('list_integrations') is not None


def test_list_integrations_description_mentions_setup_and_variable_relay():
    registry = ToolRegistry()

    integrations.register(registry)

    description = next(t.description for t in registry.tools() if t.name == 'list_integrations')
    assert (
        'Entries include setup instructions you can relay to the user; unconfirmed entries list the '
        "caller's variable names so you can propose a binding and confirm with the user before using it." in description
    )


# --- bare call: compact list --------------------------------------------------


@pytest.mark.asyncio
async def test_list_integrations_bare_intersects_engine_and_sorts(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(
        services=_services_with_catalog_nodes(),
        env_keys=['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY'],
    )
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {})

    assert result['ok'] is True
    assert 'note' in result
    # store_pinecone is in the catalog but not in this engine's services --
    # must be excluded from the bare list entirely.
    names = [row['name'] for row in result['integrations']]
    assert names == ['store_qdrant']
    assert result['integrations'] == [
        {'name': 'store_qdrant', 'title': 'Qdrant', 'status': 'configured', 'missing_count': 0}
    ]


@pytest.mark.asyncio
async def test_list_integrations_bare_sorted_by_name(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    services = {
        'services': {
            'store_qdrant': {'title': 'Qdrant', 'protocol': 'qdrant', 'classType': ['store']},
            'store_pinecone': {'title': 'Pinecone', 'protocol': 'pinecone', 'classType': ['store']},
        },
        'version': 'x',
    }
    engine = FakeEngineClient(services=services, env_keys=[])
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {})

    names = [row['name'] for row in result['integrations']]
    assert names == sorted(names)
    assert names == ['store_pinecone', 'store_qdrant']


@pytest.mark.asyncio
async def test_list_integrations_bare_skips_env_call_when_no_catalog_overlap(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    # Default fixture services ('ocr', 'anthropic') don't collide with the
    # fake catalog -- the extra get_environment_keys round trip must not fire.
    engine = FakeEngineClient()
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {})

    assert result['ok'] is True
    assert result['integrations'] == []
    assert engine.get_environment_keys_calls == 0


@pytest.mark.asyncio
async def test_list_integrations_bare_env_error_marks_every_row_unconfirmed(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(
        services=_services_with_catalog_nodes(),
        env_keys=RuntimeError('scope denied'),
    )
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {})

    assert result['ok'] is True
    assert len(result['integrations']) == 1
    assert result['integrations'][0]['status'] == 'unconfirmed'


# --- name detail --------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_integrations_detail_configured_has_wiring_no_setup(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(env_keys=['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY'])
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {'name': 'store_qdrant'})

    assert result['ok'] is True
    assert result['name'] == 'store_qdrant'
    assert result['title'] == 'Qdrant'
    assert result['status'] == 'configured'
    assert result['missing'] == []
    assert result['candidates'] == []
    assert result['caller_variables'] == ['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY']
    assert result['wiring'] == {
        'qdrant.url': '${ROCKETRIDE_QDRANT_URL}',
        'qdrant.apikey': '${ROCKETRIDE_QDRANT_APIKEY}',
    }
    assert 'setup' not in result
    assert result['fields'] == [
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
    ]


@pytest.mark.asyncio
async def test_list_integrations_detail_available_has_setup_block(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(env_keys=[])  # nothing set, no candidates -> 'available'
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {'name': 'store_qdrant'})

    assert result['ok'] is True
    assert result['status'] == 'available'
    assert result['missing'] == ['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY']
    assert result['candidates'] == []
    assert result['caller_variables'] == []
    assert 'wiring' not in result
    assert result['setup'] == {
        'variables': ['ROCKETRIDE_QDRANT_URL', 'ROCKETRIDE_QDRANT_APIKEY'],
        'how': credentials_mod.SETUP_HOW,
        'docs': 'https://qdrant.tech/documentation/',
    }


@pytest.mark.asyncio
async def test_list_integrations_detail_unconfirmed_has_candidates_and_caller_variables(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    # A near-miss variable name (token match on QDRANT) but not the exact
    # suggested name -> 'unconfirmed' with a surfaced candidate.
    engine = FakeEngineClient(env_keys=['MY_QDRANT_KEY'])
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {'name': 'store_qdrant'})

    assert result['ok'] is True
    assert result['status'] == 'unconfirmed'
    assert result['candidates'] == ['MY_QDRANT_KEY']
    assert result['caller_variables'] == ['MY_QDRANT_KEY']
    assert 'wiring' not in result
    assert 'setup' in result


@pytest.mark.asyncio
async def test_list_integrations_detail_env_error_is_unconfirmed_with_empty_caller_variables(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient(env_keys=RuntimeError('scope denied'))
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {'name': 'store_qdrant'})

    assert result['ok'] is True
    assert result['status'] == 'unconfirmed'
    assert result['caller_variables'] == []
    assert 'setup' in result
    assert 'wiring' not in result


@pytest.mark.asyncio
async def test_list_integrations_unknown_name_is_bad_request(monkeypatch):
    monkeypatch.setattr(integrations.credentials_mod, 'load_catalog', _fake_catalog)
    engine = FakeEngineClient()
    registry = ToolRegistry()
    integrations.register(registry)

    result = await registry.handler('list_integrations')(engine, None, {'name': 'nope'})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert 'nope' in result['message']
    assert result['hint']


def test_shipped_tool_github_wires_only_the_token_when_the_map_variables_exist():
    # The credential map's row fields are set inside credentialMap, so their variables must not
    # become top-level bindings the node would ignore.
    spec = credentials_mod.load_catalog()['tool_github']

    result = credentials_mod.evaluate(
        spec, ['ROCKETRIDE_GITHUB_TOKEN', 'ROCKETRIDE_GITHUB_CREDENTIAL_REPOSITORY', 'ROCKETRIDE_GITHUB_CREDENTIAL']
    )

    assert result['status'] == 'configured'
    assert result['wiring'] == {'github.token': '${ROCKETRIDE_GITHUB_TOKEN}'}


def test_shipped_tool_github_still_asks_for_a_token_without_env():
    # tool_github has two auth methods, but the PAT stays the wired default: with every
    # credential optional the surface would report 'configured' with an empty wiring.
    spec = credentials_mod.load_catalog()['tool_github']

    result = credentials_mod.evaluate(spec, [])

    assert result['status'] != 'configured'
    assert result['missing'] == ['ROCKETRIDE_GITHUB_TOKEN']


# ---------------------------------------------------------------------------
# account_status (tools/account.py), with the shipped credentials catalog
# ---------------------------------------------------------------------------

# The rrext_account_status body of a funded, active cloud account.
_CLOUD = {
    'edition': 'cloud',
    'waitlisted': False,
    'organization': {'name': 'Example Workspace'},
    'devTeam': {'selected': True, 'name': 'Development', 'canRun': True},
    'credits': {'applies': True, 'canSpend': True, 'tokens': 12500.0},
    'envKeys': ['ROCKETRIDE_OPENAI_KEY'],
    'capabilities': ['saas'],
}
_BILLING = (
    "In RocketRide, a workspace admin can open Account > Billing to manage this workspace's compute credits. "
    "If you're not one, ask a workspace admin to do it."
)
_RETRY = 'Ask me to check the compute credits again in a moment.'


def _body(base=None, **changes):
    body = copy.deepcopy(base or _CLOUD)
    for key, value in changes.items():
        body[key] = {**body[key], **value} if isinstance(value, dict) and isinstance(body.get(key), dict) else value
    return body


async def _status(body):
    registry = ToolRegistry()
    account_tool.register(registry)
    return await registry.handler('account_status')(FakeEngineClient(account_status=body), None, {})


def _row(result, check_id):
    return next(row for row in result['checks'] if row['id'] == check_id)


async def test_account_status_ready_cloud_account_says_so_in_every_row():
    assert await _status(_body()) == {
        'ok': True,
        'ready': True,
        'edition': 'cloud',
        'summary': 'This RocketRide account is ready to run pipelines.',
        'checks': [
            {'id': 'access', 'ok': True, 'detail': 'This RocketRide account is active.'},
            {
                'id': 'team',
                'ok': True,
                'detail': 'Your development team is "Development". Pipelines you run belong to it.',
            },
            {'id': 'credits', 'ok': True, 'detail': 'This workspace has 12,500 compute credits.', 'tokens': 12500.0},
            {
                'id': 'model_key',
                'ok': True,
                'detail': 'RocketRide has a saved AI model key for OpenAI.',
                'blocking': False,
            },
        ],
    }


async def test_account_status_inactive_account_never_promises_that_waiting_helps():
    """Waitlisted also covers an account an operator turned off, so no row says to wait."""
    result = await _status(
        _body(
            waitlisted=True, organization=None, devTeam={'selected': False, 'name': '', 'canRun': False}, envKeys=None
        )
    )

    assert result['ready'] is False
    assert result['summary'] == "This account isn't active, so it can't run pipelines."
    assert _row(result, 'access') == {
        'id': 'access',
        'ok': False,
        'detail': "This account isn't active, so it can't run pipelines.",
        'next_step': "If you just signed up, you'll get an email when it's activated.",
    }
    assert [_row(result, c)['ok'] for c in ('team', 'credits', 'model_key')] == [None, None, None]
    # The run and deploy refusals repeat the tool's sentences word for word.
    assert CONST_ACCOUNT_WAITLISTED == f'{account_tool.WAITLISTED} {account_tool.WAITLISTED_NEXT}'
    assert CONST_NO_DEV_TEAM == f'{account_tool.TEAM_NONE} {account_tool.TEAM_NONE_NEXT}'


@pytest.mark.parametrize(
    ('changes', 'summary', 'team_next'),
    [
        (
            {
                'devTeam': {'selected': False, 'name': '', 'canRun': False},
                'credits': {'canSpend': False, 'tokens': 0.0},
            },
            "This RocketRide account can't run pipelines right now. No development team is selected, and every "
            'pipeline you run needs one. This workspace has no compute credits left.',
            'In RocketRide, open Account > Profile and choose your development team. '
            'If no team is listed, ask a workspace admin to add you to one.',
        ),
        (
            {'devTeam': {'canRun': False}},
            "This RocketRide account can't run pipelines right now. You don't have permission to run pipelines in "
            'your development team, "Development".',
            'In RocketRide, open Account > Profile and choose another development team, '
            'or ask a workspace admin for permission to run pipelines on this one.',
        ),
    ],
)
async def test_account_status_summary_names_every_blocker(changes, summary, team_next):
    result = await _status(_body(**changes))

    assert result['ready'] is False
    assert result['summary'] == summary
    assert _row(result, 'team')['next_step'] == team_next


@pytest.mark.parametrize(
    ('credits', 'row'),
    [
        # The raw balance decides; rounding is for display only.
        ({'tokens': 0.04}, {'ok': True, 'detail': 'This workspace has less than 0.1 compute credits.', 'tokens': 0.04}),
        (
            {'tokens': 12499.64},
            {'ok': True, 'detail': 'This workspace has 12,499.6 compute credits.', 'tokens': 12499.64},
        ),
        (
            {'tokens': -40.0},
            {
                'ok': True,
                'detail': 'This workspace has no compute credits left, but it can still run pipelines for now.',
                'next_step': _BILLING,
            },
        ),
        (
            {'canSpend': False, 'tokens': 0.0},
            {
                'ok': False,
                'detail': "This workspace has no compute credits left, so pipelines can't run.",
                'next_step': _BILLING,
            },
        ),
        # The spend check answers from a short cache: a refusal next to a positive balance is not trusted.
        (
            {'canSpend': False, 'tokens': 500.0},
            {
                'ok': None,
                'detail': "RocketRide couldn't check this workspace's compute credits just now.",
                'next_step': _RETRY,
                'tokens': 500.0,
            },
        ),
        (
            {'canSpend': None, 'tokens': None, 'reason': 'readFailed'},
            {
                'ok': None,
                'detail': "RocketRide couldn't check this workspace's compute credits just now.",
                'next_step': _RETRY,
            },
        ),
        # No workspace: nothing to retry.
        (
            {'canSpend': None, 'tokens': None, 'reason': 'noOrganization'},
            {'ok': None, 'detail': "This account isn't part of a workspace, so it has no compute credits to check."},
        ),
    ],
)
async def test_account_status_credits_row(credits, row):
    result = await _status(_body(credits=credits))

    assert _row(result, 'credits') == {'id': 'credits', **row}


async def test_account_status_model_keys_use_catalog_names_and_never_overclaim():
    catalog = credentials_mod.load_catalog()
    assert [name for name, spec in catalog.items() if name.startswith('llm_') and spec.title == name] == []

    cases = [
        # Either of Gemini's two suggested names is a saved key.
        (['ROCKETRIDE_GEMINI_GEMINI_APIKEY'], True, 'RocketRide has a saved AI model key for Gemini.', None),
        # Display names, and one shared OpenAI key named once.
        (
            ['ROCKETRIDE_DEEPSEEK_APIKEY', 'ROCKETRIDE_OPENAI_KEY'],
            True,
            'RocketRide has saved AI model keys for Deepseek and OpenAI.',
            None,
        ),
        # A custom name is a candidate: never "saved", never "none".
        (
            ['ROCKETRIDE_MY_OPENAI_SECRET'],
            None,
            "RocketRide can't tell whether a saved variable is an AI model key for OpenAI.",
            account_tool.MODEL_CONFIRM_HINT,
        ),
        ([], False, 'No AI model key is saved.', account_tool.MODEL_HINT),
    ]
    for env_keys, ok, detail, hint in cases:
        result = await _status(_body(envKeys=env_keys))
        assert (_row(result, 'model_key')['ok'], _row(result, 'model_key')['detail']) == (ok, detail), env_keys
        assert result.get('hint') == hint, env_keys
        assert result['ready'] is True


async def test_account_status_hosted_models_tag():
    """The tool reads the engine's one constant for the tag the hosted backend sends."""
    assert account_tool.HOSTED_MODELS_CAPABILITY is credentials_mod.HOSTED_MODELS_CAPABILITY
    assert credentials_mod.HOSTED_MODELS_CAPABILITY == 'hosted-models:openai'

    result = await _status(_body(capabilities=['saas', 'hosted-models:openai'], envKeys=['ROCKETRIDE_ANTHROPIC_KEY']))

    assert _row(result, 'model_key') == {
        'id': 'model_key',
        'ok': True,
        'detail': "Some OpenAI models can run on RocketRide without a key of your own. They use this workspace's "
        'compute credits. RocketRide has a saved AI model key for Anthropic. Other OpenAI models and any other AI '
        'provider need your own key, saved in RocketRide under Settings > Environment Variables.',
        'blocking': False,
    }
    assert 'hint' not in result


async def test_account_status_self_hosted_engine():
    result = await _status(
        _body(edition='self-hosted', credits={'applies': False}, capabilities=['oss'], envKeys=['ROCKETRIDE_APIKEY'])
    )

    assert result['ready'] is True
    assert _row(result, 'access')['detail'] == 'This is a self-hosted RocketRide engine. It has no waitlist.'
    assert _row(result, 'credits') == {
        'id': 'credits',
        'ok': True,
        'detail': "Compute credits don't apply to a self-hosted engine.",
    }
    assert result['summary'] == 'This RocketRide account is ready to run pipelines. No AI model key is saved yet.'


@pytest.mark.parametrize('answer', [RuntimeError('Unsupported command: rrext_account_status'), {'edition': 'x'}])
async def test_account_status_engine_without_the_command(answer):
    result = await _status(answer)

    assert result['error_type'] == 'Unavailable'
    assert result['ok'] is False
