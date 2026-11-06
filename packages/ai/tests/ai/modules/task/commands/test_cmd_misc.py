"""
Unit tests for ai.modules.task.commands.cmd_misc.MiscCommands.

Three categories:

- ``_mask_apikey`` / ``_resolve_monitor_label`` — pure static helpers.
- ``on_rrext_services`` / ``on_rrext_validate`` — thin handlers that
  delegate to rocketlib + ``resolve_implied_source``. Mock those.
- ``on_rrext_dashboard`` — large method that walks ``_task_control`` and
  ``_connections``. We cover the happy paths (caller filtering,
  tk_ scoping) with seeded state and bypassed __init__.
"""

from __future__ import annotations

import copy
import hashlib
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.modules.task.commands import cmd_misc
from ai.modules.task.commands.cmd_misc import MiscCommands


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_conn(*, account_info=None, server=None, connection_id=1):
    """Build a MiscCommands instance with __init__ bypassed."""
    conn = MiscCommands.__new__(MiscCommands)
    conn._account_info = account_info
    conn._server = server or MagicMock()
    conn._connection_id = connection_id
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn.debug_message = MagicMock()
    conn.verify_permission = MagicMock()  # no-op (granted) by default
    return conn


# ---------------------------------------------------------------------------
# _mask_apikey
# ---------------------------------------------------------------------------


def test_mask_apikey_short_value_is_fully_masked():
    """Strings 8 chars or shorter are returned as '****'."""
    assert MiscCommands._mask_apikey('') == '****'
    assert MiscCommands._mask_apikey('abc') == '****'
    assert MiscCommands._mask_apikey('12345678') == '****'  # boundary


def test_mask_apikey_long_value_shows_first_and_last_four():
    """Longer strings keep the first 4 and last 4 characters with **** in the middle."""
    assert MiscCommands._mask_apikey('abcdefghij') == 'abcd****ghij'
    assert MiscCommands._mask_apikey('ak_secret_1234567890') == 'ak_s****7890'


def test_mask_apikey_handles_none():
    """A None input is treated as 'short' and returns '****'."""
    assert MiscCommands._mask_apikey(None) == '****'


# ---------------------------------------------------------------------------
# _resolve_monitor_label
# ---------------------------------------------------------------------------


def test_resolve_monitor_label_wildcard():
    """The '*' wildcard maps to 'All tasks'."""
    assert MiscCommands._resolve_monitor_label('*', {}, {}) == 'All tasks'


def test_resolve_monitor_label_unrecognised_key():
    """Any key not starting with 'p.' falls back to 'Task monitor'."""
    assert MiscCommands._resolve_monitor_label('foo', {}, {}) == 'Task monitor'


# Keys carry the owner_key layout p.{runKind}.{owner}.{project}.{source}
# (the leading runKind segment separates a user's dev run from their @me
# deploy). The label resolver reads project from segment 2 and source from
# segment 3 — NOT 1/2 as the pre-runKind layout did.
def test_resolve_monitor_label_project_wildcard():
    """A 'p.<runKind>.<owner>.<id>.*' key uses the project label + '.*'."""
    project_names = {'proj-1': 'my-project'}
    assert MiscCommands._resolve_monitor_label('p.dev.user-1.proj-1.*', project_names, {}) == 'my-project.*'


def test_resolve_monitor_label_project_only():
    """A 'p.<runKind>.<owner>.<id>' key (no source) yields '<project>.*'."""
    project_names = {'proj-1': 'my-project'}
    assert MiscCommands._resolve_monitor_label('p.dev.user-1.proj-1', project_names, {}) == 'my-project.*'


def test_resolve_monitor_label_with_source():
    """A 'p.<runKind>.<owner>.<id>.<source>' key uses project + source friendly names."""
    project_names = {'proj-1': 'my-project'}
    source_names = {'proj-1.src-1': 'reader'}
    result = MiscCommands._resolve_monitor_label('p.deploy.user-1.proj-1.src-1', project_names, source_names)
    assert result == 'my-project.reader'


def test_resolve_monitor_label_reads_project_not_owner_segment():
    """Regression: the owner segment must NOT be read as the project. A key
    whose owner id would resolve to a friendly name if mis-indexed proves the
    resolver reads segment 2 (project), not segment 1 (owner).
    """
    # If the resolver wrongly read segment 1 (owner 'user-1') as the project,
    # it would emit 'owner-label'; reading segment 2 (proj-1) emits my-project.
    project_names = {'proj-1': 'my-project', 'user-1': 'owner-label'}
    assert MiscCommands._resolve_monitor_label('p.dev.user-1.proj-1.*', project_names, {}) == 'my-project.*'


def test_resolve_monitor_label_truncates_project_id_when_no_friendly_name():
    """Unknown project ids are truncated to 8 characters."""
    result = MiscCommands._resolve_monitor_label('p.dev.user-1.proj-very-long-id-here.*', {}, {})
    assert result.startswith('proj-ver')


# ---------------------------------------------------------------------------
# _build_monitors_list
# ---------------------------------------------------------------------------


def test_build_monitors_list_resolves_keys_and_flag_names():
    """Each (key, flags) pair becomes a {key: label, flags: names} dict."""
    from rocketride import EVENT_TYPE

    monitors = {
        'p.deploy.user-1.proj-1.src-1': EVENT_TYPE.SUMMARY,
        '*': EVENT_TYPE.SUMMARY,
    }
    project_names = {'proj-1': 'my-project'}
    source_names = {'proj-1.src-1': 'reader'}

    out = MiscCommands._build_monitors_list(monitors, project_names, source_names)

    # Sort for stability: order isn't part of the contract here.
    out_by_key = {item['key']: item['flags'] for item in out}
    assert 'my-project.reader' in out_by_key
    assert 'All tasks' in out_by_key
    # Each flag list contains at least 'summary'.
    assert 'summary' in out_by_key['my-project.reader']


# ---------------------------------------------------------------------------
# on_rrext_services
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_services_returns_specific_service(monkeypatch):
    """When `arguments.service` is set, return that single full entry."""
    schema = {'name': 'ocr', 'fields': []}

    async def fake_get_service(name):
        return schema if name == 'ocr' else None

    monkeypatch.setattr(cmd_misc.services_catalog, 'get_service', fake_get_service)

    conn = _make_conn()
    result = await MiscCommands.on_rrext_services(conn, {'arguments': {'service': 'ocr'}})

    assert result == {'type': 'response', 'body': schema}


@pytest.mark.asyncio
async def test_on_rrext_services_unknown_service_raises(monkeypatch):
    """An unknown service id raises ValueError (re-raised after debug log)."""

    async def fake_get_service(name):
        return None

    monkeypatch.setattr(cmd_misc.services_catalog, 'get_service', fake_get_service)

    conn = _make_conn()
    with pytest.raises(ValueError, match="Service 'unknown' not found"):
        await MiscCommands.on_rrext_services(conn, {'arguments': {'service': 'unknown'}})
    conn.debug_message.assert_called()


@pytest.mark.asyncio
async def test_on_rrext_services_no_service_returns_summary(monkeypatch):
    """Without a `service` arg, the cached summary body is returned."""
    summary = {'services': {'a': {'title': 'A'}}, 'version': 7}

    async def fake_get_summary():
        return summary

    monkeypatch.setattr(cmd_misc.services_catalog, 'get_summary', fake_get_summary)

    conn = _make_conn()
    result = await MiscCommands.on_rrext_services(conn, {})
    assert result['body'] == summary


