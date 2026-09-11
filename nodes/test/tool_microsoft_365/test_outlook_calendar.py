# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
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

"""
Focused tier/body-shape tests for the Outlook Calendar service.

Real ``IInstance`` method calls with only the HTTP layer
(``graph_client._urlopen``) mocked, mirroring
``test_outlook_mail_guards.py``'s bootstrap.
"""

from __future__ import annotations

import io
import json
import sys
import types
import urllib.error
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest import mock

import pytest

_TEST_DIR = Path(__file__).resolve().parents[2]  # nodes/test -> nodes
_REPO_ROOT = _TEST_DIR.parent
_NODES_SRC = _TEST_DIR / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

# Self-sufficient bootstrap (same technique as test_outlook_mail_guards.py /
# test_onedrive_invite_gate.py): stub the engine runtime modules the
# outlook_calendar package imports (depends/rocketlib/ai.common.config), but
# load the *real* ai.common.utils.tool_args module directly by file path —
# it has no heavy deps (json/typing/rocketlib.warning only) — so
# normalize_tool_input/require_str/etc. behave exactly as in production
# instead of returning MagicMocks.
_added = []
for _name in ('depends', 'rocketlib', 'ai', 'ai.common', 'ai.common.config'):
    if _name not in sys.modules:
        _stub = types.ModuleType(_name)
        if _name == 'depends':
            _stub.depends = lambda *a, **k: None
        if _name == 'rocketlib':
            _stub.IInstanceBase = object
            _stub.IGlobalBase = object
            _stub.OPEN_MODE = types.SimpleNamespace(CONFIG='CONFIG')
            _stub.warning = lambda *a, **k: None
            _stub.tool_function = lambda **kw: lambda f: f
        if _name == 'ai.common.config':
            _stub.Config = object
        sys.modules[_name] = _stub
        _added.append(_name)

if 'ai.common.utils' not in sys.modules:
    _tool_args_path = _REPO_ROOT / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils' / 'tool_args.py'
    _spec = spec_from_file_location('ai.common.utils.tool_args', _tool_args_path)
    _tool_args = module_from_spec(_spec)
    sys.modules['ai.common.utils.tool_args'] = _tool_args
    _spec.loader.exec_module(_tool_args)
    _utils_mod = types.ModuleType('ai.common.utils')
    for _n in (
        'normalize_tool_input',
        'optional_str',
        'optional_str_list',
        'optional_bool',
        'require_str',
        'require_str_list',
        'int_arg',
    ):
        setattr(_utils_mod, _n, getattr(_tool_args, _n))
    sys.modules['ai.common.utils'] = _utils_mod
    _added.append('ai.common.utils')
    _added.append('ai.common.utils.tool_args')

_fresh_nodes = 'nodes' not in sys.modules
from nodes.tool_microsoft_365 import graph_client as gc  # noqa: E402
from nodes.tool_microsoft_365.outlook_calendar import client as occ  # noqa: E402
from nodes.tool_microsoft_365.outlook_calendar.IInstance import IInstance  # noqa: E402

# Capture these from the *same* dotted-loaded nodes.core.microsoft_access module
# that IInstance.py itself imported from (identical import path -> identical
# MicrosoftAccessError class object), rather than re-importing the file under a
# bare module name afterward — a second load would mint a distinct class object
# that pytest.raises(MicrosoftAccessError) below could never match against
# exceptions raised inside IInstance.py.
from nodes.core.microsoft_access import MicrosoftAccessError, OUTLOOK_CALENDAR, resolve_microsoft_access  # noqa: E402

for _name in _added:
    sys.modules.pop(_name, None)
if _fresh_nodes:
    for _name in [k for k in list(sys.modules) if k == 'nodes' or k.startswith('nodes.')]:
        sys.modules.pop(_name, None)


def _resp(body: dict, status: int = 200):
    m = mock.MagicMock()
    m.read.return_value = json.dumps(body).encode()
    m.status = status
    m.headers = {}
    m.__enter__ = lambda s: s
    m.__exit__ = lambda s, *a: False
    return m


def _http_error(status: int, body: dict | None = None):
    payload = io.BytesIO(json.dumps({'error': body or {}}).encode())
    return urllib.error.HTTPError('u', status, 'err', {}, payload)


