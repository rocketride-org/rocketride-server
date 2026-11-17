# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for the account readiness tool (`tools/account.py`): `account_status`.

The engine side (`rrext_account_status`) is faked: each test scripts the body
the engine would answer with and checks the sentences, `ok` values, `ready`
and `summary` the tool builds from it. One test per row of the sentence table.
"""

import asyncio
import copy
import json

import pytest

from ai.constants import CONST_ACCOUNT_WAITLISTED, CONST_NO_DEV_TEAM
from ai.modules.mcp import credentials as credentials_mod
from ai.modules.mcp.tooling import ToolRegistry
from ai.modules.mcp.tools import account as account_tool

from .conftest import FakeEngineClient

_CATALOG_RAW = {
    'llm_openai': {
        'title': 'OpenAI',
        'fields': [{'path': 'llm.apikey', 'kind': 'secret', 'suggests': 'ROCKETRIDE_OPENAI_KEY'}],
    },
    'llm_openai_api': {
        'title': 'OpenAI-Compatible API',
        'fields': [{'path': 'llm.apikey', 'kind': 'secret', 'suggests': 'ROCKETRIDE_OPENAI_KEY'}],
    },
    'llm_mistral': {
        'title': 'llm_mistral',
        'fields': [{'path': 'llm.apikey', 'kind': 'secret', 'suggests': 'ROCKETRIDE_MISTRAL_APIKEY'}],
    },
    'llm_local': {
        'title': 'Local model',
        'wire': False,
        'fields': [{'path': 'llm.apikey', 'kind': 'secret', 'suggests': 'ROCKETRIDE_LOCAL_KEY'}],
    },
    'store_qdrant': {
        'title': 'Qdrant',
        'fields': [{'path': 'qdrant.apikey', 'kind': 'secret', 'suggests': 'ROCKETRIDE_QDRANT_APIKEY'}],
    },
}

_SERVICES = {'services': {'llm_mistral': {'title': 'Mistral AI'}, 'llm_openai': {'title': 'OpenAI'}}}

# A funded, active cloud account with a development team it can run on.
_READY = {
    'edition': 'cloud',
    'waitlisted': False,
    'organization': {'name': "Ada's Workspace"},
    'devTeam': {'selected': True, 'name': 'Development', 'canRun': True},
    'credits': {'applies': True, 'canSpend': True, 'tokens': 12500.0},
    'envKeys': ['ROCKETRIDE_OPENAI_KEY'],
    'capabilities': ['saas'],
}

_WAITLISTED = {
    'edition': 'cloud',
    'waitlisted': True,
    'organization': None,
    'devTeam': {'selected': False, 'name': '', 'canRun': False},
    'credits': {'applies': True, 'canSpend': None, 'tokens': None},
    'envKeys': None,
    'capabilities': ['saas'],
}

_SELF_HOSTED = {
    'edition': 'self-hosted',
    'waitlisted': False,
    'organization': {'name': 'Local'},
    'devTeam': {'selected': True, 'name': 'Development', 'canRun': True},
    'credits': {'applies': False},
    'envKeys': ['ROCKETRIDE_OPENAI_KEY'],
    'capabilities': ['oss'],
}

_NO_TEAM = {'selected': False, 'name': '', 'canRun': False}
_BILLING_NEXT = (
    "In RocketRide, a workspace admin can open Account > Billing to manage this workspace's compute credits. "
    "If you're not one, ask a workspace admin to do it."
)


@pytest.fixture(autouse=True)
def _catalog(monkeypatch):
    monkeypatch.setattr(credentials_mod, 'load_catalog', lambda: credentials_mod.catalog_from_dict(_CATALOG_RAW))


def _status(base=None, **changes):
    status = copy.deepcopy(base if base is not None else _READY)
    for key, value in changes.items():
        if isinstance(value, dict) and isinstance(status.get(key), dict):
            status[key].update(value)
        else:
            status[key] = value
    return status


class _ServicesDown(FakeEngineClient):
    async def get_services(self):
        self.get_services_calls += 1
        raise RuntimeError('services unavailable')


async def _call(status, *, engine_class=FakeEngineClient):
    registry = ToolRegistry()
    account_tool.register(registry)
    engine = engine_class(account_status=status, services=_SERVICES)
    result = await registry.handler('account_status')(engine, None, {})
    return result, engine


def _check(result, check_id):
    return next(c for c in result['checks'] if c['id'] == check_id)


# -- the run refusals repeat the tool's words ----------------------------------


def test_the_run_refusals_use_the_tools_sentences_word_for_word():
    assert CONST_ACCOUNT_WAITLISTED == f'{account_tool.WAITLISTED} {account_tool.WAITLISTED_NEXT}'
    assert CONST_NO_DEV_TEAM == f'{account_tool.TEAM_NONE} {account_tool.TEAM_NONE_NEXT}'


# -- access ------------------------------------------------------------------


async def test_access_active_cloud():
    result, _ = await _call(_status())

    assert _check(result, 'access') == {'id': 'access', 'ok': True, 'detail': 'This RocketRide account is active.'}


async def test_access_waitlisted():
    result, _ = await _call(_status(_WAITLISTED))

    assert _check(result, 'access') == {
        'id': 'access',
        'ok': False,
        'detail': "This RocketRide account is on the waitlist, so it can't run pipelines yet.",
        'next_step': "You'll get an email when the account is activated. You don't need to do anything else.",
    }


async def test_access_self_hosted():
    result, _ = await _call(_status(_SELF_HOSTED))

    assert _check(result, 'access') == {
        'id': 'access',
        'ok': True,
        'detail': 'This is a self-hosted RocketRide engine. It has no waitlist.',
    }


# -- team ----------------------------------------------------------------------


async def test_team_selected_and_can_run():
    result, _ = await _call(_status())

    assert _check(result, 'team') == {
        'id': 'team',
        'ok': True,
        'detail': 'Your development team is "Development". Pipelines you run belong to it.',
    }


async def test_team_without_a_name_is_still_a_sentence():
    result, _ = await _call(_status(devTeam={'name': ''}))

    assert _check(result, 'team')['detail'] == 'A development team is selected, and pipelines you run belong to it.'


async def test_team_none_selected():
    result, _ = await _call(_status(devTeam=_NO_TEAM))

    assert _check(result, 'team') == {
        'id': 'team',
        'ok': False,
        'detail': 'No development team is selected, and every pipeline you run needs one.',
        'next_step': 'In RocketRide, open Account > Profile and choose your development team. '
        'If no team is listed, ask a workspace admin to add you to one.',
    }


async def test_team_selected_but_cannot_run():
    result, _ = await _call(_status(devTeam={'canRun': False}))

    assert _check(result, 'team') == {
        'id': 'team',
        'ok': False,
        'detail': 'You don\'t have permission to run pipelines in your development team, "Development".',
        'next_step': 'In RocketRide, open Account > Profile and choose another development team, '
        'or ask a workspace admin for permission to run pipelines on this one.',
    }


async def test_team_waitlisted():
    result, _ = await _call(_status(_WAITLISTED))

    assert _check(result, 'team') == {
        'id': 'team',
        'ok': None,
        'detail': 'RocketRide can check the development team once the account is activated.',
    }


# -- credits -------------------------------------------------------------------


async def test_credits_self_hosted():
    result, _ = await _call(_status(_SELF_HOSTED))

    assert _check(result, 'credits') == {
        'id': 'credits',
        'ok': True,
        'detail': "Compute credits don't apply to a self-hosted engine.",
    }


async def test_credits_can_spend():
    result, _ = await _call(_status())

    assert _check(result, 'credits') == {
        'id': 'credits',
        'ok': True,
        'detail': 'This workspace has 12,500 compute credits.',
        'tokens': 12500.0,
    }


async def test_credits_fractional_balance_shows_one_decimal_like_the_billing_page():
    result, _ = await _call(_status(credits={'tokens': 12499.64}))

    assert _check(result, 'credits')['detail'] == 'This workspace has 12,499.6 compute credits.'
    assert _check(result, 'credits')['tokens'] == 12499.6


@pytest.mark.parametrize('balance', [0.0, -40.0])
async def test_credits_can_still_spend_at_or_below_zero_shows_no_number(balance):
    """A workspace allowed to dip below zero must not read as "-40 credits"."""
    result, _ = await _call(_status(credits={'tokens': balance}))

    assert _check(result, 'credits') == {
        'id': 'credits',
        'ok': True,
        'detail': 'This workspace has no compute credits left, but it can still run pipelines for now.',
        'next_step': _BILLING_NEXT,
    }
    assert result['ready'] is True


@pytest.mark.parametrize('balance', [0.0, -12.5])
async def test_credits_cannot_spend(balance):
    result, _ = await _call(_status(credits={'canSpend': False, 'tokens': balance}))

    assert _check(result, 'credits') == {
        'id': 'credits',
        'ok': False,
        'detail': "This workspace has no compute credits left, so pipelines can't run.",
        'next_step': _BILLING_NEXT,
    }


async def test_credits_refused_with_a_positive_balance_does_not_claim_none_are_left():
    """The backend may refuse for another reason than an empty balance."""
    result, _ = await _call(_status(credits={'canSpend': False, 'tokens': 500.0}))

    assert _check(result, 'credits') == {
        'id': 'credits',
        'ok': False,
        'detail': "This workspace can't use its compute credits right now, so pipelines can't run.",
        'next_step': _BILLING_NEXT,
        'tokens': 500.0,
    }
    assert result['summary'] == (
        "This RocketRide account can't run pipelines right now. This workspace can't use its compute credits."
    )


async def test_credits_read_failed():
    result, _ = await _call(_status(credits={'canSpend': None, 'tokens': None}))

    assert _check(result, 'credits') == {
        'id': 'credits',
        'ok': None,
        'detail': "RocketRide couldn't check this workspace's compute credits just now.",
        'next_step': 'Ask me to check the compute credits again in a moment.',
    }


async def test_credits_waitlisted():
    result, _ = await _call(_status(_WAITLISTED))

    assert _check(result, 'credits') == {
        'id': 'credits',
        'ok': None,
        'detail': 'RocketRide can check compute credits once the account is activated.',
    }


# -- model_key -----------------------------------------------------------------

_HOSTED = "OpenAI models can run on RocketRide without a key of your own. They use this workspace's compute credits."
_OTHERS = 'Other AI providers need your own key, saved in RocketRide under Settings > Variables.'


async def test_model_key_hosted_models_capability():
    result, _ = await _call(_status(capabilities=['saas', 'hosted-models:openai'], envKeys=[]))

    assert _check(result, 'model_key') == {
        'id': 'model_key',
        'ok': True,
        'detail': f'{_HOSTED} {_OTHERS}',
        'blocking': False,
    }
    assert 'hint' not in result


async def test_model_key_hosted_models_capability_also_names_saved_keys():
    result, _ = await _call(
        _status(capabilities=['saas', 'hosted-models:openai'], envKeys=['ROCKETRIDE_MISTRAL_APIKEY'])
    )

    assert _check(result, 'model_key')['detail'] == (
        f'{_HOSTED} RocketRide has a saved AI model key for Mistral AI. '
        'Any other AI provider needs your own key, saved in RocketRide under Settings > Variables.'
    )


async def test_model_key_saved_names_each_provider_once_by_its_node_title():
    """OpenAI and the OpenAI-compatible node share one key: one key, one name."""
    result, _ = await _call(_status(envKeys=['ROCKETRIDE_MISTRAL_APIKEY', 'ROCKETRIDE_OPENAI_KEY']))

    assert _check(result, 'model_key') == {
        'id': 'model_key',
        'ok': True,
        'detail': 'RocketRide has saved AI model keys for Mistral AI and OpenAI.',
        'blocking': False,
    }
    assert 'hint' not in result


async def test_model_key_saved_falls_back_to_catalog_titles_when_services_fail():
    result, engine = await _call(_status(envKeys=['ROCKETRIDE_OPENAI_KEY']), engine_class=_ServicesDown)

    assert engine.get_services_calls == 1
    assert _check(result, 'model_key')['detail'] == 'RocketRide has a saved AI model key for OpenAI.'


async def test_model_key_none_saved():
    """A non-model key and a key-free model integration do not count."""
    result, _ = await _call(_status(envKeys=['ROCKETRIDE_QDRANT_APIKEY', 'ROCKETRIDE_LOCAL_KEY']))

    assert _check(result, 'model_key') == {
        'id': 'model_key',
        'ok': False,
        'detail': 'No AI model key is saved.',
        'next_step': 'If a pipeline uses a model from a provider such as OpenAI or Anthropic, get an API key from that '
        "provider. In RocketRide, open Settings > Variables and add it there. Don't paste the key into this chat.",
        'blocking': False,
    }
    assert result['ready'] is True
    # The variable name lookup is for the agent, never in a sentence for the user.
    assert result['hint'] == (
        "For the exact variable name a provider needs, call list_integrations with that provider's name. "
        'After the user adds a key, call list_integrations to confirm.'
    )


_CONFIRM_HINT = (
    "Call list_integrations with that provider's name to see which saved variables may hold its key, "
    'and confirm with the user before using one.'
)


async def test_model_key_under_a_custom_name_is_neither_saved_nor_missing():
    """A variable that only mentions a provider is a candidate: never "saved", never "none"."""
    result, _ = await _call(_status(envKeys=['ROCKETRIDE_MY_OPENAI_SECRET']))

    assert _check(result, 'model_key') == {
        'id': 'model_key',
        'ok': None,
        'detail': "RocketRide can't tell whether a saved variable is an AI model key for OpenAI.",
        'blocking': False,
    }
    assert result['ready'] is True
    assert result['summary'] == (
        "This RocketRide account is ready to run pipelines. RocketRide can't tell whether a saved variable is an "
        'AI model key for OpenAI.'
    )
    assert result['hint'] == _CONFIRM_HINT


def _real_catalog(monkeypatch):
    raw = json.loads(credentials_mod._CATALOG_PATH.read_text(encoding='utf-8'))
    monkeypatch.setattr(credentials_mod, 'load_catalog', lambda: credentials_mod.catalog_from_dict(raw))


@pytest.mark.parametrize('saved', ['ROCKETRIDE_GEMINI_KEY', 'ROCKETRIDE_GEMINI_GEMINI_APIKEY'])
async def test_model_key_one_of_two_suggested_names_counts_as_saved_with_the_real_catalog(monkeypatch, saved):
    """Gemini suggests two names. Either one is a saved key; setup completeness is list_integrations' job."""
    _real_catalog(monkeypatch)

    result, _ = await _call(_status(envKeys=[saved]))

    assert _check(result, 'model_key')['detail'] == 'RocketRide has a saved AI model key for Gemini.'
    assert _check(result, 'model_key')['ok'] is True