# ---------------------------------------------------------------------------
# on_rrext_validate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_validate_uses_explicit_source(monkeypatch):
    """`arguments.source` takes priority over pipeline.source and the implied source."""
    monkeypatch.setattr(cmd_misc, 'resolve_implied_source', lambda p: 'never-used')
    captured = {}

    def _fake_validate(payload):
        """Capture the payload so the test can assert on it."""
        captured['payload'] = payload
        return {'ok': True}

    monkeypatch.setattr(cmd_misc, 'validatePipeline', _fake_validate)

    conn = _make_conn()
    request = {
        'arguments': {
            'pipeline': {'components': [], 'source': 'pipeline-source'},
            'source': 'explicit-source',
        },
    }
    result = await MiscCommands.on_rrext_validate(conn, request)

    # The resolved source and the default version both ride inside
    # payload['pipeline'] — the same envelope pipe_Validate builds.
    assert captured['payload']['pipeline']['source'] == 'explicit-source'
    assert captured['payload']['pipeline']['version'] == 1  # default
    assert result == {'type': 'response', 'body': {'ok': True}}


@pytest.mark.asyncio
async def test_on_rrext_validate_falls_back_to_pipeline_source(monkeypatch):
    """When `arguments.source` is missing, `pipeline.source` is used."""
    captured = {}
    monkeypatch.setattr(
        cmd_misc,
        'validatePipeline',
        lambda payload: captured.update(payload) or {'ok': True},
    )

    conn = _make_conn()
    request = {'arguments': {'pipeline': {'source': 'pipeline-source', 'components': []}}}
    await MiscCommands.on_rrext_validate(conn, request)
    assert captured['pipeline']['source'] == 'pipeline-source'


@pytest.mark.asyncio
async def test_on_rrext_validate_falls_back_to_implied_source(monkeypatch):
    """When neither explicit nor pipeline.source is set, resolve_implied_source is used."""
    captured = {}
    monkeypatch.setattr(cmd_misc, 'resolve_implied_source', lambda p: 'implied')
    monkeypatch.setattr(
        cmd_misc,
        'validatePipeline',
        lambda payload: captured.update(payload) or {'ok': True},
    )

    conn = _make_conn()
    await MiscCommands.on_rrext_validate(conn, {'arguments': {'pipeline': {}}})
    assert captured['pipeline'].get('source') == 'implied'


@pytest.mark.asyncio
async def test_on_rrext_validate_no_source_anywhere_omits_field(monkeypatch):
    """If no source can be resolved, the field is left out of the payload."""
    captured = {}
    monkeypatch.setattr(cmd_misc, 'resolve_implied_source', lambda p: None)
    monkeypatch.setattr(
        cmd_misc,
        'validatePipeline',
        lambda payload: captured.update(payload) or {'ok': True},
    )

    conn = _make_conn()
    await MiscCommands.on_rrext_validate(conn, {'arguments': {'pipeline': {'components': []}}})
    # The wrapped payload's inner config is where a source would land — the
    # top level never carries one, so assert on the inner shape.
    assert 'source' not in captured['pipeline']


@pytest.mark.asyncio
async def test_on_rrext_validate_wraps_config_in_pipeline_envelope(monkeypatch):
    """The C++ payload is {'pipeline': <config>} — the same envelope pipe_Validate
    (modules/pipe) builds. Regression test: passing the config flat makes
    validatePipeline reject every pipeline with "'pipeline' is missing or invalid".
    """
    captured = {}
    monkeypatch.setattr(cmd_misc, 'resolve_implied_source', lambda p: None)
    monkeypatch.setattr(
        cmd_misc,
        'validatePipeline',
        lambda payload: captured.update(payload) or {'ok': True},
    )

    conn = _make_conn()
    config = {'components': [{'id': 'webhook_1'}], 'project_id': 'p1'}
    await MiscCommands.on_rrext_validate(conn, {'arguments': {'pipeline': config}})

    assert set(captured.keys()) == {'pipeline'}
    assert captured['pipeline']['components'] == [{'id': 'webhook_1'}]
    assert captured['pipeline']['project_id'] == 'p1'
    assert captured['pipeline']['version'] == 1


@pytest.mark.asyncio
async def test_on_rrext_validate_does_not_double_wrap_enveloped_config(monkeypatch):
    """An already-enveloped config is wrapped exactly once.

    The MCP ``validate_pipeline`` tool (modules/mcp/tools/introspection.py, #2082)
    pre-wraps the config client-side as a workaround for the missing envelope.
    Double-wrapping it would make every MCP validation fail with
    "'pipeline.components' must be an array".
    """
    captured = {}
    monkeypatch.setattr(cmd_misc, 'resolve_implied_source', lambda p: None)
    monkeypatch.setattr(
        cmd_misc,
        'validatePipeline',
        lambda payload: captured.update(payload) or {'ok': True},
    )

    conn = _make_conn()
    enveloped = {'pipeline': {'components': [{'id': 'webhook_1'}], 'version': 1}}
    await MiscCommands.on_rrext_validate(conn, {'arguments': {'pipeline': enveloped}})

    assert set(captured.keys()) == {'pipeline'}
    assert 'pipeline' not in captured['pipeline']
    assert captured['pipeline']['components'] == [{'id': 'webhook_1'}]
    assert captured['pipeline']['version'] == 1


@pytest.mark.asyncio
async def test_on_rrext_validate_does_not_wrap_single_component_payload(monkeypatch):
    """The node config panel validates one component at a time.

    It sends IComponentValidatePayload — {version, component} — the shape the
    shell contract declares this endpoint accepts (shell/src/types/project.ts).
    The engine dispatches on a root-level ``component`` (#2263); wrapping that
    payload as {'pipeline': ...} hides the key and every save comes back with
    "'pipeline.components' must be an array", whatever the node.
    """
    captured = {}
    monkeypatch.setattr(cmd_misc, 'resolve_implied_source', lambda p: None)
    monkeypatch.setattr(
        cmd_misc,
        'validatePipeline',
        lambda payload: captured.update(payload) or {'ok': True},
    )

    conn = _make_conn()
    component = {'id': 'llm_gemini_1', 'provider': 'llm_gemini', 'config': {}}
    await MiscCommands.on_rrext_validate(conn, {'arguments': {'pipeline': {'version': 1, 'component': component}}})

    assert set(captured.keys()) == {'version', 'component'}
    assert captured['component'] == component
    assert 'pipeline' not in captured
    assert 'components' not in captured


@pytest.mark.asyncio
async def test_on_rrext_validate_does_not_infer_source_for_a_single_component(monkeypatch):
    """Source inference is a full-pipeline concern; a lone component is passed through."""
    seen = []
    monkeypatch.setattr(cmd_misc, 'resolve_implied_source', lambda p: seen.append(p) or 'webhook_1')
    captured = {}
    monkeypatch.setattr(
        cmd_misc,
        'validatePipeline',
        lambda payload: captured.update(payload) or {'ok': True},
    )

    conn = _make_conn()
    component = {'id': 'webhook_1', 'provider': 'webhook', 'config': {'mode': 'Source'}}
    await MiscCommands.on_rrext_validate(conn, {'arguments': {'pipeline': {'version': 1, 'component': component}}})

    assert seen == []
    assert captured['component'] == component
    assert 'source' not in captured


@pytest.mark.asyncio
async def test_on_rrext_validate_leaves_a_full_pipeline_alone(monkeypatch):
    """A config that already carries components is untouched."""
    captured = {}
    monkeypatch.setattr(cmd_misc, 'resolve_implied_source', lambda p: None)
    monkeypatch.setattr(
        cmd_misc,
        'validatePipeline',
        lambda payload: captured.update(payload) or {'ok': True},
    )

    conn = _make_conn()
    components = [{'id': 'webhook_1'}, {'id': 'llm_gemini_1'}]
    await MiscCommands.on_rrext_validate(conn, {'arguments': {'pipeline': {'version': 1, 'components': components}}})

    assert captured['pipeline']['components'] == components


