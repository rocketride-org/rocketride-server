# Copyright 2026 Aparavi Software AG. MIT License.
"""Account readiness tool: `account_status`.

Says whether the caller's RocketRide account can run pipelines right now and,
when it can't, what is missing and what the user should do. It checks account
access (the waitlist), the development team runs are billed to, compute credits
(hosted backend only) and saved AI model keys, and words each result as a
sentence the agent can relay as is.

It reads the engine's ``rrext_account_status`` command, which answers for the
signed-in caller only. Key values, credentials and ids never reach this tool.
"""

from typing import Any, Dict, List, Optional, Tuple

from .. import credentials as credentials_mod
from ..tooling import ToolHints, ToolRegistry
from ._common import engine_call

# Set by the hosted backend when OpenAI nodes can run on RocketRide-hosted
# models without a key of the user's own.
HOSTED_OPENAI_CAPABILITY = 'hosted-models:openai'

# Every sentence the tool can say. Plain words for a person who has never used
# RocketRide: no prices, no "upgrade", no links, never a tool name, and never a
# request to paste a key into the chat. The run refusals for a waitlisted
# account and a missing team (ai.constants) repeat these sentences word for word.
WAITLISTED = "This RocketRide account is on the waitlist, so it can't run pipelines yet."
WAITLISTED_NEXT = "You'll get an email when the account is activated. You don't need to do anything else."
ACCESS_ACTIVE = 'This RocketRide account is active.'
ACCESS_SELF_HOSTED = 'This is a self-hosted RocketRide engine. It has no waitlist.'

TEAM_NOT_YET = 'RocketRide can check the development team once the account is activated.'
TEAM_CAN_RUN = 'Your development team is "{team}". Pipelines you run belong to it.'
TEAM_CAN_RUN_UNNAMED = 'A development team is selected, and pipelines you run belong to it.'
TEAM_NONE = 'No development team is selected, and every pipeline you run needs one.'
TEAM_NONE_NEXT = (
    'In RocketRide, open Account > Profile and choose your development team. '
    'If no team is listed, ask a workspace admin to add you to one.'
)
TEAM_CANNOT_RUN = 'You don\'t have permission to run pipelines in your development team, "{team}".'
TEAM_CANNOT_RUN_UNNAMED = "You don't have permission to run pipelines in your development team."
TEAM_CANNOT_RUN_NEXT = (
    'In RocketRide, open Account > Profile and choose another development team, '
    'or ask a workspace admin for permission to run pipelines on this one.'
)

CREDITS_NOT_YET = 'RocketRide can check compute credits once the account is activated.'
CREDITS_SELF_HOSTED = "Compute credits don't apply to a self-hosted engine."
CREDITS_AVAILABLE = 'This workspace has {credits} compute credits.'
CREDITS_LOW = 'This workspace has no compute credits left, but it can still run pipelines for now.'
CREDITS_NONE = "This workspace has no compute credits left, so pipelines can't run."
CREDITS_BLOCKED = "This workspace can't use its compute credits right now, so pipelines can't run."
# One step for every credits state: whoever reads it knows what to do, admin or not.
BILLING_NEXT = (
    "In RocketRide, a workspace admin can open Account > Billing to manage this workspace's compute credits. "
    "If you're not one, ask a workspace admin to do it."
)
CREDITS_UNKNOWN = "RocketRide couldn't check this workspace's compute credits just now."
CREDITS_TRY_AGAIN = 'Ask me to check the compute credits again in a moment.'