async def test_model_key_under_a_custom_name_with_the_real_catalog(monkeypatch):
    _real_catalog(monkeypatch)

    result, _ = await _call(_status(envKeys=['ROCKETRIDE_MY_OPENAI_SECRET']))

    assert _check(result, 'model_key')['detail'] == (
        "RocketRide can't tell whether a saved variable is an AI model key for OpenAI."
    )
    assert result['hint'] == _CONFIRM_HINT


async def test_model_key_read_failed():
    result, _ = await _call(_status(envKeys=None))

    assert _check(result, 'model_key') == {
        'id': 'model_key',
        'ok': None,
        'detail': "RocketRide couldn't check saved AI model keys just now.",
        'next_step': 'Ask me to check the saved AI model keys again in a moment.',
        'blocking': False,
    }


async def test_model_key_waitlisted_even_with_the_hosted_tag():
    result, _ = await _call(_status(_WAITLISTED, capabilities=['saas', 'hosted-models:openai']))

    assert _check(result, 'model_key') == {
        'id': 'model_key',
        'ok': None,
        'detail': 'RocketRide can check saved AI model keys once the account is activated.',
        'blocking': False,
    }


# -- ready and summary ---------------------------------------------------------

_BLOCKED = "This RocketRide account can't run pipelines right now."
_NO_KEY = 'No AI model key is saved yet.'