@pytest.mark.asyncio
async def test_on_rrext_validate_propagates_validate_pipeline_errors(monkeypatch):
    """A raise from validatePipeline is logged and re-raised."""
    monkeypatch.setattr(cmd_misc, 'resolve_implied_source', lambda p: 'src')
    monkeypatch.setattr(
        cmd_misc,
        'validatePipeline',
        MagicMock(side_effect=RuntimeError('invalid pipeline')),
    )

    conn = _make_conn()
    with pytest.raises(RuntimeError, match='invalid pipeline'):
        await MiscCommands.on_rrext_validate(conn, {'arguments': {'pipeline': {}}})
    conn.debug_message.assert_called()


# ---------------------------------------------------------------------------
# on_rrext_validate — the reply returns the config as submitted
# ---------------------------------------------------------------------------

# Invented values the handler expands these references to before validating.
SERVICE_TOKEN_REF = '${ROCKETRIDE_SERVICE_TOKEN}'
SERVICE_TOKEN_VALUE = 'configured-value-xyz'
CUSTOM_MODEL_REF = '${ROCKETRIDE_CUSTOM_MODEL}'
CUSTOM_MODEL_VALUE = 'custom-endpoint-val-123'
ENV = {'ROCKETRIDE_SERVICE_TOKEN': SERVICE_TOKEN_VALUE, 'ROCKETRIDE_CUSTOM_MODEL': CUSTOM_MODEL_VALUE}


def _template_message(env, kind):
    references = ', '.join('${' + name + '}' for name in sorted(env))
    return f'Pipeline validation {kind} for config with template references: {references}'


def _validate_conn(monkeypatch, env=None):
    """A connection whose account environment is ``env`` (default ``ENV``)."""
    from ai.account import account

    merged = AsyncMock(return_value=ENV if env is None else env)
    monkeypatch.setattr(account, 'get_merged_env', merged)
    return _make_conn(account_info=SimpleNamespace(userId='user-1', devTeam='', organization=None))


def _llm(component_id, provider):
    """An LLM component that uses the references in fields, an inactive profile, text and a key name."""
    return {
        'id': component_id,
        'provider': provider,
        'config': {
            'profile': 'openai-4o-mini',
            'openai-4o-mini': {'apikey': SERVICE_TOKEN_REF, 'model': CUSTOM_MODEL_REF},
            'spare': {'apikey': SERVICE_TOKEN_REF},
            'note': f'served from {SERVICE_TOKEN_REF}',
            CUSTOM_MODEL_REF: 'keyed',
        },
    }


def _fake_validator(payload):
    """Stand in for the engine's validator, returning a new root.

    For ``llm_openai`` each ``apikey`` moves into ``secureParameters`` under a
    stand-in token that depends on the moved value, so two runs over the same
    input agree. Each ``model`` gets an error that quotes it, and a warning
    quotes the whole input.
    """
    root = copy.deepcopy(payload)
    components = root['pipeline']['components'] if 'pipeline' in root else [root['component']]
    errors = []
    for component in components:
        for section in component['config'].values():
            if not isinstance(section, dict):
                continue
            if component['provider'] == 'llm_openai' and 'apikey' in section:
                moved = json.dumps({'apikey': section.pop('apikey')}).encode()
                section['secureParameters'] = {'secure': ['apikey'], 'token': hashlib.sha256(moved).hexdigest()}
            if 'model' in section:
                errors.append({'message': f'model {section["model"]} is not available', 'id': component['id']})
    root['warnings'] = [{'message': f'checked {json.dumps(payload)}'}]
    root['errors'] = errors
    return root


async def _reply(conn, pipeline):
    """The body the handler sends back for ``pipeline``."""
    return (await MiscCommands.on_rrext_validate(conn, {'arguments': {'pipeline': pipeline}}))['body']


def _has_expanded_value(value):
    """Whether ``value`` holds either expanded value from ``ENV`` anywhere."""
    text = json.dumps(value)
    return SERVICE_TOKEN_VALUE in text or CUSTOM_MODEL_VALUE in text


@pytest.mark.asyncio
@pytest.mark.parametrize('enveloped', [False, True])
async def test_on_rrext_validate_returns_submitted_config_when_env_expanded(monkeypatch, enveloped):
    """Validation sees the expanded values; the reply is the submitted config, validated.

    Covers a misspelled provider, a known provider whose key moves into
    secureParameters, ordinary fields, an inactive profile, text, a key name,
    and the errors and warnings.
    """
    calls = []
    monkeypatch.setattr(cmd_misc, 'validatePipeline', lambda payload: calls.append(payload) or _fake_validator(payload))
    conn = _validate_conn(monkeypatch)
    config = {'components': [_llm('llm_1', 'llm_openai'), _llm('llm_2', 'llm_opnai')], 'source': 'llm_1'}
    request = {'arguments': {'pipeline': {'pipeline': config} if enveloped else config}}
    sent = copy.deepcopy(request)

    reply = (await MiscCommands.on_rrext_validate(conn, request))['body']

    assert _has_expanded_value(calls[0])
    submitted = {'pipeline': {**config, 'version': 1}}
    assert reply['pipeline'] == _fake_validator(submitted)['pipeline']
    assert not _has_expanded_value(reply)
    assert reply['errors'] == [
        {'message': _template_message(ENV, 'error'), 'id': 'llm_1'},
        {'message': _template_message(ENV, 'error'), 'id': 'llm_2'},
    ]
    assert reply['warnings'] == [{'message': _template_message(ENV, 'warning')}]
    assert request == sent


@pytest.mark.asyncio
async def test_on_rrext_validate_single_component_returns_submitted_config(monkeypatch):
    """The node panel's {version, component} form: validated expanded, echoed as submitted."""
    calls = []
    monkeypatch.setattr(cmd_misc, 'validatePipeline', lambda payload: calls.append(payload) or _fake_validator(payload))
    conn = _validate_conn(monkeypatch)
    component = _llm('llm_1', 'llm_openai')
    request = {'arguments': {'pipeline': {'version': 1, 'component': component, 'extra': CUSTOM_MODEL_REF}}}
    sent = copy.deepcopy(request)

    reply = (await MiscCommands.on_rrext_validate(conn, request))['body']

    assert set(calls[0]) == {'version', 'component', 'extra'}
    assert _has_expanded_value(calls[0]['component'])
    direct = _fake_validator({'pipeline': {'version': 1, 'components': [component]}})
    assert reply['component'] == direct['pipeline']['components'][0]
    assert reply['extra'] == CUSTOM_MODEL_REF
    assert reply['errors'] == [{'message': _template_message(ENV, 'error'), 'id': 'llm_1'}]
    assert not _has_expanded_value(reply)
    assert request == sent


@pytest.mark.asyncio
async def test_on_rrext_validate_short_values_keep_structural_fields(monkeypatch):
    """Values such as 'error' and '1' do not change diagnostic keys, ids or tokens."""
    monkeypatch.setattr(cmd_misc, 'validatePipeline', _fake_validator)
    conn = _validate_conn(monkeypatch, env={'ROCKETRIDE_LEVEL': 'error', 'ROCKETRIDE_SERVICE_TOKEN': '1'})
    component = _llm('llm_1', 'llm_openai')
    component['config']['level'] = '${ROCKETRIDE_LEVEL}'

    reply = await _reply(conn, {'version': 1, 'component': component})

    assert set(reply) == {'version', 'component', 'errors', 'warnings'}
    assert reply['errors'][0]['id'] == 'llm_1'
    direct = _fake_validator({'pipeline': {'version': 1, 'components': [component]}})
    assert reply['component'] == direct['pipeline']['components'][0]
    assert reply['component']['config']['level'] == '${ROCKETRIDE_LEVEL}'