MODEL_NOT_YET = 'RocketRide can check saved AI model keys once the account is activated.'
MODEL_HOSTED = (
    "OpenAI models can run on RocketRide without a key of your own. They use this workspace's compute credits."
)
MODEL_HOSTED_OTHERS = 'Other AI providers need your own key, saved in RocketRide under Settings > Variables.'
MODEL_HOSTED_OTHERS_SAVED = 'Any other AI provider needs your own key, saved in RocketRide under Settings > Variables.'
MODEL_SAVED_ONE = 'RocketRide has a saved AI model key for {providers}.'
MODEL_SAVED_MANY = 'RocketRide has saved AI model keys for {providers}.'
MODEL_NONE = 'No AI model key is saved.'
MODEL_NONE_NEXT = (
    'If a pipeline uses a model from a provider such as OpenAI or Anthropic, get an API key from that provider. '
    "In RocketRide, open Settings > Variables and add it there. Don't paste the key into this chat."
)
MODEL_UNKNOWN = "RocketRide couldn't check saved AI model keys just now."
MODEL_MAYBE = "RocketRide can't tell whether a saved variable is an AI model key for {providers}."
MODEL_TRY_AGAIN = 'Ask me to check the saved AI model keys again in a moment.'

SUMMARY_READY = 'This RocketRide account is ready to run pipelines.'
SUMMARY_LOW = 'This RocketRide account can still run pipelines for now, but this workspace has no compute credits left.'
SUMMARY_NO_KEY = 'No AI model key is saved yet.'
SUMMARY_BLOCKED = "This RocketRide account can't run pipelines right now."
SUMMARY_NO_CREDITS = 'This workspace has no compute credits left.'
SUMMARY_CREDITS_BLOCKED = "This workspace can't use its compute credits."
SUMMARY_UNKNOWN = (
    "RocketRide couldn't check this workspace's compute credits, so it can't confirm the account is ready to run "
    'pipelines.'
)

# For the agent, not the user: how to find the variable name a provider needs.
MODEL_HINT = (
    "For the exact variable name a provider needs, call list_integrations with that provider's name. "
    'After the user adds a key, call list_integrations to confirm.'
)
MODEL_CONFIRM_HINT = (
    "Call list_integrations with that provider's name to see which saved variables may hold its key, "
    'and confirm with the user before using one.'
)


def _check(check_id: str, ok: Optional[bool], detail: str, next_step: Optional[str] = None, **extra: Any) -> dict:
    """Build one check row; ``next_step`` appears only when there is one."""
    row: Dict[str, Any] = {'id': check_id, 'ok': ok, 'detail': detail}
    if next_step:
        row['next_step'] = next_step
    row.update(extra)
    return row


def _format_credits(value: float) -> str:
    """Show a balance the way the Billing page does: 12,500 or 12,499.6."""
    if value == int(value):
        return f'{int(value):,}'
    return f'{value:,.1f}'


def _access_check(status: dict) -> dict:
    if status.get('edition') != 'cloud':
        return _check('access', True, ACCESS_SELF_HOSTED)
    if status.get('waitlisted'):
        return _check('access', False, WAITLISTED, WAITLISTED_NEXT)
    return _check('access', True, ACCESS_ACTIVE)


def _team_check(status: dict, waitlisted: bool) -> dict:
    if waitlisted:
        return _check('team', None, TEAM_NOT_YET)
    team = status.get('devTeam') or {}
    if not team.get('selected'):
        return _check('team', False, TEAM_NONE, TEAM_NONE_NEXT)
    name = team.get('name') or ''
    if team.get('canRun'):
        return _check('team', True, TEAM_CAN_RUN.format(team=name) if name else TEAM_CAN_RUN_UNNAMED)
    detail = TEAM_CANNOT_RUN.format(team=name) if name else TEAM_CANNOT_RUN_UNNAMED
    return _check('team', False, detail, TEAM_CANNOT_RUN_NEXT)