@pytest.mark.parametrize(
    ('status', 'ready', 'summary'),
    [
        (_status(), True, 'This RocketRide account is ready to run pipelines.'),
        (_status(_SELF_HOSTED), True, 'This RocketRide account is ready to run pipelines.'),
        (
            _status(_WAITLISTED),
            False,
            "This RocketRide account is on the waitlist, so it can't run pipelines yet.",
        ),
        (
            _status(devTeam=_NO_TEAM),
            False,
            f'{_BLOCKED} No development team is selected, and every pipeline you run needs one.',
        ),
        (
            _status(devTeam={'canRun': False}),
            False,
            f'{_BLOCKED} You don\'t have permission to run pipelines in your development team, "Development".',
        ),
        (
            _status(credits={'canSpend': False, 'tokens': 0.0}),
            False,
            f'{_BLOCKED} This workspace has no compute credits left.',
        ),
        # Every blocker is named, so fixing one does not lead to a second refusal.
        (
            _status(devTeam=_NO_TEAM, credits={'canSpend': False, 'tokens': 0.0}),
            False,
            f'{_BLOCKED} No development team is selected, and every pipeline you run needs one. '
            'This workspace has no compute credits left.',
        ),
        (
            _status(credits={'canSpend': None, 'tokens': None}),
            False,
            "RocketRide couldn't check this workspace's compute credits, so it can't confirm the account is "
            'ready to run pipelines.',
        ),
        # A missing model key is advice, never a blocker, but the summary says so.
        (
            _status(envKeys=[]),
            True,
            'This RocketRide account is ready to run pipelines. ' + _NO_KEY,
        ),
        (
            _status(envKeys=None),
            True,
            "This RocketRide account is ready to run pipelines. RocketRide couldn't check saved AI model keys just now.",
        ),
        # Below zero but still allowed to spend: ready, and the summary says the credits ran out.
        (
            _status(credits={'tokens': -40.0}),
            True,
            'This RocketRide account can still run pipelines for now, but this workspace has no compute credits left.',
        ),
        (
            _status(credits={'tokens': 0.0}, envKeys=[]),
            True,
            'This RocketRide account can still run pipelines for now, but this workspace has no compute credits left. '
            + _NO_KEY,
        ),
    ],
)
async def test_ready_and_summary(status, ready, summary):
    result, _ = await _call(status)

    assert result['ok'] is True
    assert result['ready'] is ready
    assert result['summary'] == summary
    assert [c['id'] for c in result['checks']] == ['access', 'team', 'credits', 'model_key']