def _instance(*, tier: str) -> IInstance:
    inst = IInstance()
    cfg = {'access': tier}
    access = resolve_microsoft_access(cfg, OUTLOOK_CALENDAR)
    auth = mock.MagicMock()
    auth.token.return_value = 'TOK'
    inst.IGlobal = types.SimpleNamespace(access=access, auth=auth, cfg={'authType': 'user'})
    return inst


class TestReadonlyBlocksWrite:
    def test_readonly_blocks_create_event(self):
        # (a) readonly tier blocks a write-class tool via require_write.
        inst = _instance(tier='readonly')
        with pytest.raises(MicrosoftAccessError, match='read-only'):
            inst.outlook_calendar_create_event(
                {'subject': 'Sync', 'start': '2026-08-11T14:00:00', 'end': '2026-08-11T14:30:00'}
            )


class TestCreateEventBodyShape:
    def test_create_event_posts_correct_body_shape(self):
        # (b) create_event POSTs the {subject, start, end, attendees} shape,
        # wrapping plain-string start/end and mapping attendee emails.
        inst = _instance(tier='write')
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'id': 'e1'})) as u:
            out = inst.outlook_calendar_create_event(
                {
                    'subject': 'Sync',
                    'start': '2026-08-11T14:00:00',
                    'end': '2026-08-11T14:30:00',
                    'attendees': ['alex@contoso.com', 'sam@contoso.com'],
                    'location': 'Room 1',
                }
            )
            assert out == {'id': 'e1'}
            req = u.call_args[0][0]
            assert req.get_method() == 'POST'
            assert req.full_url.endswith('/events')
            body = json.loads(req.data)
            assert body['subject'] == 'Sync'
            assert body['start'] == {'dateTime': '2026-08-11T14:00:00', 'timeZone': 'UTC'}
            assert body['end'] == {'dateTime': '2026-08-11T14:30:00', 'timeZone': 'UTC'}
            assert body['attendees'] == [
                {'emailAddress': {'address': 'alex@contoso.com'}, 'type': 'required'},
                {'emailAddress': {'address': 'sam@contoso.com'}, 'type': 'required'},
            ]
            assert body['location'] == {'displayName': 'Room 1'}

    def test_create_event_uses_specific_calendar(self):
        inst = _instance(tier='write')
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'id': 'e1'})) as u:
            inst.outlook_calendar_create_event(
                {
                    'subject': 'Sync',
                    'start': '2026-08-11T14:00:00',
                    'end': '2026-08-11T14:30:00',
                    'calendar': 'cal-2',
                }
            )
            req = u.call_args[0][0]
            assert '/calendars/cal-2/events' in req.full_url


class TestRespondEnumValidation:
    def test_respond_rejects_invalid_response_enum(self):
        # (c) respond rejects an invalid response value with a clear error.
        inst = _instance(tier='write')
        with pytest.raises(ValueError, match='response'):
            inst.outlook_calendar_respond({'event_id': 'e1', 'response': 'maybe'})

    def test_respond_accepts_valid_enum(self):
        inst = _instance(tier='write')
        with mock.patch.object(gc, '_urlopen', return_value=_resp({})) as u:
            out = inst.outlook_calendar_respond({'event_id': 'e1', 'response': 'accept'})
            assert out == {'responded': 'e1', 'response': 'accept'}
            req = u.call_args[0][0]
            assert req.full_url.endswith('/events/e1/accept')

    def test_respond_requires_response(self):
        inst = _instance(tier='write')
        with pytest.raises(ValueError, match='required'):
            inst.outlook_calendar_respond({'event_id': 'e1'})

    def test_respond_blocked_for_readonly_tier(self):
        inst = _instance(tier='readonly')
        with pytest.raises(MicrosoftAccessError, match='read-only'):
            inst.outlook_calendar_respond({'event_id': 'e1', 'response': 'accept'})