def _credits_check(status: dict, waitlisted: bool) -> dict:
    credits = status.get('credits') or {}
    if not credits.get('applies'):
        return _check('credits', True, CREDITS_SELF_HOSTED)
    if waitlisted:
        return _check('credits', None, CREDITS_NOT_YET)
    can_spend = credits.get('canSpend')
    tokens = credits.get('tokens')
    if can_spend is None or not isinstance(tokens, (int, float)) or isinstance(tokens, bool):
        return _check('credits', None, CREDITS_UNKNOWN, CREDITS_TRY_AGAIN)
    # A workspace may keep spending a little below zero. A zero or negative
    # balance is never shown as a number: "-3.2 credits" helps nobody.
    balance = round(float(tokens), 1)
    extra = {'tokens': balance} if balance > 0 else {}
    if not can_spend:
        # The backend may refuse for a reason other than an empty balance.
        if balance > 0:
            return _check('credits', False, CREDITS_BLOCKED, BILLING_NEXT, **extra)
        return _check('credits', False, CREDITS_NONE, BILLING_NEXT)
    if balance <= 0:
        return _check('credits', True, CREDITS_LOW, BILLING_NEXT)
    return _check('credits', True, CREDITS_AVAILABLE.format(credits=_format_credits(balance)), **extra)


def _join(names: List[str]) -> str:
    """Join names the way a sentence lists them: A, A and B, or A, B and C."""
    return names[0] if len(names) == 1 else ', '.join(names[:-1]) + ' and ' + names[-1]


async def _model_providers(client, env_keys: List[str]) -> Tuple[List[str], List[str]]:
    """The AI providers with a saved key, and those that may have one under another name.

    A provider has a saved key when any variable name the credentials catalog
    suggests for its ``llm_*`` integration is among ``env_keys``. That is
    presence, not readiness: Gemini suggests two names and either one means a
    key is saved (``list_integrations`` says whether its setup is complete). A
    provider may have one when the catalog finds only candidate names, such as
    a custom variable name that mentions the provider. A candidate is never
    reported as a saved key. Integrations that need no key (``wire`` off) never
    count. Integrations that suggest the same variables (OpenAI and the
    OpenAI-compatible node) are named once, by the shortest node name. Names
    come from the engine's node titles, with the catalog title as the fallback.
    """
    catalog = credentials_mod.load_catalog()
    have = set(env_keys)
    saved: Dict[frozenset, Any] = {}
    maybe: Dict[frozenset, Any] = {}
    for name, spec in sorted(catalog.items(), key=lambda item: (len(item[0]), item[0])):
        if not name.startswith('llm_') or not spec.wire:
            continue
        variables = frozenset(f.suggests for f in spec.fields)
        if variables & have:
            saved.setdefault(variables, spec)
        elif credentials_mod.evaluate(spec, env_keys)['candidates']:
            maybe.setdefault(variables, spec)
    maybe = {variables: spec for variables, spec in maybe.items() if variables not in saved}
    if not saved and not maybe:
        return [], []
    try:
        services, err = await engine_call(client.get_services(), 'account_status')
    except Exception:  # noqa: BLE001 - the titles are cosmetic; the catalog's will do
        services, err = None, True
    definitions = {} if err else ((services or {}).get('services') or {})

    def titles(specs: Dict[frozenset, Any]) -> List[str]:
        found = set()
        for spec in specs.values():
            definition = definitions.get(spec.name)
            title = definition.get('title') if isinstance(definition, dict) else None
            found.add(title or spec.title)
        return sorted(found, key=str.lower)

    return titles(saved), titles(maybe)


async def _model_key_check(client, status: dict, waitlisted: bool) -> Tuple[dict, Optional[str]]:
    """The model_key row, and the hint for the agent that goes with it, if any."""
    if waitlisted:
        return _check('model_key', None, MODEL_NOT_YET, blocking=False), None
    env_keys = status.get('envKeys')
    saved, maybe = await _model_providers(client, env_keys) if isinstance(env_keys, list) else ([], [])
    saved_text = (
        (MODEL_SAVED_ONE if len(saved) == 1 else MODEL_SAVED_MANY).format(providers=_join(saved)) if saved else ''
    )
    if HOSTED_OPENAI_CAPABILITY in (status.get('capabilities') or []):
        others = MODEL_HOSTED_OTHERS_SAVED if saved else MODEL_HOSTED_OTHERS
        return _check(
            'model_key', True, ' '.join(filter(None, [MODEL_HOSTED, saved_text, others])), blocking=False
        ), None
    if not isinstance(env_keys, list):
        return _check('model_key', None, MODEL_UNKNOWN, MODEL_TRY_AGAIN, blocking=False), None
    if saved:
        return _check('model_key', True, saved_text, blocking=False), None
    if maybe:
        detail = MODEL_MAYBE.format(providers=_join(maybe))
        return _check('model_key', None, detail, blocking=False), MODEL_CONFIRM_HINT
    return _check('model_key', False, MODEL_NONE, MODEL_NONE_NEXT, blocking=False), MODEL_HINT