@pytest.mark.asyncio
async def test_on_rrext_validate_maps_component_ids_back(monkeypatch):
    """A component id written as a reference comes back as the reference in diagnostics."""
    monkeypatch.setattr(cmd_misc, 'validatePipeline', _fake_validator)
    env = {'ROCKETRIDE_NODE_ID': 'node-7', 'ROCKETRIDE_CUSTOM_MODEL': CUSTOM_MODEL_VALUE}
    conn = _validate_conn(monkeypatch, env=env)
    pipeline = {'components': [_llm('${ROCKETRIDE_NODE_ID}', 'llm_opnai')]}

    full = await _reply(conn, pipeline)
    single = await _reply(conn, {'version': 1, 'component': _llm('${ROCKETRIDE_NODE_ID}', 'llm_opnai')})

    expected = [{'message': _template_message(env, 'error'), 'id': '${ROCKETRIDE_NODE_ID}'}]
    assert full['errors'] == expected
    assert single['errors'] == expected
    assert full['pipeline']['components'][0]['id'] == '${ROCKETRIDE_NODE_ID}'
    assert single['component']['id'] == '${ROCKETRIDE_NODE_ID}'


@pytest.mark.asyncio
async def test_on_rrext_validate_drops_diagnostics_the_caller_sends(monkeypatch):
    """Errors and warnings in a {version, component} payload are not passed to the validator."""
    calls = []

    def _validator(payload):
        """Append to the root's errors, as the engine does."""
        calls.append(payload)
        root = copy.deepcopy(payload)
        root.setdefault('errors', []).append({'message': 'checked', 'id': 'llm_1'})
        return root

    monkeypatch.setattr(cmd_misc, 'validatePipeline', _validator)
    conn = _validate_conn(monkeypatch)
    supplied = [{'message': 'x', 'id': CUSTOM_MODEL_REF, CUSTOM_MODEL_REF: CUSTOM_MODEL_REF}]
    payload = {'version': 1, 'component': _llm('llm_1', 'llm_opnai'), 'errors': supplied, 'warnings': supplied}

    reply = await _reply(conn, payload)

    assert 'errors' not in calls[0]
    assert 'warnings' not in calls[0]
    assert reply['errors'] == [{'message': _template_message(ENV, 'error'), 'id': 'llm_1'}]
    assert 'warnings' not in reply
    assert not _has_expanded_value(reply)


@pytest.mark.asyncio
async def test_on_rrext_validate_without_substitution_validates_once(monkeypatch):
    """Nothing expanded, no second pass: the reply is the validator's result as before."""
    calls = []
    monkeypatch.setattr(cmd_misc, 'validatePipeline', lambda payload: calls.append(payload) or {'ok': True})
    conn = _validate_conn(monkeypatch, env={})
    request = {'arguments': {'pipeline': {'components': [_llm('llm_1', 'llm_opnai')]}}}

    result = await MiscCommands.on_rrext_validate(conn, request)

    assert len(calls) == 1
    assert result == {'type': 'response', 'body': {'ok': True}}


@pytest.mark.asyncio
async def test_on_rrext_validate_error_keeps_template_references(monkeypatch):
    """An exception that quotes expanded values reaches the log and the error reply with the references."""

    def _raise(payload):
        raise RuntimeError(f'engine rejected {json.dumps(payload)} and {SERVICE_TOKEN_VALUE}')

    monkeypatch.setattr(cmd_misc, 'validatePipeline', _raise)
    conn = _validate_conn(monkeypatch)
    pipeline = {'components': [_llm('llm_1', 'llm_opnai')]}
    request = {'seq': 7, 'command': 'rrext_validate', 'arguments': {'pipeline': pipeline}}

    # The dispatcher's own path: the handler raises, build_exception makes the reply
    handled, response = await MiscCommands._call_method(conn, request, 'on_rrext_validate', None)

    assert handled
    assert response['success'] is False
    assert response['message'] == _template_message(ENV, 'failed')
    assert not _has_expanded_value(response)
    assert not _has_expanded_value(str(conn.debug_message.call_args_list))


@pytest.mark.asyncio
@pytest.mark.parametrize('single', [False, True])
@pytest.mark.parametrize('kind', ['errors', 'warnings', 'exception'])
@pytest.mark.parametrize(
    'value, formatted',
    [
        (' configured-value-xyz ', 'configured-value-xyz'),
        ('Configured-Value-XYZ', 'configured-value-xyz'),
        ('configured\x07value', r'configured\x07value'),
        ('configured-value-xyz', 'configured-value'),
    ],
)
async def test_on_rrext_validate_transformed_messages_use_template_references(
    monkeypatch, single, kind, value, formatted
):
    """Diagnostic and exception formatting does not change the template-reference contract."""
    env = {'ROCKETRIDE_CUSTOM_MODEL': value}
    conn = _validate_conn(monkeypatch, env=env)
    calls = 0

    def validator(payload):
        nonlocal calls
        calls += 1
        if kind == 'exception':
            raise RuntimeError('invalid setting ' + formatted)
        result = copy.deepcopy(payload)
        if calls == 1:
            result[kind] = [{'id': 'node-1', 'ccode': 75, 'message': 'invalid setting ' + formatted}]
        return result

    monkeypatch.setattr(cmd_misc, 'validatePipeline', validator)
    component = {'id': 'node-1', 'provider': 'tool_git', 'config': {'authType': CUSTOM_MODEL_REF}}
    pipeline = {'version': 1, 'component': component} if single else {'components': [component]}
    request = {'seq': 7, 'command': 'rrext_validate', 'arguments': {'pipeline': pipeline}}
    handled, response = await MiscCommands._call_method(conn, request, 'on_rrext_validate', None)

    assert handled
    if kind == 'exception':
        assert response['success'] is False
        assert response['message'] == _template_message(env, 'failed')
        assert conn.debug_message.call_args_list
    else:
        message = _template_message(env, 'error' if kind == 'errors' else 'warning')
        assert response['body'][kind] == [{'id': 'node-1', 'ccode': 75, 'message': message}]
    assert formatted not in json.dumps(response)
    assert formatted not in str(conn.debug_message.call_args_list)


@pytest.mark.asyncio
@pytest.mark.parametrize('value', [' configured-value-xyz ', 'Configured-Value-XYZ', 'configured\x07value'])
async def test_on_rrext_validate_engine_formatted_messages_use_template_references(monkeypatch, value):
    """The native node validator may normalize or escape a configured setting."""
    if not cmd_misc.getServiceDefinition('tool_git'):
        pytest.skip('tool_git service definition is not loaded')
    env = {'ROCKETRIDE_CUSTOM_MODEL': value}
    conn = _validate_conn(monkeypatch, env=env)
    component = {'id': 'node-1', 'provider': 'tool_git', 'config': {'authType': CUSTOM_MODEL_REF}}

    reply = await _reply(conn, {'version': 1, 'component': component})

    assert reply.get('errors') or reply.get('warnings')
    for kind, label in (('errors', 'error'), ('warnings', 'warning')):
        assert all(entry['message'] == _template_message(env, label) for entry in reply.get(kind, []))
    assert reply['component']['config']['authType'] == CUSTOM_MODEL_REF