class TestListEvents:
    def test_list_events_exposes_next_link(self):
        inst = _instance(tier='readonly')
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'value': [], '@odata.nextLink': 'https://next'})):
            out = inst.outlook_calendar_list_events({'start': '2026-08-01T00:00:00', 'end': '2026-08-08T00:00:00'})
            assert out == {'events': [], 'next_link': 'https://next'}

    def test_list_events_next_link_is_none_on_last_page(self):
        inst = _instance(tier='readonly')
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'value': []})):
            out = inst.outlook_calendar_list_events({'start': '2026-08-01T00:00:00', 'end': '2026-08-08T00:00:00'})
            assert out['next_link'] is None


class TestFindMeetingTimes:
    @pytest.mark.parametrize(
        'partial', [{'window_start': '2026-08-11T09:00:00'}, {'window_end': '2026-08-11T17:00:00'}]
    )
    def test_partial_window_is_rejected_not_ignored(self, partial):
        inst = _instance(tier='readonly')
        with mock.patch.object(gc, '_urlopen') as u:
            with pytest.raises(ValueError, match='window_start.*window_end'):
                inst.outlook_calendar_find_meeting_times({'attendees': ['a@contoso.com'], **partial})
            u.assert_not_called()

    def test_full_window_sets_time_constraint(self):
        inst = _instance(tier='readonly')
        with mock.patch.object(gc, '_urlopen', return_value=_resp({'meetingTimeSuggestions': []})) as u:
            inst.outlook_calendar_find_meeting_times(
                {
                    'attendees': ['a@contoso.com'],
                    'window_start': '2026-08-11T09:00:00',
                    'window_end': '2026-08-11T17:00:00',
                }
            )
            body = json.loads(u.call_args[0][0].data)
            assert body['timeConstraint']['timeslots'][0]['start']['dateTime'] == '2026-08-11T09:00:00'


class TestDeltaSync:
    def test_delta_sync_with_delta_link_gets_that_absolute_url(self):
        # (d) a caller-provided delta_link is GETed directly, not rebuilt from start/end.
        inst = _instance(tier='readonly')
        absolute_url = 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=abc123'
        with mock.patch.object(
            gc, '_urlopen', return_value=_resp({'value': [], '@odata.deltaLink': absolute_url})
        ) as u:
            out = inst.outlook_calendar_delta_sync({'delta_link': absolute_url})
            assert out == {'events': [], 'delta_link': absolute_url, 'next_link': None}
            req = u.call_args[0][0]
            assert req.full_url == absolute_url
            assert req.get_method() == 'GET'

    def test_delta_sync_first_call_uses_start_end_params(self):
        inst = _instance(tier='readonly')
        with mock.patch.object(
            gc, '_urlopen', return_value=_resp({'value': [], '@odata.nextLink': 'https://next'})
        ) as u:
            out = inst.outlook_calendar_delta_sync({'start': '2026-08-01T00:00:00', 'end': '2026-08-08T00:00:00'})
            assert out == {'events': [], 'delta_link': None, 'next_link': 'https://next'}
            req = u.call_args[0][0]
            assert '/calendarView/delta' in req.full_url
            assert 'startDateTime=' in req.full_url
            assert 'endDateTime=' in req.full_url

    def test_delta_sync_without_start_end_or_delta_link_raises(self):
        inst = _instance(tier='readonly')
        with pytest.raises(ValueError, match='start'):
            inst.outlook_calendar_delta_sync({})


class TestEventDatetimeHelper:
    def test_event_datetime_wraps_plain_string(self):
        assert occ.event_datetime('2026-08-11T14:00:00') == {
            'dateTime': '2026-08-11T14:00:00',
            'timeZone': 'UTC',
        }

    def test_event_datetime_passes_through_shaped_dict_unchanged(self):
        # (e) an already-shaped dict is passed through unchanged (e.g. a
        # caller-supplied non-UTC time zone must not be clobbered).
        shaped = {'dateTime': '2026-08-11T09:00:00', 'timeZone': 'America/New_York'}
        assert occ.event_datetime(shaped) is shaped

    def test_event_datetime_rejects_other_types(self):
        with pytest.raises(ValueError):
            occ.event_datetime(12345)


class TestAttendeeList:
    def test_attendee_list_maps_emails(self):
        assert occ.attendee_list(['a@contoso.com', 'b@contoso.com']) == [
            {'emailAddress': {'address': 'a@contoso.com'}, 'type': 'required'},
            {'emailAddress': {'address': 'b@contoso.com'}, 'type': 'required'},
        ]