def _summary(access: dict, team: dict, credits: dict, model_key: dict) -> str:
    """Name everything that stops a run, or say the account is ready."""
    if access['ok'] is False:
        return WAITLISTED
    blockers = []
    if team['ok'] is False:
        blockers.append(team['detail'])
    if credits['ok'] is False:
        blockers.append(SUMMARY_CREDITS_BLOCKED if credits['detail'] == CREDITS_BLOCKED else SUMMARY_NO_CREDITS)
    if blockers:
        return ' '.join([SUMMARY_BLOCKED, *blockers])
    if credits['ok'] is None:
        return SUMMARY_UNKNOWN
    ready = SUMMARY_LOW if credits['detail'] == CREDITS_LOW else SUMMARY_READY
    if model_key['ok'] is False:
        return f'{ready} {SUMMARY_NO_KEY}'
    if model_key['ok'] is None:
        return f'{ready} {model_key["detail"]}'
    return ready


async def _account_status(client, tasks, args: Dict[str, Any]) -> dict:
    try:
        status, err = await engine_call(client.get_account_status(), 'account_status')
    except RuntimeError as exc:
        # An engine older than rrext_account_status refuses it by name.
        if 'unsupported command' not in str(exc).lower():
            raise
        status, err = None, None
    if err:
        return err
    if not isinstance(status, dict) or status.get('edition') not in ('cloud', 'self-hosted'):
        return {
            'ok': False,
            'error_type': 'Unavailable',
            'message': "This RocketRide engine can't report account status. If you run the engine yourself, "
            'updating it adds this check. In RocketRide, open Account > Profile to check your account now.',
            'hint': 'Tell the user this message as written.',
        }

    waitlisted = status.get('edition') == 'cloud' and bool(status.get('waitlisted'))
    access = _access_check(status)
    team = _team_check(status, waitlisted)
    credits = _credits_check(status, waitlisted)
    model_key, model_hint = await _model_key_check(client, status, waitlisted)

    result = {
        'ok': True,
        'ready': all(check['ok'] is True for check in (access, team, credits)),
        'edition': status['edition'],
        'summary': _summary(access, team, credits, model_key),
        'checks': [access, team, credits, model_key],
    }
    if model_hint:
        result['hint'] = model_hint
    return result


def register(registry: ToolRegistry) -> None:
    """Register the account readiness tool against ``registry``."""
    registry.register(
        'account_status',
        'Use this when the user asks whether their RocketRide account can run pipelines, or asks about its '
        'waitlist status, development team, compute credits or saved AI model keys. Also use it before the '
        "user's first run in a conversation, and when a run is refused with error_type NoDevelopmentTeam or with "
        'a message about credits or a denied permission. After a run refused with error_type AccountWaitlisted, '
        'relay that message instead. Tell the user the summary and every next_step, as written. When the user '
        "asked about one check, also give that check's detail. When ready is false, leave out a check with "
        'blocking false unless the pipeline uses an AI model or the user asked about it. The result never holds '
        'key values or variable names.',
        {'type': 'object', 'properties': {}},
        hints=ToolHints.reads("Reads the caller's own account readiness. Returns no secrets and changes nothing."),
    )(_account_status)