@pytest.mark.asyncio
@pytest.mark.parametrize('single', [False, True])
@pytest.mark.parametrize('field, original', [('id', []), ('provider', []), ('config', [])])
async def test_on_rrext_validate_engine_echoes_submitted_structural_types(monkeypatch, single, field, original):
    """A resolved key may replace a field whose submitted type the native pass cannot accept."""
    calls = _spy_validator(monkeypatch)
    env = {'ROCKETRIDE_FIELD': field}
    conn = _validate_conn(monkeypatch, env=env)
    component = {'id': 'node-1', 'provider': 'llm_openai', 'config': {'profile': ''}}
    replacement = component[field]
    component[field] = original
    component['${ROCKETRIDE_FIELD}'] = replacement
    pipeline = {'version': 1, 'component': component} if single else {'version': 1, 'components': [component]}
    sent = copy.deepcopy(pipeline)

    # Both forms use the native structural validator, without invoking node code.
    reply = await _reply(conn, pipeline)

    assert len(calls) == 1
    echoed = reply['component'] if single else reply['pipeline']['components'][0]
    assert echoed == component
    assert pipeline == sent


@pytest.mark.asyncio
@pytest.mark.parametrize('single', [False, True])
async def test_on_rrext_validate_second_pass_error_uses_template_references(monkeypatch, single):
    """Failures while building the echoed config follow the same message contract."""
    conn = _validate_conn(monkeypatch)
    calls = 0

    def validator(payload):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise ValueError('invalid configured-value')
        return _fake_validator(payload)

    monkeypatch.setattr(cmd_misc, 'validatePipeline', validator)
    component = _llm('llm_1', 'llm_opnai')
    pipeline = {'version': 1, 'component': component} if single else {'components': [component]}
    request = {'seq': 7, 'command': 'rrext_validate', 'arguments': {'pipeline': pipeline}}

    handled, response = await MiscCommands._call_method(conn, request, 'on_rrext_validate', None)

    assert handled
    assert calls == 2
    assert response['success'] is False
    assert response['message'] == _template_message(ENV, 'failed')
    assert 'configured-value' not in str(conn.debug_message.call_args_list)


def _with_fixed_tokens(value):
    """``value`` with every ``secureParameters`` token string replaced by one placeholder.

    The engine issues a new token string on every run, so two runs over the
    same config compare equal only with the token strings set aside.
    """
    if isinstance(value, dict):
        fixed = {key: _with_fixed_tokens(item) for key, item in value.items()}
        if isinstance(fixed.get('secureParameters'), dict) and 'token' in fixed['secureParameters']:
            fixed['secureParameters'] = {**fixed['secureParameters'], 'token': '<token>'}
        return fixed
    if isinstance(value, list):
        return [_with_fixed_tokens(item) for item in value]
    return value


def _spy_validator(monkeypatch):
    """Record each (payload, result) of the engine's own validator."""
    calls = []
    native = cmd_misc.validatePipeline

    def _spy(payload):
        sent = copy.deepcopy(payload)
        result = native(payload)
        calls.append((sent, result))
        return result

    monkeypatch.setattr(cmd_misc, 'validatePipeline', _spy)
    return calls


@pytest.mark.asyncio
async def test_on_rrext_validate_engine_returns_submitted_config(monkeypatch):
    """The engine's own validator: the reply matches validating the submitted config directly."""
    if not cmd_misc.getServiceDefinition('llm_openai'):
        pytest.skip('llm_openai service definition is not loaded')

    direct = cmd_misc.validatePipeline
    calls = _spy_validator(monkeypatch)
    conn = _validate_conn(monkeypatch)
    literal = {'id': 'llm_3', 'provider': 'llm_openai', 'config': {'profile': 'p', 'p': {'apikey': 'typed-literal'}}}
    components = [_llm('llm_1', 'llm_openai'), _llm('llm_2', 'llm_opnai'), literal]

    reply = await _reply(conn, {'version': 1, 'components': components})

    (expanded, _), (submitted, echoed) = calls
    assert _has_expanded_value(expanded)
    assert submitted == {'pipeline': {'version': 1, 'components': components}}
    assert reply['pipeline'] == echoed['pipeline']
    direct_pipeline = direct(copy.deepcopy(submitted))['pipeline']
    assert _with_fixed_tokens(reply['pipeline']) == _with_fixed_tokens(direct_pipeline)
    assert not _has_expanded_value(reply)

    llm_1, llm_2, llm_3 = reply['pipeline']['components']
    assert llm_1['config']['openai-4o-mini']['secureParameters']['secure'] == ['apikey']
    assert llm_1['config']['openai-4o-mini']['model'] == CUSTOM_MODEL_REF
    assert llm_2['config']['openai-4o-mini']['apikey'] == SERVICE_TOKEN_REF
    assert llm_2['config']['note'] == f'served from {SERVICE_TOKEN_REF}'
    # A literal value the caller typed still moves into secureParameters, as before
    assert 'apikey' not in llm_3['config']['p']
    assert llm_3['config']['p']['secureParameters']['secure'] == ['apikey']
    assert 'typed-literal' not in json.dumps(reply)


@pytest.mark.asyncio
async def test_on_rrext_validate_engine_single_component_returns_submitted_config(monkeypatch):
    """The engine's single-component validator, stopped by an empty profile name before any node code runs."""
    if not cmd_misc.getServiceDefinition('llm_openai'):
        pytest.skip('llm_openai service definition is not loaded')

    direct = cmd_misc.validatePipeline
    calls = _spy_validator(monkeypatch)
    conn = _validate_conn(monkeypatch)
    config = {'profile': '', 'parameters': {'apikey': SERVICE_TOKEN_REF}}
    component = {'id': 'llm_1', 'provider': 'llm_openai', 'config': config}

    reply = await _reply(conn, {'version': 1, 'component': component})

    (expanded, _), (submitted, echoed) = calls
    assert _has_expanded_value(expanded)
    assert submitted == {'pipeline': {'version': 1, 'components': [component]}}
    assert reply['component'] == echoed['pipeline']['components'][0]
    direct_component = direct(copy.deepcopy(submitted))['pipeline']['components'][0]
    assert _with_fixed_tokens(reply['component']) == _with_fixed_tokens(direct_component)
    assert reply['errors']
    assert reply['component']['config']['parameters']['secureParameters']['secure'] == ['apikey']
    assert not _has_expanded_value(reply)