async def test_result_carries_the_edition():
    assert (await _call(_status()))[0]['edition'] == 'cloud'
    assert (await _call(_status(_SELF_HOSTED)))[0]['edition'] == 'self-hosted'


# -- never a secret, never a sale, never a tool name for the user --------------


async def test_result_holds_no_variable_names_or_account_names():
    result, _ = await _call(_status(envKeys=['ROCKETRIDE_OPENAI_KEY', 'ROCKETRIDE_SECRET_THING']))

    text = json.dumps(result)
    assert 'ROCKETRIDE_' not in text
    assert "Ada's Workspace" not in text


def _user_sentences():
    """Every sentence a user may be shown: all upper-case string constants but the agent hint and the tag."""
    skip = {account_tool.HOSTED_OPENAI_CAPABILITY, account_tool.MODEL_HINT, account_tool.MODEL_CONFIRM_HINT}
    return [
        value
        for name, value in vars(account_tool).items()
        if name.isupper() and isinstance(value, str) and value not in skip
    ] + [CONST_ACCOUNT_WAITLISTED, CONST_NO_DEV_TEAM]


def test_no_sentence_sells_links_names_a_tool_or_asks_for_a_key_in_chat():
    sentences = _user_sentences()
    assert len(sentences) > 20

    for sentence in sentences:
        lowered = sentence.lower()
        for banned in ('upgrade', 'buy', 'purchase', 'price', '$', 'http', 'www.', 'checkout', '_'):
            assert banned not in lowered, (banned, sentence)
        assert 'paste' not in lowered or "don't paste" in lowered, sentence
        for jargon in ('devteam', 'org ', 'overdraft', 'node', 'token'):
            assert jargon not in lowered, (jargon, sentence)


