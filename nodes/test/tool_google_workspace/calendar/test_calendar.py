# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the tool_calendar node (no network, no engine runtime).

Bootstrap mirrors test_sheets.py / test_gmail.py: inject lightweight stubs for
the engine runtime modules ONLY if absent, import the module under test, then
drop the stubs so they never leak into a shared pytest session. The Google SDK
is never imported — IInstance receives a FakeCalendar service and a real
GoogleAccess.
"""

from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_NODES_SRC = Path(__file__).resolve().parents[3] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

_SERVICES_JSON = _NODES_SRC / 'nodes' / 'tool_google_workspace' / 'services.calendar.json'


def _require_str(args, key, *, tool_name=''):
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{tool_name or key}: "{key}" is required')
    return value.strip()


def _build_import_stubs():
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object

    def tool_function(**metadata):
        def decorate(func):
            func.__tool_meta__ = metadata
            return func

        return decorate

    rocketlib.tool_function = tool_function
    rocketlib.OPEN_MODE = MagicMock()
    rocketlib.warning = lambda *a, **kw: None

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}
    ai_common_utils.require_str = _require_str

    def _stub_int_arg(args, key, *, default, lo, hi, tool_name=''):
        value = args.get(key)
        if value is None:
            value = default
        if isinstance(value, bool) or not isinstance(value, int):
            prefix = f'{tool_name}: ' if tool_name else ''
            raise ValueError(f'{prefix}"{key}" must be an integer')
        return max(lo, min(value, hi))

    ai_common_utils.int_arg = _stub_int_arg

    def _stub_optional_str(args, key, *, default=None, tool_name=''):
        if key not in args or args[key] is None:
            return default
        val = args[key]
        if not isinstance(val, str):
            prefix = f'{tool_name}: ' if tool_name else ''
            raise ValueError(f'{prefix}"{key}" must be a string')
        return val

    ai_common_utils.optional_str = _stub_optional_str

    def _stub_require_str_list(args, key, *, tool_name=''):
        prefix = f'{tool_name}: ' if tool_name else ''
        value = args.get(key)
        if not isinstance(value, list) or not value:
            raise ValueError(f'{prefix}"{key}" must be a non-empty list')
        if not all(isinstance(i, str) and i.strip() for i in value):
            raise ValueError(f'{prefix}"{key}" must contain only non-empty strings')
        return value

    def _stub_optional_str_list(args, key, *, default=None, tool_name=''):
        if key not in args or args[key] is None:
            return default
        return _stub_require_str_list(args, key, tool_name=tool_name)

    ai_common_utils.require_str_list = _stub_require_str_list
    ai_common_utils.optional_str_list = _stub_optional_str_list

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.config': MagicMock(),
    }


_added = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added.append(_name)

_imported_names = (
    'nodes',
    'nodes.core',
    'nodes.tool_google_workspace',
    'nodes.tool_google_workspace.IInstance',
    'nodes.tool_google_workspace.IGlobal',
    'nodes.tool_google_workspace.google_client',
    'nodes.tool_google_workspace.calendar',
    'nodes.tool_google_workspace.calendar.IInstance',
    'nodes.tool_google_workspace.calendar.IGlobal',
    'nodes.tool_google_workspace.calendar.client',
    'nodes.core.google_access',
)
_preexisting_imports = {name for name in _imported_names if name in sys.modules}

cal_iinstance = importlib.import_module('nodes.tool_google_workspace.calendar.IInstance')
cal_iglobal = importlib.import_module('nodes.tool_google_workspace.calendar.IGlobal')
cal_client = importlib.import_module('nodes.tool_google_workspace.calendar.client')
google_workspace_instance = importlib.import_module('nodes.tool_google_workspace.IInstance')
google_workspace_global = importlib.import_module('nodes.tool_google_workspace.IGlobal')
ga = importlib.import_module('nodes.core.google_access')
_imported_modules = {name: sys.modules[name] for name in _imported_names if name in sys.modules}

for _name in _added:
    sys.modules.pop(_name, None)
for _name in _imported_names:
    if _name not in _preexisting_imports:
        sys.modules.pop(_name, None)


# ---------------------------------------------------------------------------
# Fake Calendar service: records terminal calls, returns canned results.
# ---------------------------------------------------------------------------


class _Req:
    def __init__(self, result):
        self.result = result

    def execute(self):
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class _Node:
    def __init__(self, sv, path):
        self._sv = sv
        self._path = path

    def __getattr__(self, name):
        def method(**kwargs):
            self._sv.calls.append((name, kwargs))
            return _Req(self._sv.results.get(name, {}))

        return method


class FakeCalendar:
    def __init__(self, results=None):
        self.calls = []
        self.results = results or {}

    def events(self):
        return _Node(self, 'events')

    def calendarList(self):
        return _Node(self, 'calendarList')

    def calendars(self):
        return _Node(self, 'calendars')

    def acl(self):
        return _Node(self, 'acl')

    def freebusy(self):
        return _Node(self, 'freebusy')

    def call_for(self, op):
        """Return the kwargs of the first recorded call to terminal method ``op``."""
        return next((kw for n, kw in self.calls if n == op), None)


def _make(tier='write', results=None, flags=None):
    """Build an IInstance wired to a FakeCalendar and a real resolved GoogleAccess."""
    inst = cal_iinstance.IInstance()
    cfg = {'access': tier}
    if flags:
        cfg.update(flags)
    access = ga.resolve_google_access(cfg, ga.CALENDAR)
    inst.IGlobal = types.SimpleNamespace(service=FakeCalendar(results or {}), access=access)
    return inst


_EVENT = {
    'id': 'ev1',
    'status': 'confirmed',
    'summary': 'Sync',
    'description': 'Canvas validation code: CAL-CONTRACT-61',
    'location': 'RocketRide test room',
    'htmlLink': 'https://calendar.google.com/ev1',
    'start': {'dateTime': '2026-07-11T14:00:00Z'},
    'end': {'dateTime': '2026-07-11T15:00:00Z'},
    'organizer': {'email': 'me@x.com'},
    'created': '2026-07-01T00:00:00Z',
    'updated': '2026-07-02T00:00:00Z',
    'attendees': [{'email': 'sam@x.com', 'responseStatus': 'accepted', 'displayName': 'drop me'}],
    'iCalUID': 'drop-me',
}


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def test_event_list_cleans_and_returns_sync_token():
    inst = _make(results={'list': {'items': [_EVENT], 'nextPageToken': 'p2', 'nextSyncToken': 'sync-1'}})
    out = inst.event_list({'calendarId': 'primary'})
    assert out['nextSyncToken'] == 'sync-1'
    assert out['nextPageToken'] == 'p2'
    ev = out['events'][0]
    assert ev['id'] == 'ev1' and ev['status'] == 'confirmed'
    assert ev['attendees'] == [{'email': 'sam@x.com', 'responseStatus': 'accepted'}]  # trimmed
    assert 'iCalUID' not in ev
    kw = inst.IGlobal.service.call_for('list')
    assert kw['calendarId'] == 'primary'
    assert kw['maxResults'] == 50  # documented default sent explicitly


def test_event_list_passes_sync_token_through():
    inst = _make(results={'list': {'items': []}})
    inst.event_list({'syncToken': 'ST-9'})
    kw = inst.IGlobal.service.call_for('list')
    assert kw['syncToken'] == 'ST-9'
    assert kw['calendarId'] == 'primary'  # defaults to primary


@pytest.mark.parametrize('conflicting_key', ['timeMin', 'timeMax', 'q'])
def test_event_list_rejects_sync_token_with_filter(conflicting_key):
    inst = _make()
    with pytest.raises(ValueError, match='syncToken'):
        inst.event_list({'syncToken': 'ST-9', conflicting_key: 'value'})


def test_event_list_clamps_max_results():
    inst = _make(results={'list': {'items': []}})
    inst.event_list({'maxResults': 9999})
    assert inst.IGlobal.service.call_for('list')['maxResults'] == 250


def test_event_list_rejects_bool_max_results():
    # JSON true must never be coerced to 1.
    inst = _make()
    with pytest.raises(ValueError):
        inst.event_list({'maxResults': True})


def test_event_get():
    inst = _make(results={'get': _EVENT})
    out = inst.event_get({'eventId': 'ev1'})
    assert out['id'] == 'ev1'
    assert inst.IGlobal.service.call_for('get')['eventId'] == 'ev1'


def test_event_get_preserves_writable_metadata():
    inst = _make(results={'get': _EVENT})
    out = inst.event_get({'eventId': 'ev1'})
    assert out['description'] == 'Canvas validation code: CAL-CONTRACT-61'
    assert out['location'] == 'RocketRide test room'


def test_event_get_requires_event_id():
    inst = _make()
    with pytest.raises(ValueError):
        inst.event_get({'calendarId': 'primary'})


def test_event_get_maps_api_error():
    inst = _make(results={'get': RuntimeError('boom')})
    with pytest.raises(ValueError):
        inst.event_get({'eventId': 'ev1'})


def test_event_instances():
    inst = _make(results={'instances': {'items': [_EVENT], 'nextPageToken': 'p'}})
    out = inst.event_instances({'eventId': 'ev1', 'maxResults': 10})
    assert out['events'][0]['id'] == 'ev1'
    assert out['nextPageToken'] == 'p'
    kw = inst.IGlobal.service.call_for('instances')
    assert kw['eventId'] == 'ev1' and kw['maxResults'] == 10


def test_freebusy_query():
    inst = _make(
        results={
            'query': {
                'timeMin': 'a',
                'timeMax': 'b',
                'calendars': {'primary': {'busy': [{'start': 's', 'end': 'e'}]}},
            }
        }
    )
    out = inst.freebusy_query({'timeMin': 'a', 'timeMax': 'b', 'calendarIds': ['primary', 'team@x.com']})
    assert out['calendars']['primary']['busy'] == [{'start': 's', 'end': 'e'}]
    body = inst.IGlobal.service.call_for('query')['body']
    assert body['items'] == [{'id': 'primary'}, {'id': 'team@x.com'}]


def test_freebusy_query_requires_calendar_ids():
    inst = _make()
    with pytest.raises(ValueError):
        inst.freebusy_query({'timeMin': 'a', 'timeMax': 'b', 'calendarIds': []})


def test_calendar_list():
    inst = _make(
        results={'list': {'items': [{'id': 'c1', 'summary': 'Work', 'timeZone': 'UTC'}], 'nextSyncToken': 'cs'}}
    )
    out = inst.calendar_list({})
    assert out['calendars'][0] == {'id': 'c1', 'summary': 'Work', 'timeZone': 'UTC'}
    assert out['nextSyncToken'] == 'cs'


def test_calendar_get():
    inst = _make(results={'get': {'id': 'primary', 'summary': 'Me', 'timeZone': 'UTC', 'primary': True}})
    out = inst.calendar_get({'calendarId': 'primary'})
    assert out == {'id': 'primary', 'summary': 'Me', 'timeZone': 'UTC', 'primary': True}


def test_acl_list():
    inst = _make(
        results={
            'list': {'items': [{'id': 'user:sam', 'role': 'reader', 'scope': {'type': 'user', 'value': 'sam@x.com'}}]}
        }
    )
    out = inst.acl_list({'calendarId': 'primary'})
    assert out['rules'][0] == {'id': 'user:sam', 'role': 'reader', 'scope': {'type': 'user', 'value': 'sam@x.com'}}


# ---------------------------------------------------------------------------
# Writes — events
# ---------------------------------------------------------------------------


def test_event_create_always_sends_send_updates_all_when_omitted():
    # The always-send-defaults regression: Google's implicit default is 'none',
    # which would silently skip attendee invitations. The node must send 'all'.
    inst = _make(results={'insert': _EVENT})
    out = inst.event_create(
        {
            'summary': 'Sync',
            'start': {'dateTime': '2026-07-11T14:00:00Z'},
            'end': {'dateTime': '2026-07-11T15:00:00Z'},
            'attendees': [{'email': 'sam@x.com'}],
        }
    )
    assert out['id'] == 'ev1'
    kw = inst.IGlobal.service.call_for('insert')
    assert kw['sendUpdates'] == 'all'  # documented default, sent explicitly
    assert kw['body']['summary'] == 'Sync'
    assert kw['body']['attendees'] == [{'email': 'sam@x.com'}]


def test_event_create_honors_explicit_send_updates():
    inst = _make(results={'insert': _EVENT})
    inst.event_create(
        {
            'summary': 'S',
            'start': {'date': '2026-07-11'},
            'end': {'date': '2026-07-12'},
            'sendUpdates': 'none',
        }
    )
    assert inst.IGlobal.service.call_for('insert')['sendUpdates'] == 'none'


def test_event_create_requires_start():
    inst = _make()
    with pytest.raises(ValueError):
        inst.event_create({'summary': 'S', 'end': {'date': '2026-07-12'}})


def test_event_create_rejects_bad_send_updates():
    inst = _make()
    with pytest.raises(ValueError):
        inst.event_create(
            {'summary': 'S', 'start': {'date': '2026-07-11'}, 'end': {'date': '2026-07-12'}, 'sendUpdates': 'maybe'}
        )


def test_event_update_partial_and_send_updates():
    inst = _make(results={'patch': _EVENT})
    inst.event_update({'eventId': 'ev1', 'summary': 'Renamed'})
    kw = inst.IGlobal.service.call_for('patch')
    assert kw['eventId'] == 'ev1'
    assert kw['body'] == {'summary': 'Renamed'}  # only the changed field
    assert kw['sendUpdates'] == 'all'


def test_event_update_requires_a_field():
    inst = _make()
    with pytest.raises(ValueError):
        inst.event_update({'eventId': 'ev1'})


def test_event_update_allows_empty_description_to_clear_field():
    inst = _make(results={'patch': _EVENT})
    inst.event_update({'eventId': 'ev1', 'description': ''})
    assert inst.IGlobal.service.call_for('patch')['body'] == {'description': ''}


def test_event_move():
    inst = _make(results={'move': _EVENT})
    inst.event_move({'eventId': 'ev1', 'destination': 'cal2'})
    kw = inst.IGlobal.service.call_for('move')
    assert kw['eventId'] == 'ev1' and kw['destination'] == 'cal2'
    assert kw['sendUpdates'] == 'all'


def test_event_move_requires_destination():
    inst = _make()
    with pytest.raises(ValueError):
        inst.event_move({'eventId': 'ev1'})


def test_event_quick_add():
    inst = _make(results={'quickAdd': _EVENT})
    out = inst.event_quick_add({'text': 'Lunch tomorrow at noon'})
    assert out['id'] == 'ev1'
    kw = inst.IGlobal.service.call_for('quickAdd')
    assert kw['text'] == 'Lunch tomorrow at noon' and kw['calendarId'] == 'primary'
    assert kw['sendUpdates'] == 'all'


# ---------------------------------------------------------------------------
# Writes — calendars / ACL
# ---------------------------------------------------------------------------


def test_calendar_create():
    inst = _make(results={'insert': {'id': 'newcal', 'summary': 'Team'}})
    out = inst.calendar_create({'summary': 'Team', 'timeZone': 'UTC'})
    assert out['id'] == 'newcal'
    assert inst.IGlobal.service.call_for('insert')['body'] == {'summary': 'Team', 'timeZone': 'UTC'}


def test_calendar_update():
    inst = _make(results={'patch': {'id': 'c1', 'summary': 'New'}})
    inst.calendar_update({'calendarId': 'c1', 'summary': 'New'})
    assert inst.IGlobal.service.call_for('patch')['body'] == {'summary': 'New'}


def test_calendar_update_empty_description_clears_field():
    inst = _make(results={'patch': {'id': 'c1', 'summary': 'Team'}})
    inst.calendar_update({'calendarId': 'c1', 'description': ''})
    assert inst.IGlobal.service.call_for('patch')['body'] == {'description': ''}


def test_acl_insert():
    inst = _make(
        results={'insert': {'id': 'user:sam', 'role': 'writer', 'scope': {'type': 'user', 'value': 'sam@x.com'}}}
    )
    out = inst.acl_insert({'role': 'writer', 'scopeType': 'user', 'scopeValue': 'sam@x.com'})
    assert out['role'] == 'writer'
    body = inst.IGlobal.service.call_for('insert')['body']
    assert body == {'role': 'writer', 'scope': {'type': 'user', 'value': 'sam@x.com'}}


def test_acl_insert_rejects_bad_role():
    inst = _make()
    with pytest.raises(ValueError):
        inst.acl_insert({'role': 'admin', 'scopeType': 'user', 'scopeValue': 'x@y.com'})


def test_acl_insert_rejects_invalid_scope_type():
    inst = _make()
    with pytest.raises(ValueError, match='scopeType'):
        inst.acl_insert({'role': 'reader', 'scopeType': 'team', 'scopeValue': 'x@y.com'})


@pytest.mark.parametrize('scope_type', ['user', 'group'])
def test_acl_insert_requires_value_for_named_scope(scope_type):
    inst = _make()
    with pytest.raises(ValueError, match='scopeValue'):
        inst.acl_insert({'role': 'reader', 'scopeType': scope_type})


def test_acl_insert_domain_requires_value_once_gate_is_open():
    inst = _make(flags={'allowPublicSharing': True})
    with pytest.raises(ValueError, match='scopeValue'):
        inst.acl_insert({'role': 'reader', 'scopeType': 'domain'})


# ---------------------------------------------------------------------------
# allowPublicSharing gate (calendar exposure)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('scope_type', ['default', 'domain'])
def test_acl_insert_public_scopes_denied_without_flag(scope_type):
    inst = _make(tier='write')  # allowPublicSharing absent -> False
    args = {'role': 'reader', 'scopeType': scope_type}
    if scope_type == 'domain':
        args['scopeValue'] = 'example.com'
    with pytest.raises(ga.GoogleAccessError) as exc:
        inst.acl_insert(args)
    assert 'allowPublicSharing' in str(exc.value)
    assert inst.IGlobal.service.call_for('insert') is None  # nothing reached Google


def test_acl_insert_default_allowed_with_flag():
    inst = _make(
        flags={'allowPublicSharing': True},
        results={'insert': {'id': 'default', 'role': 'freeBusyReader', 'scope': {'type': 'default'}}},
    )
    out = inst.acl_insert({'role': 'freeBusyReader', 'scopeType': 'default'})
    assert out['id'] == 'default'
    body = inst.IGlobal.service.call_for('insert')['body']
    assert body == {'role': 'freeBusyReader', 'scope': {'type': 'default'}}


def test_acl_insert_user_grant_not_gated():
    # Individual grants stay write-tier: the gate covers broad exposure only.
    inst = _make(
        tier='write',  # allowPublicSharing absent -> False
        results={'insert': {'id': 'user:sam', 'role': 'reader', 'scope': {'type': 'user', 'value': 'sam@x.com'}}},
    )
    out = inst.acl_insert({'role': 'reader', 'scopeType': 'user', 'scopeValue': 'sam@x.com'})
    assert out['id'] == 'user:sam'


def test_acl_delete_is_write_tier_not_delete_gated():
    # acl_delete removes a SHARING rule: write tier, NOT gated by allowDelete.
    inst = _make(tier='write', results={'delete': {}})  # allowDelete absent -> False
    out = inst.acl_delete({'calendarId': 'primary', 'ruleId': 'user:sam'})
    assert out == {'deletedRuleId': 'user:sam'}
    assert inst.IGlobal.service.call_for('delete')['ruleId'] == 'user:sam'


# ---------------------------------------------------------------------------
# Access tiers
# ---------------------------------------------------------------------------


def test_default_tier_is_write():
    access = ga.resolve_google_access({}, ga.CALENDAR)
    assert access.tier == 'write'
    assert access.can_write is True


def test_readonly_tier_allows_reads():
    inst = _make(tier='readonly', results={'get': _EVENT})
    assert inst.event_get({'eventId': 'ev1'})['id'] == 'ev1'
    assert inst.IGlobal.access.can_write is False


_WRITE_OPS = [
    'event_create',
    'event_update',
    'event_move',
    'event_quick_add',
    'calendar_create',
    'calendar_update',
    'acl_insert',
    'acl_delete',
    'event_delete',
    'calendar_delete',
]


@pytest.mark.parametrize('op', _WRITE_OPS)
def test_readonly_denies_every_write(op):
    inst = _make(tier='readonly')
    with pytest.raises(ga.GoogleAccessError):
        getattr(inst, op)({})


# ---------------------------------------------------------------------------
# allowDelete gate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('op,args', [('event_delete', {'eventId': 'ev1'}), ('calendar_delete', {'calendarId': 'c1'})])
def test_delete_gated_off_by_default_even_at_write_tier(op, args):
    inst = _make(tier='write')  # allowDelete absent -> False
    with pytest.raises(ga.GoogleAccessError) as exc:
        getattr(inst, op)(args)
    assert 'allowDelete' in str(exc.value)  # the flag is named in the error


def test_event_delete_goes_through_when_allowed():
    inst = _make(tier='write', flags={'allowDelete': True}, results={'delete': {}})
    out = inst.event_delete({'eventId': 'ev1'})
    assert out == {'deletedEventId': 'ev1'}
    kw = inst.IGlobal.service.call_for('delete')
    assert kw['eventId'] == 'ev1' and kw['sendUpdates'] == 'all'


def test_calendar_delete_goes_through_when_allowed():
    inst = _make(tier='write', flags={'allowDelete': True}, results={'delete': {}})
    out = inst.calendar_delete({'calendarId': 'c1'})
    assert out == {'deletedCalendarId': 'c1'}
    assert inst.IGlobal.service.call_for('delete')['calendarId'] == 'c1'


def test_allow_delete_string_true_is_a_misconfig_error():
    # Strict resolver: a present non-bool ('true') must fail loud, not coerce.
    with pytest.raises(ga.GoogleAccessError):
        ga.resolve_google_access({'access': 'write', 'allowDelete': 'true'}, ga.CALENDAR)


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------


def test_check_connection_reports_ok():
    inst = _make()
    out = inst.check_connection({})
    assert out['connection_ok'] is True
    assert out['access'] == 'write'
    assert any('calendar' in s for s in out['requiredScopes'])
    assert inst.IGlobal.service.call_for('list')['maxResults'] == 1


def test_check_connection_reports_probe_failure():
    inst = _make(results={'list': RuntimeError('probe failed')})
    out = inst.check_connection({})
    assert out['connection_ok'] is False
    assert 'probe failed' in out['error']


def test_validate_config_warns_for_malformed_user_token(monkeypatch):
    warnings = []
    for name, module in _imported_modules.items():
        monkeypatch.setitem(sys.modules, name, module)
    # setattr (not .return_value) so this holds whether Config is the real class or a stub.
    monkeypatch.setattr(
        google_workspace_global.Config,
        'getNodeConfig',
        lambda *a, **k: {'authType': 'user', 'userToken': '{bad json'},
    )
    monkeypatch.setattr(google_workspace_global, 'warning', warnings.append)
    glb = cal_iglobal.IGlobal()
    glb.glb = types.SimpleNamespace(logicalType='calendar', connConfig={})
    glb.validateConfig()
    assert any('invalid' in message.lower() for message in warnings)


# ---------------------------------------------------------------------------
# services.json contract
# ---------------------------------------------------------------------------


def test_services_json_shape():
    data = json.loads(_SERVICES_JSON.read_text(encoding='utf-8'))
    assert data['classType'] == ['tool']
    assert data['capabilities'] == ['invoke']
    assert data['lanes'] == {}  # tool node: no data lanes
    assert data['prefix'] == 'calendar'
    assert data['path'] == 'nodes.tool_google_workspace.calendar'
    assert 'test' not in data  # OAuth node: no dynamic test block


def test_calendar_service_uses_shared_workspace_bases():
    assert cal_client.SERVICE.product == 'Google Calendar'
    assert cal_client.SERVICE.api == 'calendar'
    assert cal_client.SERVICE.version == 'v3'
    assert issubclass(cal_iinstance.IInstance, google_workspace_instance.GoogleToolInstanceBase)
    assert issubclass(cal_iglobal.IGlobal, google_workspace_global.GoogleToolGlobalBase)


def test_services_json_has_access_and_allow_delete_fields():
    # Issue AC: both calendar.access and calendar.allowDelete must be present.
    data = json.loads(_SERVICES_JSON.read_text(encoding='utf-8'))
    assert 'calendar.access' in data['fields']
    assert 'calendar.allowDelete' in data['fields']
    assert data['fields']['calendar.access']['default'] == 'write'
    assert [row[0] for row in data['fields']['calendar.access']['enum']] == ['readonly', 'write']
    assert data['fields']['calendar.allowDelete']['type'] == 'boolean'
    assert data['fields']['calendar.allowDelete']['default'] is False


def test_services_json_has_allow_public_sharing_field():
    data = json.loads(_SERVICES_JSON.read_text(encoding='utf-8'))
    assert data['fields']['calendar.allowPublicSharing']['type'] == 'boolean'
    assert data['fields']['calendar.allowPublicSharing']['default'] is False
    # allowDelete must NOT be in the default profile (absent -> False).
    assert 'allowDelete' not in data['preconfig']['profiles']['default']


def test_services_json_no_secret_defaults():
    """Secrets must never carry a real default (gitleaks scans services*.json)."""
    data = json.loads(_SERVICES_JSON.read_text(encoding='utf-8'))
    for prof in data['preconfig']['profiles'].values():
        assert prof.get('serviceKey', '') == ''
        assert prof.get('userToken', '') == ''


# ---------------------------------------------------------------------------
# Completeness
# ---------------------------------------------------------------------------


def test_all_seventeen_tools_plus_diagnostic_present():
    expected = {
        'check_connection',
        # reads
        'event_list',
        'event_get',
        'event_instances',
        'freebusy_query',
        'calendar_list',
        'calendar_get',
        'acl_list',
        # writes
        'event_create',
        'event_update',
        'event_move',
        'event_quick_add',
        'calendar_create',
        'calendar_update',
        'acl_insert',
        'acl_delete',
        # deletes (gated)
        'event_delete',
        'calendar_delete',
    }
    for name in expected:
        method = getattr(cal_iinstance.IInstance, name)
        assert callable(method), f'missing tool: {name}'
        metadata = method.__tool_meta__
        assert metadata['input_schema']['type'] == 'object'
        assert metadata['description']


@pytest.mark.parametrize(
    'op,args,result_key,result',
    [
        ('event_get', {'eventId': 'ev1'}, 'get', _EVENT),
        ('event_list', {}, 'list', {'items': [_EVENT]}),
        ('event_instances', {'eventId': 'ev1'}, 'instances', {'items': [_EVENT]}),
        (
            'event_create',
            {'summary': 'Sync', 'start': {'date': '2026-07-11'}, 'end': {'date': '2026-07-12'}},
            'insert',
            _EVENT,
        ),
        ('event_update', {'eventId': 'ev1', 'summary': 'Sync'}, 'patch', _EVENT),
        ('event_move', {'eventId': 'ev1', 'destination': 'other'}, 'move', _EVENT),
        ('event_quick_add', {'text': 'Sync tomorrow at noon'}, 'quickAdd', _EVENT),
    ],
)
def test_all_event_returning_ops_preserve_cleaned_description_and_location(op, args, result_key, result):
    inst = _make(results={result_key: result})
    out = getattr(inst, op)(args)
    event = out['events'][0] if 'events' in out else out
    assert event['description'] == _EVENT['description']
    assert event['location'] == _EVENT['location']