# ---------------------------------------------------------------------------
# on_rrext_dashboard — happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_dashboard_filters_to_caller_user_id(monkeypatch):
    """The dashboard only includes tasks owned by the caller."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    # Caller is a member of team-1 only; team-other is invisible to them.
    caller_account = SimpleNamespace(
        userId='user-1',
        auth='ak_caller',
        userToken='ak_caller_secret_token',
        organization={
            'id': 'org-1',
            'permissions': [],
            'teams': [{'id': 'team-1', 'permissions': ['task.monitor']}],
        },
    )

    # Server state: one task in caller's team, one in a team they cannot see.
    own_status = SimpleNamespace(
        name='task.reader',
        startTime=900.0,
        endTime=0,
        completed=False,
        state=3,
        totalCount=0,
        completedCount=0,
        rateCount=0,
        rateSize=0,
        metrics=None,
    )
    own_task = SimpleNamespace(
        get_status=lambda: own_status,
        get_connection_count=lambda: 1,
        _idle_time=0,
        _ttl=600,
    )
    own_control = SimpleNamespace(
        id='task-1',
        userId='user-1',
        teamId='team-1',
        token='tk_1',
        source='reader',
        project_id='proj-1',
        run_kind='dev',
        # Real controls always expose owner_id (dev run -> the user).
        owner_id='user-1',
        provider='node-x',
        task=own_task,
        launch_type=SimpleNamespace(value='LAUNCH'),
    )
    other_control = SimpleNamespace(
        id='task-2',
        userId='other-user',
        teamId='team-other',
        token='tk_2',
        source='other-source',
        project_id='proj-2',
        run_kind='dev',
        owner_id='other-user',
        provider='node-y',
        task=MagicMock(),
        launch_type=SimpleNamespace(value='EXECUTE'),
    )

    server = MagicMock()
    server._task_control = {'tk_1': own_control, 'tk_2': other_control}
    server._connections = {}
    server._server = SimpleNamespace(_startTime=900.0)

    conn = _make_conn(account_info=caller_account, server=server)
    result = await MiscCommands.on_rrext_dashboard(conn, {})

    body = result['body']
    assert body['overview']['activeTasks'] == 1
    assert len(body['tasks']) == 1
    assert body['tasks'][0]['id'] == 'task-1'


@pytest.mark.asyncio
async def test_on_rrext_dashboard_tk_auth_locks_to_owning_task(monkeypatch):
    """Task-token (tk_*) auth restricts the view to just that task."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    # Both tasks belong to caller's team; the tk_ auth filter narrows further.
    caller_account = SimpleNamespace(
        userId='user-1',
        auth='tk_my-only-task',
        userToken='tk_token',
        organization={
            'id': 'org-1',
            'permissions': [],
            'teams': [{'id': 'team-1', 'permissions': ['task.monitor']}],
        },
    )

    def _make_control(token):
        """Build a minimal task control with the matching token."""
        return SimpleNamespace(
            id=token,
            userId='user-1',
            teamId='team-1',
            token=token,
            source='s',
            project_id='p',
            run_kind='dev',
            # Real controls always expose owner_id (dev run -> the user).
            owner_id='user-1',
            provider='node-x',
            task=SimpleNamespace(
                get_status=lambda: SimpleNamespace(
                    name='task.s',
                    startTime=900.0,
                    endTime=0,
                    completed=False,
                    state=3,
                    totalCount=0,
                    completedCount=0,
                    rateCount=0,
                    rateSize=0,
                    metrics=None,
                ),
                get_connection_count=lambda: 0,
                _idle_time=0,
                _ttl=600,
            ),
            launch_type=SimpleNamespace(value='LAUNCH'),
        )

    server = MagicMock()
    server._task_control = {
        'tk_my-only-task': _make_control('tk_my-only-task'),
        'tk_other-task': _make_control('tk_other-task'),
    }
    server._connections = {}
    server._server = SimpleNamespace(_startTime=900.0)

    conn = _make_conn(account_info=caller_account, server=server)
    result = await MiscCommands.on_rrext_dashboard(conn, {})

    body = result['body']
    assert len(body['tasks']) == 1
    assert body['tasks'][0]['id'] == 'tk_my-only-task'


@pytest.mark.asyncio
async def test_on_rrext_dashboard_requires_monitor_permission():
    """If verify_permission raises, the error is logged and re-raised."""
    conn = _make_conn()
    conn.verify_permission = MagicMock(side_effect=PermissionError('no monitor'))
    with pytest.raises(PermissionError, match='no monitor'):
        await MiscCommands.on_rrext_dashboard(conn, {})
    conn.debug_message.assert_called()


# ---------------------------------------------------------------------------
# rrext_list_connections / rrext_list_tasks — paginated list commands
# ---------------------------------------------------------------------------


def _caller_account(auth='ak_caller'):
    """Standard caller: user-1, member of team-1 with task.monitor."""
    return SimpleNamespace(
        userId='user-1',
        auth=auth,
        userToken='ak_caller_secret_token',
        organization={
            'id': 'org-1',
            'permissions': [],
            'teams': [{'id': 'team-1', 'permissions': ['task.monitor']}],
        },
    )


def _list_control(task_id, *, name=None, start=900.0, provider='node-x', team_id='team-1', completed=False):
    """Build a minimal task control whose get_status() yields a stable row."""
    status = SimpleNamespace(
        name=name or f'task.{task_id}',
        startTime=start,
        endTime=0,
        completed=completed,
        state=3,
        totalCount=0,
        completedCount=0,
        rateCount=0,
        rateSize=0,
        metrics=None,
    )
    return SimpleNamespace(
        id=task_id,
        userId='user-1',
        teamId=team_id,
        token=f'tk_{task_id}',
        source='reader',
        project_id='proj-1',
        run_kind='dev',
        provider=provider,
        task=SimpleNamespace(
            get_status=lambda: status,
            get_connection_count=lambda: 0,
            _idle_time=0,
            _ttl=600,
        ),
        launch_type=SimpleNamespace(value='LAUNCH'),
    )


def _list_ws_conn(
    user_id='user-1',
    connected_at=100.0,
    authenticated=True,
    display_name='User One',
    email='user1@example.com',
    organization=None,
):
    """Build a minimal WebSocket-connection stand-in owned by user_id."""
    return SimpleNamespace(
        # Account shape mirrors the AccountInfo fields the row builder reads:
        # userId, displayName, email, and the OrgInfo dict (None = no org).
        _account_info=SimpleNamespace(
            userId=user_id,
            displayName=display_name,
            email=email,
            organization=organization,
        ),
        _connected_at=connected_at,
        _last_activity=connected_at + 1.0,
        _messages_in=1,
        _messages_out=2,
        _authenticated=authenticated,
        _client_info={'name': 'client'},
        _monitors={},
    )


def _make_server(controls=(), connections=None):
    """Build a server stand-in seeded with task controls and connections."""
    server = MagicMock()
    server._task_control = {c.token: c for c in controls}
    server._connections = connections or {}
    server._server = SimpleNamespace(_startTime=900.0)
    return server


@pytest.mark.asyncio
async def test_list_tasks_paging_math(monkeypatch):
    """page/page_size slice the startTime-ascending default order correctly."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    # Five tasks created at 901..905: default sort is startTime asc.
    controls = [_list_control(f'task-{i}', start=900.0 + i) for i in range(1, 6)]
    conn = _make_conn(account_info=_caller_account(), server=_make_server(controls))

    result = await MiscCommands.on_rrext_list_tasks(conn, {'arguments': {'page': 2, 'page_size': 2}})

    body = result['body']
    # Envelope math: 5 rows total, page 2 of size 2 holds rows 3 and 4.
    assert body['total'] == 5
    assert body['page'] == 2
    assert body['pageSize'] == 2
    assert [row['id'] for row in body['rows']] == ['task-3', 'task-4']


@pytest.mark.asyncio
async def test_list_tasks_sort_by_name_desc(monkeypatch):
    """An explicit sorter overrides the default startTime ascending order."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    controls = [
        _list_control('task-1', name='alpha', start=903.0),
        _list_control('task-2', name='bravo', start=902.0),
        _list_control('task-3', name='charlie', start=901.0),
    ]
    conn = _make_conn(account_info=_caller_account(), server=_make_server(controls))

    request = {'arguments': {'sort': [{'field': 'name', 'dir': 'desc'}]}}
    result = await MiscCommands.on_rrext_list_tasks(conn, request)

    assert [row['name'] for row in result['body']['rows']] == ['charlie', 'bravo', 'alpha']


@pytest.mark.asyncio
async def test_list_tasks_filter_by_provider(monkeypatch):
    """A string filter narrows rows by case-insensitive contains, and the
    filtered total reflects the narrowed set (not the page).
    """
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    controls = [
        _list_control('task-1', provider='node-x'),
        _list_control('task-2', provider='node-y'),
        _list_control('task-3', provider='node-y'),
    ]
    conn = _make_conn(account_info=_caller_account(), server=_make_server(controls))

    result = await MiscCommands.on_rrext_list_tasks(conn, {'arguments': {'filters': {'provider': 'node-y'}}})

    body = result['body']
    assert body['total'] == 2
    assert {row['id'] for row in body['rows']} == {'task-2', 'task-3'}