# -- engine failures -----------------------------------------------------------

_UNAVAILABLE = {
    'ok': False,
    'error_type': 'Unavailable',
    'message': "This RocketRide engine can't report account status. If you run the engine yourself, updating it "
    'adds this check. In RocketRide, open Account > Profile to check your account now.',
    'hint': 'Tell the user this message as written.',
}


async def test_engine_without_the_command_is_reported_plainly():
    """An engine older than rrext_account_status refuses it by name."""
    result, _ = await _call(RuntimeError('Unsupported command: rrext_account_status'))

    assert result == _UNAVAILABLE


async def test_an_unexpected_body_is_reported_plainly():
    result, _ = await _call({'edition': 'something-else'})

    assert result == _UNAVAILABLE


async def test_engine_timeout_is_in_band(monkeypatch):
    monkeypatch.setattr('ai.modules.mcp.tools._common.DEFAULT_TIMEOUT_SECONDS', 0.01)

    class _Slow(FakeEngineClient):
        async def get_account_status(self):
            await asyncio.sleep(1)

    registry = ToolRegistry()
    account_tool.register(registry)
    result = await registry.handler('account_status')(_Slow(), None, {})

    assert result['ok'] is False
    assert result['error_type'] == 'Timeout'


async def test_engine_error_propagates_for_the_dispatcher_to_normalize():
    with pytest.raises(RuntimeError, match='boom'):
        await _call(RuntimeError('boom'))