@pytest.mark.asyncio
async def test_list_tasks_search_matches_name(monkeypatch):
    """The free-text search matches across the name-ish keys (here: name)."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    controls = [
        _list_control('task-1', name='pipeline.alpha'),
        _list_control('task-2', name='pipeline.bravo'),
    ]
    conn = _make_conn(account_info=_caller_account(), server=_make_server(controls))

    result = await MiscCommands.on_rrext_list_tasks(conn, {'arguments': {'search': 'ALPHA'}})

    body = result['body']
    assert body['total'] == 1
    assert body['rows'][0]['id'] == 'task-1'


@pytest.mark.asyncio
async def test_list_tasks_scopes_to_caller_permissions(monkeypatch):
    """Tasks in teams the caller cannot monitor never enter the row set."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    controls = [
        _list_control('task-1', team_id='team-1'),
        _list_control('task-2', team_id='team-other'),  # invisible to caller
    ]
    conn = _make_conn(account_info=_caller_account(), server=_make_server(controls))

    result = await MiscCommands.on_rrext_list_tasks(conn, {'arguments': {}})

    body = result['body']
    assert body['total'] == 1
    assert body['rows'][0]['id'] == 'task-1'


@pytest.mark.asyncio
async def test_list_tasks_tk_auth_locks_to_owning_task(monkeypatch):
    """Task-token (tk_*) auth narrows the list to just the owning task."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    controls = [_list_control('task-1'), _list_control('task-2')]
    conn = _make_conn(account_info=_caller_account(auth='tk_task-2'), server=_make_server(controls))

    result = await MiscCommands.on_rrext_list_tasks(conn, {'arguments': {}})

    body = result['body']
    assert body['total'] == 1
    assert body['rows'][0]['id'] == 'task-2'


@pytest.mark.asyncio
async def test_list_tasks_requires_monitor_permission():
    """If verify_permission raises, the error is logged and re-raised."""
    conn = _make_conn()
    conn.verify_permission = MagicMock(side_effect=PermissionError('no monitor'))
    with pytest.raises(PermissionError, match='no monitor'):
        await MiscCommands.on_rrext_list_tasks(conn, {'arguments': {}})
    conn.debug_message.assert_called()


@pytest.mark.asyncio
async def test_list_connections_paging_and_default_sort(monkeypatch):
    """Default order is connectedAt ascending (registration order); the
    page slice and envelope math follow the convention.
    """
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    # Seed newest-first to prove the sort (not dict order) drives the rows.
    connections = {
        3: _list_ws_conn(connected_at=300.0),
        1: _list_ws_conn(connected_at=100.0),
        2: _list_ws_conn(connected_at=200.0),
    }
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    result = await MiscCommands.on_rrext_list_connections(conn, {'arguments': {'page': 1, 'page_size': 2}})

    body = result['body']
    assert body['total'] == 3
    assert body['page'] == 1
    assert body['pageSize'] == 2
    assert [row['id'] for row in body['rows']] == [1, 2]


@pytest.mark.asyncio
async def test_list_connections_scoped_to_caller_user(monkeypatch):
    """Connections owned by other users never enter the row set."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    connections = {
        1: _list_ws_conn(user_id='user-1'),
        2: _list_ws_conn(user_id='someone-else'),
    }
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    result = await MiscCommands.on_rrext_list_connections(conn, {'arguments': {}})

    body = result['body']
    assert body['total'] == 1
    assert body['rows'][0]['id'] == 1
    assert body['rows'][0]['clientId'] == 'user-1'


@pytest.mark.asyncio
async def test_list_connections_filter_authenticated(monkeypatch):
    """A boolean row value filters by coerced equality ('true'/'false')."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    connections = {
        1: _list_ws_conn(connected_at=100.0, authenticated=True),
        2: _list_ws_conn(connected_at=200.0, authenticated=False),
    }
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    request = {'arguments': {'filters': {'authenticated': 'false'}}}
    result = await MiscCommands.on_rrext_list_connections(conn, request)

    body = result['body']
    assert body['total'] == 1
    assert body['rows'][0]['id'] == 2


@pytest.mark.asyncio
async def test_list_connections_search_client_id(monkeypatch):
    """The free-text search matches the clientId key case-insensitively."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    # Both rows belong to the caller; the search narrows within them.
    connections = {
        1: _list_ws_conn(connected_at=100.0),
        2: _list_ws_conn(connected_at=200.0),
    }
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    result = await MiscCommands.on_rrext_list_connections(conn, {'arguments': {'search': 'USER-1'}})

    # clientId is 'user-1' on both rows, so both match the search term.
    assert result['body']['total'] == 2


@pytest.mark.asyncio
async def test_list_connections_rows_carry_user_and_org_identity(monkeypatch):
    """Rows resolve userId/userName/orgId/orgName server-side from the
    connection's AccountInfo — userName prefers displayName, org keys come
    from the OrgInfo dict.
    """
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    org = {'id': 'org-1', 'name': 'Acme Corp', 'permissions': [], 'teams': []}
    connections = {1: _list_ws_conn(display_name='User One', email='user1@example.com', organization=org)}
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    result = await MiscCommands.on_rrext_list_connections(conn, {'arguments': {}})

    row = result['body']['rows'][0]
    assert row['userId'] == 'user-1'
    assert row['userName'] == 'User One'
    assert row['orgId'] == 'org-1'
    assert row['orgName'] == 'Acme Corp'


@pytest.mark.asyncio
async def test_list_connections_user_name_falls_back_to_email(monkeypatch):
    """An empty displayName falls back to the account email; a missing org
    membership keeps the org keys null.
    """
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    connections = {1: _list_ws_conn(display_name='', email='user1@example.com', organization=None)}
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    result = await MiscCommands.on_rrext_list_connections(conn, {'arguments': {}})

    row = result['body']['rows'][0]
    assert row['userName'] == 'user1@example.com'
    assert row['orgId'] is None
    assert row['orgName'] is None


@pytest.mark.asyncio
async def test_list_connections_search_matches_user_name(monkeypatch):
    """The free-text search matches the resolved userName identity key."""
    monkeypatch.setattr(cmd_misc.time, 'time', lambda: 1000.0)

    # Both rows belong to the caller; only one display name matches the term.
    connections = {
        1: _list_ws_conn(connected_at=100.0, display_name='Ada Lovelace'),
        2: _list_ws_conn(connected_at=200.0, display_name='Grace Hopper'),
    }
    conn = _make_conn(account_info=_caller_account(), server=_make_server((), connections))

    result = await MiscCommands.on_rrext_list_connections(conn, {'arguments': {'search': 'lovelace'}})

    body = result['body']
    assert body['total'] == 1
    assert body['rows'][0]['id'] == 1


def test_build_connection_rows_identity_null_when_unauthenticated():
    """A connection with no account info carries all-null identity keys, and
    empty displayName + email resolve userName to None (not '').
    """
    conn = _make_conn()

    # One connection that never authenticated, one whose account carries no
    # usable name fields — the builder is called directly because the list
    # command's caller scoping only admits authenticated connections.
    anon = SimpleNamespace(
        _connected_at=100.0,
        _last_activity=101.0,
        _messages_in=0,
        _messages_out=0,
        _authenticated=False,
        _client_info={},
        _monitors={},
    )
    nameless = _list_ws_conn(display_name='', email='')

    rows = MiscCommands._build_connection_rows(conn, [], [(7, anon), (8, nameless)], 1000.0)

    # Unauthenticated: every identity key is null.
    assert rows[0]['userId'] is None
    assert rows[0]['userName'] is None
    assert rows[0]['orgId'] is None
    assert rows[0]['orgName'] is None
    # Authenticated but nameless: userId resolves, userName stays null.
    assert rows[1]['userId'] == 'user-1'
    assert rows[1]['userName'] is None


@pytest.mark.asyncio
async def test_list_connections_requires_monitor_permission():
    """If verify_permission raises, the error is logged and re-raised."""
    conn = _make_conn()
    conn.verify_permission = MagicMock(side_effect=PermissionError('no monitor'))
    with pytest.raises(PermissionError, match='no monitor'):
        await MiscCommands.on_rrext_list_connections(conn, {'arguments': {}})
    conn.debug_message.assert_called()


# ---------------------------------------------------------------------------
# Constructor (no-op)
# ---------------------------------------------------------------------------


def test_misc_commands_init_is_noop():
    """The mixin's __init__ accepts the standard arguments without setting state."""
    instance = MiscCommands.__new__(MiscCommands)
    MiscCommands.__init__(instance, connection_id=1, server=None, transport=None)


# ---------------------------------------------------------------------------
# on_rrext_resolve_config
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_resolve_config_returns_what_the_node_receives(monkeypatch):
    """Resolution runs through the engine's own getNodeConfig, not a reimplementation."""
    monkeypatch.setattr(cmd_misc.Config, 'getNodeConfig', staticmethod(lambda p, c: {'model': 'gpt-4o', 'temp': 0}))

    conn = _make_conn()
    request = {'arguments': {'provider': 'llm_openai', 'config': {'model': 'gpt-4o'}}}
    result = await MiscCommands.on_rrext_resolve_config(conn, request)

    body = result['body']
    assert body['provider'] == 'llm_openai'
    assert body['profile'] == 'default'
    assert body['resolved'] == {'model': 'gpt-4o', 'temp': 0}
    assert body['dropped'] == []


@pytest.mark.asyncio
async def test_on_rrext_resolve_config_reports_keys_a_profile_discards(monkeypatch):
    """
    The #1839 shape: with a profile set, sibling top-level keys never reach the node.

    Reporting them is the point of the tool. Inferring it from an absence is what
    cost the issue author a day.
    """
    monkeypatch.setattr(cmd_misc.Config, 'getNodeConfig', staticmethod(lambda p, c: {'host': 'localhost'}))

    conn = _make_conn()
    request = {
        'arguments': {
            'provider': 'store_chroma',
            'config': {'profile': 'local', 'apikey': 'sk-x', 'local': {'host': 'localhost'}},
        },
    }
    result = await MiscCommands.on_rrext_resolve_config(conn, request)

    body = result['body']
    assert body['profile'] == 'local'
    assert body['dropped'] == ['apikey'], 'the profile sub-object itself is not a dropped key'


@pytest.mark.asyncio
async def test_on_rrext_resolve_config_reports_a_key_the_profile_overwrote(monkeypatch):
    """The discard that hides itself: the profile defines the key, so it stays present.

    Reporting only absent keys misses this, which is the common shape in the
    catalog: nearly every profile declares apikey, so an apikey written beside
    'profile' is silently replaced rather than dropped from the result.
    """
    monkeypatch.setattr(cmd_misc.Config, 'getNodeConfig', staticmethod(lambda p, c: {'apikey': '', 'model': 'gpt-5'}))

    conn = _make_conn()
    request = {
        'arguments': {
            'provider': 'llm_openai',
            'config': {'profile': 'openai-5-4', 'apikey': 'sk-authors-key'},
        },
    }
    result = await MiscCommands.on_rrext_resolve_config(conn, request)

    body = result['body']
    assert body['resolved']['apikey'] == '', 'the profile value wins, which is the bug being surfaced'
    assert body['dropped'] == ['apikey'], 'present-but-overwritten still means the author key never lands'


@pytest.mark.asyncio
async def test_on_rrext_resolve_config_reports_a_sibling_that_matches_the_profile(monkeypatch):
    """A sibling whose value coincides with the profile's is still never read.

    Comparing values would stay quiet here and leave the author believing the
    line is in effect, when the same key inside the profile is what applied.
    """
    monkeypatch.setattr(cmd_misc.Config, 'getNodeConfig', staticmethod(lambda p, c: {'model': 'gpt-5.4'}))

    conn = _make_conn()
    request = {
        'arguments': {
            'provider': 'llm_openai',
            'config': {'profile': 'openai-5-4', 'model': 'gpt-5.4'},
        },
    }
    result = await MiscCommands.on_rrext_resolve_config(conn, request)

    assert result['body']['dropped'] == ['model']


@pytest.mark.asyncio
async def test_on_rrext_resolve_config_reports_nothing_without_a_profile(monkeypatch):
    """Without a profile the user layer is read from the top level, so nothing is lost."""
    monkeypatch.setattr(cmd_misc.Config, 'getNodeConfig', staticmethod(lambda p, c: {'model': 'gpt-5.4'}))

    conn = _make_conn()
    request = {'arguments': {'provider': 'llm_openai', 'config': {'model': 'gpt-5.4'}}}
    result = await MiscCommands.on_rrext_resolve_config(conn, request)

    assert result['body']['dropped'] == []


@pytest.mark.asyncio
async def test_on_rrext_resolve_config_ignores_structural_and_unselected_profiles(monkeypatch):
    """A config shaped like a real .pipe, not a hand-written fixture.

    Every component in the repo's own pipelines that selects a profile also carries
    `parameters`, and an editor-saved config keeps a sub-object per profile. Neither
    is user configuration the resolver threw away, and telling an author to move
    `parameters` inside the profile would break the component.
    """
    monkeypatch.setattr(cmd_misc.Config, 'getNodeConfig', staticmethod(lambda p, c: {'model': 'claude-sonnet-4-6'}))
    monkeypatch.setattr(
        cmd_misc,
        '_service_profile_names',
        lambda provider: frozenset({'claude-sonnet-4-6', 'claude-opus-4-1'}),
    )

    conn = _make_conn()
    request = {
        'arguments': {
            'provider': 'llm_anthropic',
            'config': {
                'profile': 'claude-sonnet-4-6',
                'claude-sonnet-4-6': {'apikey': '${ROCKETRIDE_ANTHROPIC_KEY}'},
                'claude-opus-4-1': {'apikey': ''},
                'name': 'Anthropic',
                'parameters': {'temperature': 0.2},
                'apikey': 'sk-written-beside-the-profile',
            },
        },
    }
    result = await MiscCommands.on_rrext_resolve_config(conn, request)

    assert result['body']['dropped'] == ['apikey'], 'only the key an author actually lost'


@pytest.mark.asyncio
async def test_on_rrext_resolve_config_requires_a_provider():
    conn = _make_conn()

    with pytest.raises(ValueError):
        await MiscCommands.on_rrext_resolve_config(conn, {'arguments': {}})


@pytest.mark.asyncio
async def test_on_rrext_resolve_config_rejects_a_non_object_config():
    conn = _make_conn()

    with pytest.raises(ValueError):
        await MiscCommands.on_rrext_resolve_config(conn, {'arguments': {'provider': 'ocr', 'config': []}})


@pytest.mark.asyncio
async def test_on_rrext_resolve_config_propagates_an_unknown_service(monkeypatch):
    """An unknown service raises out of getNodeConfig; the caller should see that, not a blank."""

    def _raise(provider, config):
        raise Exception(f'The service {provider} was not found')

    monkeypatch.setattr(cmd_misc.Config, 'getNodeConfig', staticmethod(_raise))

    conn = _make_conn()
    with pytest.raises(Exception, match='was not found'):
        await MiscCommands.on_rrext_resolve_config(conn, {'arguments': {'provider': 'nope'}})
