"""
Unit tests for tool_gohighlevel.

Covers the ``Version`` header (the header GoHighLevel requires on every request and
values per operation), auth and credential hygiene, rate-limit retries, error-body
parsing, the tool-group publication filter, read-only enforcement, pagination and the
published tool descriptors. No credentials and no network access are needed: this is
what runs in CI. See test_tools.py for the env-gated live suite.

The framework is stubbed rather than imported, so the node loads without the engine.
``rocketlib`` and ``ai.common.config`` are hand-written stand-ins because the real ones
need the native engine, but the argument validators are not:
``packages/ai/src/ai/common/utils/tool_args.py`` is loaded from its source file, the
same way the live suite loads it, so the normalisation and integer-validation tests
below exercise the shipped helpers rather than a copy that stops tracking them the
moment the real module changes.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import re
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes'))
# `zone_audit` is loaded by path, not by import. `nodes/test/` cannot go on
# sys.path: the test packages under it are named `tool_pipedrive` and
# `tool_gohighlevel`, so putting that directory ahead of `src/nodes` makes them
# shadow the very nodes these tests import.
_ZONE_AUDIT_SPEC = importlib.util.spec_from_file_location(
    'zone_audit', Path(__file__).resolve().parents[1] / 'zone_audit.py'
)
zone_audit = importlib.util.module_from_spec(_ZONE_AUDIT_SPEC)
_ZONE_AUDIT_SPEC.loader.exec_module(zone_audit)
audit_time_fields = zone_audit.audit_time_fields


_STUB_MODULE_NAMES = ('rocketlib', 'ai', 'ai.common', 'ai.common.config', 'ai.common.utils')

#: The real argument validators, loaded from source in _install_stubs.
_TOOL_ARGS = (
    Path(__file__).resolve().parents[3] / 'packages' / 'ai' / 'src' / 'ai' / 'common' / 'utils' / 'tool_args.py'
)

# Obviously fake. A real Private Integration Token is "pit-" plus a UUID, but a literal
# one here trips secret scanners, so use a placeholder of the same shape class: the
# "pit-" prefix IGlobal.validateConfig looks for, and long enough that _redact fires
# (it ignores anything under 8 characters).
GHL_TEST_TOKEN = 'pit-gohighlevel-test-not-a-real-token'

# The sub-account and agency ids from the live probe. They are public-looking opaque
# ids, not credentials.
LOCATION_ID = '9oPHGsovxk0Pvi1zmlOy'
COMPANY_ID = 'TM8GhFqVPF91bSMwbPrx'

#: Stand-in record id. GoHighLevel ids are opaque strings of roughly 20 to 24
#: characters, never integers.
RECORD_ID = 'ocQHyuzHvysMo5N5VsXc'

#: The two ``Version`` values, written out rather than imported: a test that asserted
#: the constant against itself would pass even if both were changed to "v3".
CAL = '2021-04-15'
DEF = '2021-07-28'

#: U+2014, written as an escape so this file does not contain the character it forbids.
EM_DASH = '\u2014'


# ---------------------------------------------------------------------------
# Framework stubs
# ---------------------------------------------------------------------------


def _install_stubs() -> None:
    mod_rl = types.ModuleType('rocketlib')

    def mock_tool_function(*args, **kwargs):
        def decorator(fn):
            fn.__tool_meta__ = kwargs
            return fn

        return decorator

    mod_rl.tool_function = mock_tool_function

    class IInstanceBase:
        def _collect_tool_methods(self):
            methods = {}
            for name in dir(type(self)):
                attr = getattr(type(self), name, None)
                if attr is not None and hasattr(attr, '__tool_meta__'):
                    methods[name] = getattr(self, name)
            return methods

    class IGlobalBase:
        pass

    mod_rl.IInstanceBase = IInstanceBase
    mod_rl.IGlobalBase = IGlobalBase
    mod_rl.OPEN_MODE = Mock()
    mod_rl.warning = Mock()
    sys.modules['rocketlib'] = mod_rl

    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai.common'] = types.ModuleType('ai.common')

    mod_config = types.ModuleType('ai.common.config')

    class Config:
        pass

    mod_config.Config = Config
    sys.modules['ai.common.config'] = mod_config

    # The real validators, loaded from their source file rather than re-implemented: a
    # hand-written copy stops tracking the helper the moment it changes, and six tests
    # below assert on this module's behaviour. Only rocketlib and ai.common.config stay
    # stubbed, because the real ones need the native engine. rocketlib must already be in
    # sys.modules here: tool_args imports warning from it.
    spec = importlib.util.spec_from_file_location('ai.common.utils', _TOOL_ARGS)
    mod_utils = importlib.util.module_from_spec(spec)
    sys.modules['ai.common.utils'] = mod_utils
    spec.loader.exec_module(mod_utils)


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    _install_stubs()
    try:
        yield
    finally:
        for name, module in original.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


with _scoped_stubs():
    from ai.common.utils import normalize_tool_input as real_normalize_tool_input
    from ai.common.utils import require_int as real_require_int
    from tool_gohighlevel.gohighlevel_client import (
        BASE_URL,
        DEFAULT_VERSION,
        PATH_VERSIONS,
        VERSION_2021_04_15,
        VERSION_2021_07_28,
        GoHighLevelAPIError,
        _rate_limit_hint,
        check_page_limits,
        paginated,
        version_for,
    )
    from tool_gohighlevel.IInstance import IInstance
    from tool_gohighlevel.tool_groups import (
        ALL_GROUPS,
        DEFAULT_GROUPS,
        RAW_REQUEST_TOOL,
        gohighlevel_tool,
        normalize_groups,
    )
    from tool_gohighlevel.tools import ALL_MIXINS

_CLIENT = 'tool_gohighlevel.gohighlevel_client.requests.request'


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resp(status=200, *, json_data=None, headers=None, text='', content=b'{}', reason='reason', ok=None):
    resp = Mock(spec=requests.Response)
    resp.status_code = status
    resp.ok = (200 <= status < 300) if ok is None else ok
    resp.headers = headers or {}
    resp.text = text
    resp.content = content
    resp.reason = reason
    if json_data is None:
        resp.json.side_effect = ValueError('no json')
    else:
        resp.json.return_value = json_data
    return resp


def _ok(payload=None):
    """A 2xx response. GoHighLevel has no envelope, so the payload is the body."""
    return _resp(200, json_data={} if payload is None else payload, content=b'{}')


def _instance(**overrides):
    """Build an IInstance without running the engine lifecycle."""
    inst = IInstance.__new__(IInstance)
    glob = Mock()
    glob.token = GHL_TEST_TOKEN
    glob.location_id = LOCATION_ID
    glob.read_only = False
    glob.tool_groups = DEFAULT_GROUPS
    glob.allow_raw_request = True
    for key, value in overrides.items():
        setattr(glob, key, value)
    inst.IGlobal = glob
    return inst


def _dispatch(inst, tool, args=None):
    """Call a tool the way the engine resolves one, through the published map.

    ``tool.invoke`` looks the name up in ``_collect_tool_methods()``, so a tool that
    filter drops is not merely hidden from ``tool.query``: there is nothing left to
    invoke. Raising here models that, and lets one assertion cover both halves.
    """
    published = inst._collect_tool_methods()
    if tool not in published:
        raise LookupError(f'{tool}: not published by this node')
    return published[tool](args or {})


def _tool_attrs():
    """Every decorated tool on IInstance, as (name, function) pairs."""
    out = []
    for name in dir(IInstance):
        attr = getattr(IInstance, name, None)
        if attr is not None and hasattr(attr, '__tool_meta__'):
            out.append((name, attr))
    return out


def _write_tool_names():
    return {name for name, attr in _tool_attrs() if getattr(attr, '__gohighlevel_writes__', False)}


def _paged_tool_names():
    """Tools that publish a ``limit``, which is what obliges a PAGE_LIMITS entry."""
    names = set()
    for name, attr in _tool_attrs():
        properties = ((attr.__tool_meta__.get('input_schema') or {}).get('properties')) or {}
        if 'limit' in properties:
            names.add(name)
    return names


def _descriptions(value):
    """Every description string reachable inside a schema, in document order."""
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'description' and isinstance(item, str):
                found.append(item)
            else:
                found.extend(_descriptions(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(_descriptions(item))
    return found


def _sent(mock_request, index=-1):
    """The (args, kwargs) of one call to requests.request."""
    call = mock_request.call_args_list[index]
    return call[0], call[1]


#: Read calls covering every mixin, with the ``Version`` each path must carry. Args are
#: the minimum each tool's schema declares required, so the whole battery runs against a
#: single empty-object response.
_READ_CALLS = (
    ('contact_list', {}, DEF),
    ('contact_search', {}, DEF),
    ('contact_get', {'contactId': RECORD_ID}, DEF),
    ('contact_duplicate_check', {'email': 'ada@example.com'}, DEF),
    ('contact_appointments_list', {'contactId': RECORD_ID}, DEF),
    ('contact_list_by_business', {'businessId': RECORD_ID}, DEF),
    ('contact_notes_list', {'contactId': RECORD_ID}, DEF),
    ('contact_notes_get', {'contactId': RECORD_ID, 'noteId': RECORD_ID}, DEF),
    ('contact_tasks_list', {'contactId': RECORD_ID}, DEF),
    ('contact_tasks_get', {'contactId': RECORD_ID, 'taskId': RECORD_ID}, DEF),
    ('opportunity_search', {}, DEF),
    ('opportunity_search_advanced', {}, DEF),
    ('opportunity_get', {'opportunityId': RECORD_ID}, DEF),
    ('pipeline_list', {}, DEF),
    ('lost_reason_list', {}, DEF),
    ('location_get', {}, DEF),
    ('location_tasks_search', {}, DEF),
    ('location_tags_list', {}, DEF),
    ('location_tags_get', {'tagId': RECORD_ID}, DEF),
    ('custom_field_list', {}, DEF),
    ('custom_field_get', {'customFieldId': RECORD_ID}, DEF),
    ('custom_value_list', {}, DEF),
    ('custom_value_get', {'customValueId': RECORD_ID}, DEF),
    ('business_list', {}, DEF),
    ('business_get', {'businessId': RECORD_ID}, DEF),
    ('user_search', {'companyId': COMPANY_ID}, DEF),
    ('user_list_by_location', {}, DEF),
    ('user_get', {'userId': RECORD_ID}, DEF),
    ('calendar_list', {}, CAL),
    ('calendar_get', {'calendarId': RECORD_ID}, CAL),
    ('calendar_group_list', {}, CAL),
    ('calendar_group_slug_check', {'slug': 'team-intro'}, CAL),
    ('appointment_list', {'calendarId': RECORD_ID, 'startTime': 1700000000000, 'endTime': 1700086400000}, CAL),
    ('appointment_get', {'eventId': RECORD_ID}, CAL),
    (
        'appointment_free_slots_list',
        {'calendarId': RECORD_ID, 'startDate': 1700000000000, 'endDate': 1700086400000},
        CAL,
    ),
    ('appointment_notes_list', {'appointmentId': RECORD_ID}, CAL),
    ('blocked_slot_list', {'calendarId': RECORD_ID, 'startTime': 1700000000000, 'endTime': 1700086400000}, CAL),
    ('conversation_search', {}, CAL),
    ('conversation_get', {'conversationId': RECORD_ID}, CAL),
    ('message_list', {'conversationId': RECORD_ID}, CAL),
    ('message_get', {'messageId': RECORD_ID}, CAL),
    ('message_email_get', {'emailMessageId': RECORD_ID}, CAL),
    ('message_export', {}, CAL),
    ('message_transcription_get', {'messageId': RECORD_ID}, CAL),
)

#: Write calls, same idea. Kept short: the point is that a write path derives the same
#: header as a read on the same resource, not to re-enumerate the surface.
_WRITE_CALLS = (
    ('contact_create', {'firstName': 'Ada'}, DEF),
    ('contact_update', {'contactId': RECORD_ID, 'firstName': 'Ada'}, DEF),
    ('contact_delete', {'contactId': RECORD_ID}, DEF),
    ('contact_tags_add', {'contactId': RECORD_ID, 'tags': ['vip']}, DEF),
    ('opportunity_delete', {'opportunityId': RECORD_ID}, DEF),
    ('custom_value_delete', {'customValueId': RECORD_ID}, DEF),
    ('calendar_delete', {'calendarId': RECORD_ID}, CAL),
    ('calendar_group_delete', {'groupId': RECORD_ID}, CAL),
    ('appointment_delete', {'eventId': RECORD_ID}, CAL),
    ('appointment_notes_delete', {'appointmentId': RECORD_ID, 'noteId': RECORD_ID}, CAL),
    ('conversation_delete', {'conversationId': RECORD_ID}, CAL),
    ('message_schedule_cancel', {'messageId': RECORD_ID}, CAL),
)

#: Rate-limit headers exactly as the deliberately triggered 429 returned them
#: (live-findings section 10). ``x-ratelimit-daily-reset`` is a duration in
#: milliseconds, not an epoch, and must never reach time.sleep.
BURST_429_HEADERS = {
    'content-type': 'application/json; charset=utf-8',
    'x-ratelimit-max': '25',
    'x-ratelimit-remaining': '0',
    'x-ratelimit-interval-milliseconds': '10000',
    'x-ratelimit-limit-daily': '10000',
    'x-ratelimit-daily-remaining': '9938',
    'x-ratelimit-daily-reset': '84523000',
}

#: The captured 429 body: ``statusCode`` and ``message``, with no ``error`` key at all.
BODY_429 = {'statusCode': 429, 'message': 'Too Many Requests'}

#: Values that are durations until the daily bucket resets, never sleep arguments.
#: 84523000 is from the captured 429, 86343000 from the ordinary responses.
DAILY_RESET_VALUES = (84523000, 86343000)


# ---------------------------------------------------------------------------
# The Version header
#
# GoHighLevel requires Version on every request and its value is per operation.
# Sending one value globally breaks the whole calendars and conversations family with a
# 4xx that reads like an authentication failure, which is why this is the first class in
# the file and the widest.
# ---------------------------------------------------------------------------


class TestVersionHeader:
    @pytest.mark.parametrize(
        'path',
        [
            '/calendars/',
            '/calendars/groups',
            '/calendars/events',
            '/calendars/events/appointments',
            '/calendars/blocked-slots',
            f'/calendars/{RECORD_ID}/free-slots',
            f'/calendars/appointments/{RECORD_ID}/notes',
            'calendars/',
            '/Calendars/',
            '/calendars/?limit=10',
        ],
    )
    def test_calendars_paths_resolve_to_2021_04_15(self, path):
        assert version_for(path) == CAL

    @pytest.mark.parametrize(
        'path',
        [
            '/conversations/search',
            '/conversations/',
            f'/conversations/{RECORD_ID}/messages',
            '/conversations/messages/export',
            f'/conversations/locations/{LOCATION_ID}/messages/{RECORD_ID}/transcription',
        ],
    )
    def test_conversations_paths_resolve_to_2021_04_15(self, path):
        assert version_for(path) == CAL

    @pytest.mark.parametrize(
        'path',
        [
            '/contacts/',
            '/contacts/search',
            '/opportunities/search',
            '/opportunities/pipelines',
            '/businesses/',
            f'/locations/{LOCATION_ID}',
            f'/locations/{LOCATION_ID}/customFields',
            '/users/search',
            '/',
            '',
        ],
    )
    def test_every_other_path_resolves_to_2021_07_28(self, path):
        assert version_for(path) == DEF

    @patch(_CLIENT)
    @pytest.mark.parametrize('tool,args,expected', _READ_CALLS, ids=[case[0] for case in _READ_CALLS])
    def test_read_tools_send_the_right_version(self, mock_request, tool, args, expected):
        mock_request.return_value = _ok()
        _dispatch(_instance(tool_groups=ALL_GROUPS), tool, args)
        for call in mock_request.call_args_list:
            headers = call[1]['headers']
            assert headers['Version'] == expected

    @patch(_CLIENT)
    @pytest.mark.parametrize('tool,args,expected', _WRITE_CALLS, ids=[case[0] for case in _WRITE_CALLS])
    def test_write_tools_send_the_right_version(self, mock_request, tool, args, expected):
        mock_request.return_value = _ok()
        _dispatch(_instance(tool_groups=ALL_GROUPS), tool, args)
        assert mock_request.call_args[1]['headers']['Version'] == expected

    @patch(_CLIENT)
    def test_version_is_present_on_every_request(self, mock_request):
        """Not one request across the whole surface may go out without the header."""
        mock_request.return_value = _ok()
        inst = _instance(tool_groups=ALL_GROUPS)
        for tool, args, _expected in _READ_CALLS + _WRITE_CALLS:
            _dispatch(inst, tool, args)

        assert mock_request.call_count >= len(_READ_CALLS) + len(_WRITE_CALLS)
        for call in mock_request.call_args_list:
            assert call[1]['headers'].get('Version')

    @patch(_CLIENT)
    def test_no_code_path_sends_v3(self, mock_request):
        """v3 is a header value on this API, and this node never sends it."""
        mock_request.return_value = _ok()
        inst = _instance(tool_groups=ALL_GROUPS)
        for tool, args, _expected in _READ_CALLS + _WRITE_CALLS:
            _dispatch(inst, tool, args)

        sent = {call[1]['headers']['Version'] for call in mock_request.call_args_list}
        assert sent == {CAL, DEF}
        assert 'v3' not in sent

    def test_client_constants_are_the_two_documented_values(self):
        assert VERSION_2021_04_15 == CAL
        assert VERSION_2021_07_28 == DEF
        assert DEFAULT_VERSION == DEF
        assert PATH_VERSIONS == {'calendars': CAL, 'conversations': CAL}
        assert 'v3' not in set(PATH_VERSIONS.values()) | {DEFAULT_VERSION}

    @patch(_CLIENT)
    def test_raw_request_derives_the_version_from_the_path(self, mock_request):
        mock_request.return_value = _ok()
        _instance().request({'method': 'GET', 'path': '/calendars/'})
        assert mock_request.call_args[1]['headers']['Version'] == CAL

        _instance().request({'method': 'GET', 'path': '/contacts/'})
        assert mock_request.call_args[1]['headers']['Version'] == DEF

    @patch(_CLIENT)
    def test_raw_request_version_override_is_honoured(self, mock_request):
        """The one place a Version other than the derived value can be sent, and it is explicit."""
        mock_request.return_value = _ok()
        _instance().request({'method': 'GET', 'path': '/contacts/', 'version': CAL})
        assert mock_request.call_args[1]['headers']['Version'] == CAL


# ---------------------------------------------------------------------------
# Auth and credential hygiene
# ---------------------------------------------------------------------------


class TestAuth:
    @patch(_CLIENT)
    def test_get_sends_exactly_three_headers(self, mock_request):
        mock_request.return_value = _ok({'contacts': []})
        _instance().contact_list({})

        headers = mock_request.call_args[1]['headers']
        assert set(headers) == {'Accept', 'Authorization', 'Version'}
        assert headers['Authorization'] == f'Bearer {GHL_TEST_TOKEN}'
        assert headers['Accept'] == 'application/json'

    @patch(_CLIENT)
    def test_content_type_is_added_only_for_a_bodied_request(self, mock_request):
        mock_request.return_value = _ok({'contact': {'id': RECORD_ID}})
        _instance().contact_create({'firstName': 'Ada'})

        _args, kwargs = _sent(mock_request)
        assert set(kwargs['headers']) == {'Accept', 'Authorization', 'Version', 'Content-Type'}
        assert kwargs['headers']['Content-Type'] == 'application/json'
        assert kwargs['json'] == {'firstName': 'Ada', 'locationId': LOCATION_ID}

    @patch(_CLIENT)
    def test_bodyless_delete_sends_no_content_type(self, mock_request):
        mock_request.return_value = _ok({'succeded': True})
        _instance().contact_delete({'contactId': RECORD_ID})

        kwargs = mock_request.call_args[1]
        assert 'Content-Type' not in kwargs['headers']
        assert kwargs['json'] is None

    @patch(_CLIENT)
    def test_the_token_never_reaches_the_url_or_the_query_string(self, mock_request):
        mock_request.return_value = _ok({'contacts': []})
        _instance().contact_list({'query': 'ada'})

        args, kwargs = _sent(mock_request)
        assert args == ('GET', f'{BASE_URL}/contacts/')
        assert GHL_TEST_TOKEN not in args[1]
        assert GHL_TEST_TOKEN not in str(kwargs['params'])

    @patch(_CLIENT)
    def test_an_echoed_token_is_redacted_out_of_the_error_message(self, mock_request):
        mock_request.return_value = _resp(
            401,
            json_data={'message': f'Invalid token {GHL_TEST_TOKEN}', 'statusCode': 401},
            text=f'Invalid token {GHL_TEST_TOKEN}',
        )
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert GHL_TEST_TOKEN not in str(exc.value)
        assert GHL_TEST_TOKEN not in exc.value.message
        assert '[redacted]' in exc.value.message

    @patch(_CLIENT)
    def test_a_transport_failure_message_carries_no_token(self, mock_request):
        mock_request.side_effect = requests.ConnectionError(f'dns failure while sending {GHL_TEST_TOKEN}')
        with pytest.raises(ValueError, match='GoHighLevel request failed') as exc:
            _instance().contact_list({})

        assert GHL_TEST_TOKEN not in str(exc.value)

    @patch(_CLIENT)
    def test_a_non_json_body_message_carries_no_token(self, mock_request):
        mock_request.return_value = _resp(200, json_data=None, text=f'<html>{GHL_TEST_TOKEN}</html>', content=b'<html>')
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert 'response was not JSON' in exc.value.message
        assert GHL_TEST_TOKEN not in exc.value.message

    @patch(_CLIENT)
    def test_the_raw_request_tool_redacts_the_token_out_of_a_success_payload(self, mock_request):
        """The only tool that returns an unprojected body, so the only one that can echo it back."""
        mock_request.return_value = _ok({'echo': {'authorization': f'Bearer {GHL_TEST_TOKEN}'}})
        result = _instance().request({'method': 'GET', 'path': '/contacts/'})
        assert GHL_TEST_TOKEN not in json.dumps(result)


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------


class TestRateLimit:
    @patch('time.sleep')
    @patch(_CLIENT)
    def test_429_is_retried_and_sleeps_one_burst_window(self, mock_request, mock_sleep):
        limited = _resp(429, json_data=BODY_429, headers=BURST_429_HEADERS, text='Too Many Requests')
        mock_request.side_effect = [limited, limited, _ok({'contacts': []})]

        _instance().contact_list({})

        assert mock_request.call_count == 3
        assert mock_sleep.call_count == 2
        # 10000 milliseconds, straight from x-ratelimit-interval-milliseconds.
        assert [call[0][0] for call in mock_sleep.call_args_list] == [10.0, 10.0]

    @patch('time.sleep')
    @patch(_CLIENT)
    def test_three_attempts_is_the_ceiling(self, mock_request, mock_sleep):
        limited = _resp(429, json_data=BODY_429, headers=BURST_429_HEADERS, text='Too Many Requests')
        mock_request.return_value = limited

        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert exc.value.status_code == 429
        assert mock_request.call_count == 3
        assert mock_sleep.call_count == 2

    @patch('time.sleep')
    @patch(_CLIENT)
    def test_the_daily_reset_duration_is_never_a_sleep_argument(self, mock_request, mock_sleep):
        """x-ratelimit-daily-reset is a duration of about 24h. Sleeping on it hangs the run."""
        limited = _resp(429, json_data=BODY_429, headers=BURST_429_HEADERS, text='Too Many Requests')
        mock_request.side_effect = [limited, _ok({'contacts': []})]

        _instance().contact_list({})

        slept = [call[0][0] for call in mock_sleep.call_args_list]
        assert slept == [10.0]
        for value in DAILY_RESET_VALUES:
            assert value not in slept
            assert value / 1000.0 not in slept

    @patch('time.sleep')
    @patch(_CLIENT)
    def test_403_is_never_retried(self, mock_request, mock_sleep):
        """GoHighLevel answers 403 for a missing locationId and for agency scope. Both are permanent."""
        refused = _resp(
            403,
            json_data={'message': 'Forbidden resource', 'error': 'Forbidden', 'statusCode': 403},
            headers=BURST_429_HEADERS,
            text='Forbidden resource',
        )
        mock_request.return_value = refused

        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert exc.value.status_code == 403
        assert mock_request.call_count == 1
        assert mock_sleep.call_count == 0

    @patch('time.sleep')
    @patch(_CLIENT)
    def test_an_exhausted_daily_bucket_fails_fast(self, mock_request, mock_sleep):
        headers = dict(BURST_429_HEADERS, **{'x-ratelimit-daily-remaining': '0'})
        mock_request.return_value = _resp(429, json_data=BODY_429, headers=headers, text='Too Many Requests')

        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert exc.value.status_code == 429
        assert mock_request.call_count == 1
        assert mock_sleep.call_count == 0
        assert 'daily request budget' in exc.value.message

    @patch('time.sleep')
    @patch(_CLIENT)
    def test_an_exhausted_daily_bucket_is_reported_on_any_status(self, mock_request, mock_sleep):
        headers = dict(BURST_429_HEADERS, **{'x-ratelimit-daily-remaining': '0'})
        mock_request.return_value = _resp(
            404,
            json_data={'error': 'Contact with id X not found', 'status': 400},
            headers=headers,
            text='not found',
        )

        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_get({'contactId': RECORD_ID})

        assert 'daily request budget' in exc.value.message
        assert mock_sleep.call_count == 0

    @patch('time.sleep')
    @patch(_CLIENT)
    def test_the_burst_hint_stays_off_errors_that_are_not_rate_limits(self, mock_request, mock_sleep):
        """The burst header rides on every response, including every 404 and every 422."""
        mock_request.return_value = _resp(
            404,
            json_data={'error': 'Contact with id X not found', 'status': 400},
            headers=BURST_429_HEADERS,
            text='not found',
        )

        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_get({'contactId': RECORD_ID})

        assert 'burst window' not in exc.value.message
        assert mock_sleep.call_count == 0

    @patch('time.sleep')
    @patch(_CLIENT)
    @pytest.mark.parametrize('bad_value', ['malformed', 'NaN', 'Inf', ''])
    def test_a_malformed_burst_window_falls_back_to_exponential_backoff(self, mock_request, mock_sleep, bad_value):
        headers = dict(BURST_429_HEADERS, **{'x-ratelimit-interval-milliseconds': bad_value})
        limited = _resp(429, json_data=BODY_429, headers=headers, text='Too Many Requests')
        mock_request.side_effect = [limited, _ok({'contacts': []})]

        _instance().contact_list({})

        assert mock_sleep.call_count == 1
        assert mock_sleep.call_args[0][0] >= 2.0

    @patch('time.sleep')
    @patch(_CLIENT)
    def test_a_window_longer_than_the_timeout_fails_fast(self, mock_request, mock_sleep):
        headers = dict(BURST_429_HEADERS, **{'x-ratelimit-interval-milliseconds': '3600000'})
        mock_request.return_value = _resp(429, json_data=BODY_429, headers=headers, text='Too Many Requests')

        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert exc.value.status_code == 429
        assert mock_request.call_count == 1
        assert mock_sleep.call_count == 0

    def test_a_numeric_retry_after_renders_as_seconds(self):
        assert _rate_limit_hint({'Retry-After': '30'}) == 'retry after 30s'

    def test_a_date_form_retry_after_is_not_rendered_as_seconds(self):
        """RFC 9110 allows an HTTP-date in Retry-After, not just delay-seconds.

        GoHighLevel has never been observed sending the header at all, but the retry
        path already guards the date form, so the human-readable hint must not be the
        one place that would render "retry after Wed, 21 Oct 2026 07:28:00 GMT s". A
        date falls through to the burst-window hint instead.
        """
        headers = {
            'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT',
            'x-ratelimit-max': '25',
            'x-ratelimit-interval-milliseconds': '10000',
        }
        assert _rate_limit_hint(headers) == 'the burst window allows 25 requests per 10s'
        assert _rate_limit_hint({'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT'}) == ''

    @pytest.mark.parametrize('bad', ['nan', 'inf', '-inf', '-30'])
    def test_a_non_finite_or_negative_retry_after_is_not_rendered_either(self, bad):
        # float() accepts all of these, so the parse alone is not enough of a guard:
        # "retry after nans" and "retry after -30s" are as garbled as the date form.
        # The retry path rejects them too, so the hint and the sleep stay consistent.
        assert _rate_limit_hint({'Retry-After': bad}) == ''


# ---------------------------------------------------------------------------
# Errors
#
# Five body shapes, all observed live on one trial account. The fifth is the captured
# 429, which carries no "error" key at all.
# ---------------------------------------------------------------------------


class TestErrors:
    @patch(_CLIENT)
    def test_shape_1_message_error_status_code(self, mock_request):
        mock_request.return_value = _resp(
            403,
            json_data={'message': 'Forbidden resource', 'error': 'Forbidden', 'statusCode': 403},
            text='Forbidden resource',
        )
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert exc.value.status_code == 403
        assert 'Forbidden resource' in exc.value.message
        assert 'agency-scoped endpoint' in exc.value.message

    @patch(_CLIENT)
    def test_shape_2_message_as_a_list_of_strings(self, mock_request):
        mock_request.return_value = _resp(
            422,
            json_data={
                'message': ['companyId must be a string', 'property locationId should not exist'],
                'error': 'Unprocessable Entity',
                'statusCode': 422,
            },
            text='unprocessable',
        )
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert exc.value.status_code == 422
        # Joined, not str()-ed: a Python list repr is unreadable to an agent.
        assert exc.value.message == 'companyId must be a string, property locationId should not exist'

    @patch(_CLIENT)
    def test_shape_3_error_with_a_status_key(self, mock_request):
        mock_request.return_value = _resp(
            400,
            json_data={'error': f'Contact with id {RECORD_ID} not found', 'status': 400},
            text='not found',
        )
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_get({'contactId': RECORD_ID})

        assert exc.value.status_code == 400
        assert exc.value.message == f'Contact with id {RECORD_ID} not found'

    @patch(_CLIENT)
    def test_shape_4_error_alone(self, mock_request):
        mock_request.return_value = _resp(400, json_data={'error': 'Task with id search not found'}, text='not found')
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert exc.value.status_code == 400
        assert exc.value.message == 'Task with id search not found'

    @patch('time.sleep')
    @patch(_CLIENT)
    def test_shape_5_the_captured_429_which_has_no_error_key(self, mock_request, mock_sleep):
        """live-findings section 10: {"statusCode": 429, "message": "Too Many Requests"}."""
        mock_request.return_value = _resp(429, json_data=BODY_429, headers=BURST_429_HEADERS, text='Too Many Requests')

        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert exc.value.status_code == 429
        assert exc.value.message.startswith('Too Many Requests')
        assert 'the burst window allows 25 requests per 10s' in exc.value.message

    @patch(_CLIENT)
    def test_message_as_a_string_wins_over_error(self, mock_request):
        mock_request.return_value = _resp(
            400,
            json_data={'message': 'the readable one', 'error': 'the terse one'},
            text='boom',
        )
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert exc.value.message == 'the readable one'

    @patch(_CLIENT)
    def test_the_http_status_wins_over_a_disagreeing_body_status_code(self, mock_request):
        """POST /contacts/ with only a locationId answers HTTP 400 with a body claiming 422."""
        mock_request.return_value = _resp(
            400,
            json_data={'message': 'Bad Request', 'error': 'Bad Request', 'statusCode': 422},
            text='Bad Request',
        )
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_create({'firstName': 'Ada'})

        assert exc.value.status_code == 400

    @patch(_CLIENT)
    def test_a_404_with_an_empty_body_still_produces_a_message(self, mock_request):
        mock_request.return_value = _resp(404, json_data=None, text='', content=b'', reason='Not Found')
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_get({'contactId': RECORD_ID})

        assert exc.value.status_code == 404
        assert exc.value.message == 'Not Found'

    @patch(_CLIENT)
    def test_a_trace_id_is_carried_onto_the_exception(self, mock_request):
        mock_request.return_value = _resp(
            422,
            json_data={'message': 'bad', 'statusCode': 422, 'traceId': 'trace-abc-123'},
            text='bad',
        )
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert exc.value.trace_id == 'trace-abc-123'
        assert '[traceId: trace-abc-123]' in exc.value.message

    @patch(_CLIENT)
    def test_a_missing_location_403_names_the_real_cause(self, mock_request):
        mock_request.return_value = _resp(
            403,
            json_data={'statusCode': 403, 'message': 'The token does not have access to this location.'},
            text='forbidden',
        )
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert 'locationId is missing or mismatched' in exc.value.message

    @patch(_CLIENT)
    def test_a_scope_401_names_the_real_cause(self, mock_request):
        mock_request.return_value = _resp(
            401,
            json_data={'message': 'The token is not authorized for this scope.'},
            text='unauthorized',
        )
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert 'missing a scope this operation requires' in exc.value.message

    # -- the half of an error body that is not prose -----------------------

    @patch(_CLIENT)
    def test_a_conflict_keeps_the_id_it_names(self, mock_request):
        """Live: POST /conversations/ for a contact that already has one answers 400 with its id.

        Creating a contact through the API creates its conversation too, so this is the
        common answer rather than an edge case, and the id is the only way forward.
        """
        mock_request.return_value = _resp(
            400,
            json_data={
                'message': 'Conversation already exists',
                'canonicalCode': 'CONVERSATIONS_CONVERSATION_ALREADY_EXISTS',
                'conversationId': 'hzB0N9v0FmRoW3B2ZM4d',
            },
            text='Conversation already exists',
        )
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().conversation_create({'contactId': RECORD_ID})

        assert exc.value.status_code == 400
        assert 'Conversation already exists' in exc.value.message
        assert 'conversationId: hzB0N9v0FmRoW3B2ZM4d' in exc.value.message
        assert 'canonicalCode: CONVERSATIONS_CONVERSATION_ALREADY_EXISTS' in exc.value.message
        assert exc.value.details == {'conversationId': 'hzB0N9v0FmRoW3B2ZM4d'}
        assert exc.value.canonical_code == 'CONVERSATIONS_CONVERSATION_ALREADY_EXISTS'

    @patch(_CLIENT)
    def test_any_id_bearing_field_is_surfaced_not_just_the_conversation_one(self, mock_request):
        """The rule is any key that is id or ends in Id, not a per-endpoint special case."""
        mock_request.return_value = _resp(
            409,
            json_data={'message': 'already exists', 'contactId': 'c-1', 'id': 'r-9', 'unrelated': 'x'},
            text='conflict',
        )
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert exc.value.details == {'contactId': 'c-1', 'id': 'r-9'}
        assert 'unrelated' not in exc.value.message

    @patch(_CLIENT)
    def test_the_trace_id_is_not_repeated_among_the_details(self, mock_request):
        """The traceId ends in Id but has its own slot, so it must not be reported twice."""
        mock_request.return_value = _resp(
            400,
            json_data={'message': 'boom', 'traceId': 'trace-abc-123', 'conversationId': 'conv-1'},
            text='boom',
        )
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert exc.value.details == {'conversationId': 'conv-1'}
        assert exc.value.message.count('trace-abc-123') == 1

    @patch(_CLIENT)
    def test_an_error_body_with_neither_extra_reads_exactly_as_before(self, mock_request):
        mock_request.return_value = _resp(400, json_data={'error': 'Task with id search not found'}, text='nope')
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert exc.value.message == 'Task with id search not found'
        assert exc.value.details == {}
        assert exc.value.canonical_code == ''

    # -- a 401 is not always a credential problem --------------------------

    @patch(_CLIENT)
    def test_a_gateway_timeout_wearing_a_401_is_not_called_a_credential_problem(self, mock_request):
        """Live capture: HTTP 401 with the body text "Command timed out"."""
        mock_request.return_value = _resp(401, json_data={'message': 'Command timed out'}, text='Command timed out')
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert 'upstream timeout' in exc.value.message
        assert 'retry the call' in exc.value.message
        assert 'revoked' not in exc.value.message
        assert 'rotated Private Integration Token' not in exc.value.message

    @patch(_CLIENT)
    def test_a_401_naming_something_else_entirely_does_not_blame_the_token(self, mock_request):
        mock_request.return_value = _resp(401, json_data={'message': 'Bad Gateway'}, text='Bad Gateway')
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert 'this 401 names no credential' in exc.value.message
        assert 'revoked' not in exc.value.message

    @patch(_CLIENT)
    def test_a_real_credential_401_still_gets_the_rotation_warning(self, mock_request):
        """The tightening must not cost the guidance on the 401 that really is the token."""
        mock_request.return_value = _resp(401, json_data={'message': 'Invalid JWT'}, text='Invalid JWT')
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert 'may be invalid, expired or revoked' in exc.value.message
        assert 'exactly 7 days' in exc.value.message

    @patch(_CLIENT)
    def test_a_401_with_an_empty_body_is_still_treated_as_the_credential(self, mock_request):
        mock_request.return_value = _resp(401, json_data=None, text='', content=b'', reason='Unauthorized')
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert 'may be invalid, expired or revoked' in exc.value.message

    @patch(_CLIENT)
    def test_the_users_search_401_names_the_parameter_and_the_422_it_becomes(self, mock_request):
        mock_request.return_value = _resp(
            401, json_data={'message': 'E01 - Unauthorized request'}, text='E01 - Unauthorized request'
        )
        with pytest.raises(GoHighLevelAPIError) as exc:
            _instance().contact_list({})

        assert 'missing required parameter' in exc.value.message
        assert 'answers 422' in exc.value.message


# ---------------------------------------------------------------------------
# Read-only mode
# ---------------------------------------------------------------------------


class TestReadOnly:
    def test_write_tools_are_hidden_rather_than_merely_refused(self):
        """An agent should never see a tool it can only ever fail on."""
        writable = _instance(tool_groups=ALL_GROUPS)._collect_tool_methods()
        read_only = _instance(tool_groups=ALL_GROUPS, read_only=True)._collect_tool_methods()

        assert set(writable) - set(read_only) == _write_tool_names()
        assert _write_tool_names(), 'the write stamp is what makes hiding possible'

    def test_the_write_surface_is_pinned_by_count(self):
        """The hiding test derives its expectation from the same stamp production filters
        on, so a forgotten writes=True would pass it silently. The counts here are still
        computed from the stamps, but the expected literals are not: adding or restamping
        a tool means changing them consciously.
        """
        assert len(_write_tool_names()) == 57
        # _tool_attrs() counts the raw request tool too; the typed surface is 101.
        assert len(_tool_attrs()) - 1 == 101

    def test_reads_stay_published_in_read_only_mode(self):
        published = _instance(tool_groups=ALL_GROUPS, read_only=True)._collect_tool_methods()
        for name in ('contact_list', 'contact_get', 'calendar_list', 'conversation_search', 'opportunity_search'):
            assert name in published

    @patch(_CLIENT)
    def test_a_read_still_runs_in_read_only_mode(self, mock_request):
        mock_request.return_value = _ok({'contact': {'id': RECORD_ID, 'firstName': 'Ada'}})
        assert _dispatch(_instance(read_only=True), 'contact_get', {'contactId': RECORD_ID})['id'] == RECORD_ID

    @pytest.mark.parametrize(
        'tool,args',
        [
            ('contact_create', {'firstName': 'Ada'}),
            ('contact_update', {'contactId': RECORD_ID, 'firstName': 'Ada'}),
            ('contact_delete', {'contactId': RECORD_ID}),
            ('contact_tags_add', {'contactId': RECORD_ID, 'tags': ['vip']}),
            ('contact_notes_create', {'contactId': RECORD_ID, 'body': 'called'}),
            ('contact_tasks_delete', {'contactId': RECORD_ID, 'taskId': RECORD_ID}),
            ('opportunity_delete', {'opportunityId': RECORD_ID}),
            ('conversation_delete', {'conversationId': RECORD_ID}),
            ('message_schedule_cancel', {'messageId': RECORD_ID}),
            ('calendar_delete', {'calendarId': RECORD_ID}),
            ('calendar_group_delete', {'groupId': RECORD_ID}),
            ('appointment_delete', {'eventId': RECORD_ID}),
            ('appointment_notes_delete', {'appointmentId': RECORD_ID, 'noteId': RECORD_ID}),
            ('business_delete', {'businessId': RECORD_ID}),
            ('custom_field_delete', {'customFieldId': RECORD_ID}),
            ('custom_value_delete', {'customValueId': RECORD_ID}),
            ('location_tags_delete', {'tagId': RECORD_ID}),
        ],
    )
    @patch(_CLIENT)
    def test_require_write_still_guards_a_direct_call(self, mock_request, tool, args):
        """Defence in depth: hiding is the agent-facing behaviour, this is the gate behind it."""
        inst = _instance(tool_groups=ALL_GROUPS, read_only=True)
        with pytest.raises(ValueError, match='read-only mode'):
            getattr(inst, tool)(args)
        mock_request.assert_not_called()

    @patch(_CLIENT)
    def test_the_raw_request_tool_refuses_a_write_method(self, mock_request):
        """It carries no write stamp, so it stays published and is gated at invoke instead."""
        inst = _instance(read_only=True)
        assert RAW_REQUEST_TOOL in inst._collect_tool_methods()
        with pytest.raises(ValueError, match='read-only mode'):
            inst.request({'method': 'POST', 'path': '/contacts/', 'body': {}})
        mock_request.assert_not_called()

    @patch(_CLIENT)
    def test_the_raw_request_tool_still_allows_get(self, mock_request):
        mock_request.return_value = _ok({'contacts': []})
        assert _instance(read_only=True).request({'method': 'GET', 'path': '/contacts/'}) == {'contacts': []}


# ---------------------------------------------------------------------------
# Tool-group gating
# ---------------------------------------------------------------------------


class TestGroupGating:
    def test_a_gated_tool_is_invisible_to_the_descriptor_list(self):
        published = _instance()._collect_tool_methods()
        # businesses is not in DEFAULT_GROUPS.
        assert 'business_list' not in published
        assert 'business_create' not in published
        assert 'contact_list' in published

    def test_a_gated_tool_is_refused_on_invoke(self):
        with pytest.raises(LookupError, match='business_list'):
            _dispatch(_instance(), 'business_list', {})

    def test_enabling_the_group_publishes_it(self):
        published = _instance(tool_groups=normalize_groups(['businesses']))._collect_tool_methods()
        assert 'business_list' in published
        assert 'contact_list' not in published

    @pytest.mark.parametrize('sentinel', ['all', '*', ['all'], ['*'], 'ALL'])
    def test_the_all_sentinels_publish_everything(self, sentinel):
        assert normalize_groups(sentinel) == ALL_GROUPS

    def test_all_publishes_the_whole_surface(self):
        """Guards against a mixin silently dropping out of the composition."""
        published = _instance(tool_groups=normalize_groups('all'))._collect_tool_methods()
        # 101 typed tools plus the raw request escape hatch.
        assert len(published) == 102

    def test_every_registered_mixin_is_an_iinstance_base(self):
        """ALL_MIXINS and the IInstance inheritance list are maintained by hand in two files.

        The tool count above cannot tell a missing mixin from a miscounted one, so this pins
        the composition itself: every registered mixin must appear among the IInstance bases,
        and before IInstanceBase, which has to stay last for the framework hooks to resolve.
        """
        bases = IInstance.__bases__
        missing = [mixin.__name__ for mixin in ALL_MIXINS if mixin not in bases]
        assert missing == [], f'in ALL_MIXINS but not an IInstance base: {missing}'
        base_position = {cls: index for index, cls in enumerate(bases)}
        engine_base = bases[-1]
        assert engine_base.__name__ == 'IInstanceBase', 'IInstanceBase must be the last base'
        assert all(base_position[mixin] < base_position[engine_base] for mixin in ALL_MIXINS)

    def test_a_partially_unknown_value_narrows_to_the_names_that_matched(self):
        # The dropped name is warned about at runtime by IGlobal.beginGlobal and in the
        # editor by validateConfig; the selection itself is what the operator asked for
        # minus the typo, which never publishes more than they intended.
        assert normalize_groups(['contacts', 'nope']) == frozenset({'contacts'})
        assert normalize_groups('contacts, nope') == frozenset({'contacts'})

    @pytest.mark.parametrize('empty', [None, [], '', '   ', 42, [''], {}])
    def test_an_empty_or_unconfigured_value_falls_back_to_the_defaults(self, empty):
        assert normalize_groups(empty) == DEFAULT_GROUPS

    @pytest.mark.parametrize(
        'typo', [['contatcs'], 'contatcs', ['nope', 'also_nope'], 'nope, also_nope', 'opportunites']
    )
    def test_a_wholly_unknown_value_raises_rather_than_widening(self, typo):
        """A config that matches nothing must not fall back to the defaults.

        The fallback would turn one misspelled group name into the 71-tool default set,
        most of it write-capable: strictly more exposure than the operator asked for, on
        the most likely typo shape there is. Configured-but-matched-nothing fails at
        startup instead, like a missing token does.
        """
        with pytest.raises(ValueError, match='matched no known tool group'):
            normalize_groups(typo)

    def test_the_error_names_the_valid_groups(self):
        with pytest.raises(ValueError, match='contacts'):
            normalize_groups(['contatcs'])

    def test_the_raw_request_tool_follows_its_own_switch(self):
        assert RAW_REQUEST_TOOL in _instance()._collect_tool_methods()
        assert RAW_REQUEST_TOOL not in _instance(allow_raw_request=False)._collect_tool_methods()

    def test_message_sending_is_not_published_by_default(self):
        """The send path is the one write surface never proven against the live API.

        A bad send is a real SMS or email from an unattended pipeline, so originating
        messages is an explicit opt-in group rather than part of the default set.
        Reading messages stays default.
        """
        published = _instance()._collect_tool_methods()
        assert 'message_list' in published
        assert 'message_get' in published
        assert 'message_send' not in published
        assert 'message_schedule_cancel' not in published
        assert 'message_email_schedule_cancel' not in published

    def test_enabling_message_sending_publishes_the_send_tools(self):
        published = _instance(tool_groups=normalize_groups(['messages', 'message_sending']))._collect_tool_methods()
        assert 'message_send' in published
        assert 'message_schedule_cancel' in published
        assert 'message_email_schedule_cancel' in published
        assert 'message_list' in published

    @patch(_CLIENT)
    def test_the_raw_request_tool_refuses_a_message_send_without_the_group(self, mock_request):
        """The escape hatch must not reach the one write path the opt-in group gates."""
        inst = _instance()  # DEFAULT_GROUPS: message_sending is absent
        with pytest.raises(ValueError, match='message_sending'):
            inst.request({'method': 'POST', 'path': '/conversations/messages', 'body': {'type': 'SMS'}})
        with pytest.raises(ValueError, match='message_sending'):
            inst.request({'method': 'DELETE', 'path': f'/conversations/messages/{RECORD_ID}/schedule'})
        with pytest.raises(ValueError, match='message_sending'):
            inst.request({'method': 'DELETE', 'path': f'/conversations/messages/email/{RECORD_ID}/schedule'})
        # Slash runs and casing are normalized before the prefix check, so creative
        # spellings of the same route are refused too.
        with pytest.raises(ValueError, match='message_sending'):
            inst.request({'method': 'POST', 'path': '//conversations//Messages', 'body': {'type': 'SMS'}})
        mock_request.assert_not_called()

    @patch(_CLIENT)
    def test_the_raw_request_tool_refuses_a_dot_segment_route_to_the_send_endpoint(self, mock_request):
        """A gate that reads the spelling must resolve what requests resolves.

        ``requests`` collapses dot segments before the request leaves the process, so
        every path below arrives at GoHighLevel as ``/conversations/messages`` — the
        real send endpoint — while matching no literal prefix. Comparing the given
        spelling alone let all four through and originated a message the opt-in group
        exists to hold back.
        """
        inst = _instance()  # DEFAULT_GROUPS: message_sending is absent
        for path in (
            'conversations/./messages',
            './conversations/messages',
            'x/../conversations/messages',
            '../../conversations/messages',
        ):
            with pytest.raises(ValueError, match='message_sending'):
                inst.request({'method': 'POST', 'path': path, 'body': {'type': 'SMS'}})
        mock_request.assert_not_called()

    @patch(_CLIENT)
    def test_dot_segments_elsewhere_are_still_allowed(self, mock_request):
        """Only the send prefix is gated — normalizing must not refuse other routes."""
        mock_request.return_value = _ok({'contacts': []})
        assert _instance().request({'method': 'GET', 'path': 'conversations/./search'}) == {'contacts': []}

    @patch(_CLIENT)
    def test_the_raw_request_tool_sends_messages_with_the_group_enabled(self, mock_request):
        mock_request.return_value = _ok({'messageId': RECORD_ID})
        inst = _instance(tool_groups=normalize_groups(['messages', 'message_sending']))
        result = inst.request({'method': 'POST', 'path': '/conversations/messages', 'body': {'type': 'SMS'}})
        assert result == {'messageId': RECORD_ID}

    @patch(_CLIENT)
    def test_the_raw_request_tool_still_reads_messages_without_the_group(self, mock_request):
        mock_request.return_value = _ok({'messages': []})
        assert _instance().request({'method': 'GET', 'path': '/conversations/messages/export'}) == {'messages': []}

    def test_the_default_set_publishes_71_tools_plus_the_raw_request(self):
        assert len(_instance()._collect_tool_methods()) == 72

    def test_every_tool_carries_a_known_group(self):
        """Closes the hole where an untagged tool would publish unconditionally."""
        untagged = [
            name
            for name, attr in _tool_attrs()
            if name != RAW_REQUEST_TOOL and getattr(attr, '__gohighlevel_group__', None) not in ALL_GROUPS
        ]
        assert untagged == []

    def test_the_decorator_rejects_an_unknown_group_at_import_time(self):
        with pytest.raises(ValueError, match='unknown group'):
            gohighlevel_tool(group='not_a_group')


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------


def _contact_page(count, *, cursor_key='startAfter'):
    """A page of contacts, each carrying the cursor its route puts on the record."""
    records = []
    for index in range(count):
        record = {'id': f'{RECORD_ID}{index}', 'firstName': f'Contact {index}'}
        record[cursor_key] = [1700000000000 + index, f'{RECORD_ID}{index}']
        records.append(record)
    return records


class TestPagination:
    @patch(_CLIENT)
    def test_a_full_page_reports_has_more_and_a_cursor(self, mock_request):
        mock_request.return_value = _ok({'contacts': _contact_page(2)})
        result = _instance().contact_list({'limit': 2})

        assert result['count'] == 2
        assert result['has_more'] is True
        assert result['next'] == {'startAfter': 1700000000001, 'startAfterId': f'{RECORD_ID}1'}

    @patch(_CLIENT)
    def test_a_short_page_reports_no_more_and_a_null_next(self, mock_request):
        """The cursor rides on the record, so the last page carries one too. It must not be reported."""
        mock_request.return_value = _ok({'contacts': _contact_page(1)})
        result = _instance().contact_list({'limit': 2})

        assert result['count'] == 1
        assert result['has_more'] is False
        assert result['next'] is None

    @patch(_CLIENT)
    def test_an_empty_page_reports_no_more(self, mock_request):
        mock_request.return_value = _ok({'contacts': []})
        result = _instance().contact_list({'limit': 2})

        assert result == {'items': [], 'count': 0, 'total': None, 'next': None, 'has_more': False}

    def test_next_is_null_whenever_has_more_is_false(self):
        assert paginated([{'id': 1}], next_cursor='abc', requested_limit=10)['next'] is None
        assert paginated([{'id': 1}], next_cursor='abc', requested_limit=10)['has_more'] is False
        assert paginated([{'id': 1}], next_cursor='abc', has_more=False)['next'] is None
        assert paginated([], next_cursor='abc', requested_limit=1)['next'] is None

    @patch(_CLIENT)
    def test_contact_list_pages_on_start_after_and_start_after_id(self, mock_request):
        mock_request.return_value = _ok({'contacts': []})
        _instance().contact_list({'startAfter': 1700000000000, 'startAfterId': RECORD_ID, 'limit': 50})

        params = mock_request.call_args[1]['params']
        assert params['startAfter'] == 1700000000000
        assert params['startAfterId'] == RECORD_ID
        assert params['limit'] == 50
        assert params['locationId'] == LOCATION_ID
        assert 'searchAfter' not in params
        assert 'pageLimit' not in params

    @patch(_CLIENT)
    def test_contact_search_pages_on_search_after_and_calls_the_size_page_limit(self, mock_request):
        mock_request.return_value = _ok({'contacts': []})
        _instance().contact_search({'searchAfter': [1700000000000, RECORD_ID], 'limit': 25})

        body = mock_request.call_args[1]['json']
        assert body['searchAfter'] == [1700000000000, RECORD_ID]
        assert body['pageLimit'] == 25
        assert body['locationId'] == LOCATION_ID
        # This endpoint does not accept "limit" and ignores "startAfter".
        assert 'limit' not in body
        assert 'startAfter' not in body

    @patch(_CLIENT)
    def test_contact_search_reads_the_cursor_off_the_last_record(self, mock_request):
        mock_request.return_value = _ok({'contacts': _contact_page(2, cursor_key='searchAfter')})
        result = _instance().contact_search({'limit': 2})

        assert result['has_more'] is True
        assert result['next'] == [1700000000001, f'{RECORD_ID}1']

    @patch(_CLIENT)
    def test_opportunity_search_sends_the_sub_account_as_snake_case_location_id(self, mock_request):
        """The only endpoint on this surface that spells it that way. camelCase is a live 422."""
        mock_request.return_value = _ok({'opportunities': []})
        _instance().opportunity_search({'limit': 10})

        params = mock_request.call_args[1]['params']
        assert params['location_id'] == LOCATION_ID
        assert 'locationId' not in params

    @patch(_CLIENT)
    def test_every_other_endpoint_spells_it_camel_case(self, mock_request):
        mock_request.return_value = _ok({'contacts': []})
        _instance().contact_list({})
        assert 'location_id' not in mock_request.call_args[1]['params']
        assert mock_request.call_args[1]['params']['locationId'] == LOCATION_ID

    @patch(_CLIENT)
    def test_the_page_size_is_clamped_to_what_the_endpoint_documents(self, mock_request):
        mock_request.return_value = _ok({'notes': []})
        # Appointment notes cap at 20, and a larger value is a 400 rather than a clamp.
        _instance(tool_groups=ALL_GROUPS).appointment_notes_list({'appointmentId': RECORD_ID, 'limit': 500})
        assert mock_request.call_args[1]['params']['limit'] == 20

        mock_request.return_value = _ok({'contacts': []})
        _instance().contact_list({'limit': 5000})
        assert mock_request.call_args[1]['params']['limit'] == 100

    @patch(_CLIENT)
    def test_an_offset_style_reports_the_next_offset_and_stops_on_a_short_page(self, mock_request):
        mock_request.return_value = _ok({'contacts': [{'id': RECORD_ID}]})
        result = _instance().contact_list_by_business({'businessId': RECORD_ID, 'limit': 1, 'skip': 4})

        # Both values are stringified: this endpoint declares them as strings.
        params = mock_request.call_args[1]['params']
        assert params['limit'] == '1'
        assert params['skip'] == '4'
        assert result['has_more'] is True
        assert result['next'] == 5

        mock_request.return_value = _ok({'contacts': []})
        result = _instance().contact_list_by_business({'businessId': RECORD_ID, 'limit': 2})
        assert result['has_more'] is False
        assert result['next'] is None


# ---------------------------------------------------------------------------
# Wire shapes proven against the live API
# ---------------------------------------------------------------------------


class TestLiveProvenWireShapes:
    @patch(_CLIENT)
    def test_calendar_list_sends_show_drafted_in_lowercase(self, mock_request):
        """A Python True urlencodes as "True", which GoHighLevel answers with a 422."""
        mock_request.return_value = _ok({'calendars': []})
        _instance().calendar_list({'showDrafted': True})

        params = mock_request.call_args[1]['params']
        assert params['showDrafted'] == 'true'
        assert params['locationId'] == LOCATION_ID

        # bool_params sends False rather than dropping it, so pin that side too.
        _instance().calendar_list({'showDrafted': False})
        assert mock_request.call_args[1]['params']['showDrafted'] == 'false'

    @patch(_CLIENT)
    def test_appointment_get_unwraps_the_live_appointment_envelope(self, mock_request):
        """The live route answers under "appointment" while both published specs say "event".

        The live suite proved the wire spelling, but it skips without credentials, so this
        pins it offline: a payload wrapped the way the real API wraps it must come back as
        a populated record rather than an empty dict.
        """
        mock_request.return_value = _ok(
            {
                'appointment': {
                    'id': RECORD_ID,
                    'calendarId': 'cal' + RECORD_ID[3:],
                    'contactId': 'con' + RECORD_ID[3:],
                    'title': 'Discovery call',
                    'appointmentStatus': 'confirmed',
                    'startTime': '2026-08-12T09:00:00+02:00',
                    'endTime': '2026-08-12T09:30:00+02:00',
                },
                'traceId': 'trace-not-a-record',
            }
        )
        record = _dispatch(_instance(), 'appointment_get', {'eventId': RECORD_ID})

        assert record, 'the live envelope key must yield a populated record'
        assert record['id'] == RECORD_ID
        assert record['appointmentStatus'] == 'confirmed'


# ---------------------------------------------------------------------------
# Published descriptors
# ---------------------------------------------------------------------------


class TestSchemas:
    def test_every_published_tool_has_a_description(self):
        missing = [name for name, attr in _tool_attrs() if not attr.__tool_meta__.get('description')]
        assert missing == []

    def test_every_published_tool_has_an_output_schema(self):
        # 102 of 102, raw request tool included: its schema is a bare object that tells
        # the agent the one thing distinguishing it from the typed tools, that the body
        # is not projected through a key allowlist.
        missing = [name for name, attr in _tool_attrs() if not attr.__tool_meta__.get('output_schema')]
        assert missing == []

    def test_no_description_contains_an_em_dash(self):
        offenders = []
        for name, attr in _tool_attrs():
            meta = attr.__tool_meta__
            texts = [meta.get('description') or '']
            texts.extend(_descriptions(meta.get('input_schema') or {}))
            texts.extend(_descriptions(meta.get('output_schema') or {}))
            if any(EM_DASH in text for text in texts):
                offenders.append(name)
        assert offenders == []

    def test_every_input_schema_is_a_json_object_schema(self):
        for name, attr in _tool_attrs():
            schema = attr.__tool_meta__.get('input_schema')
            assert isinstance(schema, dict), name
            assert schema.get('type') == 'object', name
            assert isinstance(schema.get('properties'), dict), name
            for required in schema.get('required', []):
                assert required in schema['properties'], f'{name}: {required} is required but not declared'

    def test_every_paged_tool_is_registered_in_the_page_size_tables(self):
        """page_limit() raises for an unregistered tool, so this is a first-invoke failure."""
        assert check_page_limits({name for name, _attr in _tool_attrs()}, _paged_tool_names()) == []

    def test_every_list_output_schema_declares_the_pagination_envelope(self):
        for name in _paged_tool_names():
            output = getattr(IInstance, name).__tool_meta__['output_schema']
            assert set(output.get('required', [])) == {'items', 'count', 'has_more'}, name
            assert set(output['properties']) >= {'items', 'count', 'total', 'next', 'has_more'}, name

    def test_both_tag_tools_declare_the_sub_account_side_effect(self):
        """Tagging with an unknown name defines that tag on the whole sub-account.

        Live-confirmed, undocumented by GoHighLevel, and invisible from the contact: only
        location_tags_delete removes the definition that contact_tags_add creates. An agent
        looping over contacts with generated names grows the account tag list permanently, so
        both halves have to be in the descriptions the agent actually reads.
        """
        for name in ('contact_tags_add', 'contact_tags_remove'):
            description = getattr(IInstance, name).__tool_meta__['description']
            assert 'location_tags_delete' in description, name
            assert 'sub-account' in description, name


# ---------------------------------------------------------------------------
# Argument normalisation
#
# These cover the two stubs tightened above, so the tightening is load-bearing rather
# than decorative.
# ---------------------------------------------------------------------------


class TestArgNormalisation:
    @patch(_CLIENT)
    def test_the_input_envelope_delivery_path_reaches_the_tool(self, mock_request):
        mock_request.return_value = _ok({'contact': {'id': RECORD_ID, 'firstName': 'Ada'}})
        result = _instance().contact_get({'input': {'contactId': RECORD_ID}, 'security_context': {'user': 'x'}})

        assert result['id'] == RECORD_ID
        assert mock_request.call_args[0][1] == f'{BASE_URL}/contacts/{RECORD_ID}'

    def test_a_top_level_key_beside_the_envelope_wins(self):
        assert real_normalize_tool_input({'input': {'a': 1}, 'a': 2}) == {'a': 2}

    def test_security_context_is_stripped_before_the_schema_check(self):
        assert real_normalize_tool_input({'contactId': RECORD_ID, 'security_context': {}}) == {'contactId': RECORD_ID}

    def test_a_json_string_payload_is_parsed(self):
        assert real_normalize_tool_input(json.dumps({'contactId': RECORD_ID})) == {'contactId': RECORD_ID}

    @pytest.mark.parametrize('value', [None, 7, [1, 2], 'not json'])
    def test_an_uncoercible_payload_becomes_an_empty_dict(self, value):
        assert real_normalize_tool_input(value) == {}

    @pytest.mark.parametrize('value', [3.7, True, [1], {'a': 1}, None])
    def test_require_int_rejects_rather_than_coerces(self, value):
        with pytest.raises(ValueError):
            real_require_int({'limit': value}, 'limit')

    def test_require_int_accepts_an_int_and_a_numeric_string(self):
        assert real_require_int({'limit': 3}, 'limit') == 3
        assert real_require_int({'limit': '3'}, 'limit') == 3

    def test_an_undeclared_parameter_is_rejected_locally(self):
        """GoHighLevel answers 422 "property X should not exist", which reads as a server fault."""
        with pytest.raises(ValueError, match='unknown parameter'):
            _instance().contact_get({'contactId': RECORD_ID, 'include_notes': True})

    def test_a_tool_name_typo_in_args_is_a_hard_error(self):
        with pytest.raises(ValueError, match='no such tool method'):
            _instance()._args({}, 'contact_lst')


# ---------------------------------------------------------------------------
# services.json stays in sync with the code
#
# The editor reads services.json; the runtime reads tool_groups.py and the group
# stamps. Nothing at import time ties them together, so these tests do.
# ---------------------------------------------------------------------------

# From the test file's own location, not inspect.getfile(IInstance): under the
# engine-backed builder run the node module is engine-loaded and carries no
# __file__, so inspect.getfile raises there. The relative layout is the same one
# the sys.path.insert at the top of this file already relies on.
_NODE_SRC = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_gohighlevel'
_SERVICES_JSON = _NODE_SRC / 'services.json'


def _tool_groups_field() -> dict:
    return json.loads(_SERVICES_JSON.read_text(encoding='utf-8'))['fields']['gohighlevel.toolGroups']


def _group_counts() -> dict[str, int]:
    counts: dict[str, int] = {}
    for name, attr in _tool_attrs():
        group = getattr(attr, '__gohighlevel_group__', None)
        if group:
            counts[group] = counts.get(group, 0) + 1
    return counts


class TestServicesJsonGroups:
    def test_the_enum_lists_every_group_exactly_once_plus_all(self):
        values = [value for value, _label in _tool_groups_field()['items']['enum']]
        assert values == sorted(ALL_GROUPS) + ['all']

    def test_every_label_carries_the_real_tool_count(self):
        """The pipedrive-style "(N)" in each label is prose the code never reads.

        A tool added to a group without touching services.json would leave the editor
        lying about what the group publishes, so the counts are pinned to the stamps.
        """
        counts = _group_counts()
        counts['all'] = sum(counts.values())
        wrong = []
        for value, label in _tool_groups_field()['items']['enum']:
            match = re.search(r'\((\d+)', label)
            if not match or int(match.group(1)) != counts[value]:
                wrong.append(f'{value}: label says {match.group(1) if match else "nothing"}, code has {counts[value]}')
        assert wrong == []

    def test_the_labels_mark_exactly_the_default_groups(self):
        marked = {value for value, label in _tool_groups_field()['items']['enum'] if ', default)' in label}
        assert marked == DEFAULT_GROUPS

    def test_duplicate_selections_are_rejected_by_the_schema(self):
        assert _tool_groups_field().get('uniqueItems') is True

    def test_the_default_stays_empty_meaning_the_default_set(self):
        """Deliberate drift from tool_pipedrive, which lists its defaults here.

        tool_groups.py is the single source of truth for the default set; an empty
        value resolves to DEFAULT_GROUPS in normalize_groups. What the empty field
        publishes is spelled out by the default markers on the labels instead.
        """
        assert _tool_groups_field()['default'] == []
        assert normalize_groups(_tool_groups_field()['default']) == DEFAULT_GROUPS


# ---------------------------------------------------------------------------
# Tool-name literals
# ---------------------------------------------------------------------------


class TestToolNameLiterals:
    """Every hand-typed tool-name literal names the method it sits in.

    _declared_schema already raises for a name that exists on no method. The subtler
    copy-paste, a name that exists and belongs to a different tool, would validate the
    agent's arguments against the wrong schema and pass every other test in this suite,
    so it is pinned here by scanning the source: the literal passed to self._args,
    require_id, require_text, and any tool=/tool_name= keyword must equal the name of
    the enclosing method.
    """

    @staticmethod
    def _literal_of(call: ast.Call) -> str | None:
        func = call.func
        if isinstance(func, ast.Attribute) and func.attr == '_args' and len(call.args) >= 2:
            arg = call.args[1]
            return arg.value if isinstance(arg, ast.Constant) and isinstance(arg.value, str) else None
        if isinstance(func, ast.Name) and func.id in ('require_id', 'require_text') and len(call.args) >= 3:
            arg = call.args[2]
            return arg.value if isinstance(arg, ast.Constant) and isinstance(arg.value, str) else None
        for keyword in call.keywords:
            if keyword.arg in ('tool', 'tool_name'):
                value = keyword.value
                return value.value if isinstance(value, ast.Constant) and isinstance(value.value, str) else None
        return None

    def test_every_tool_name_literal_matches_its_method(self):
        src_dir = _NODE_SRC
        offenders = []
        for path in sorted(src_dir.rglob('*.py')):
            tree = ast.parse(path.read_text(encoding='utf-8'))
            classes = [node for node in ast.walk(tree) if isinstance(node, ast.ClassDef)]
            for cls in classes:
                for fn in [node for node in cls.body if isinstance(node, ast.FunctionDef)]:
                    for call in [node for node in ast.walk(fn) if isinstance(node, ast.Call)]:
                        literal = self._literal_of(call)
                        if literal is not None and literal != fn.name:
                            offenders.append(f'{path.name}:{call.lineno}: {fn.name} passes {literal!r}')
        assert offenders == []

    def test_the_scanner_actually_sees_the_literals(self):
        """Guards the guard: an AST scanner that matches nothing passes vacuously."""
        src_dir = _NODE_SRC
        seen = 0
        for path in sorted(src_dir.rglob('*.py')):
            tree = ast.parse(path.read_text(encoding='utf-8'))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and self._literal_of(node) is not None:
                    seen += 1
        assert seen > 100, f'expected well over 100 tool-name literals, saw {seen}'


# ---------------------------------------------------------------------------
# IGlobal config handling
#
# The runtime half of the group-typo story lives in IGlobal, not tool_groups: a
# partial typo has to reach the job log, and a wholly unknown value has to stop
# startup. Without these tests, deleting the warning call would pass silently.
# ---------------------------------------------------------------------------


@contextmanager
def _iglobal_harness(config: dict) -> Iterator[tuple]:
    """A begin-able IGlobal with the engine seams stubbed and warnings captured."""
    # Through sys.modules: the package __init__ re-exports the IGlobal class under the
    # same name, so an ordinary "import tool_gohighlevel.IGlobal" hands back the class.
    # Under the same scoped stubs the module-level import block uses: test_tools.py
    # evicts every tool_gohighlevel module from sys.modules at its own import time, so
    # in a shared session this import can execute IGlobal.py for real rather than hit
    # the cache, and IGlobal.py needs rocketlib and ai.common.config to exist.
    with _scoped_stubs():
        import tool_gohighlevel.IGlobal  # noqa: F401

    iglobal_mod = sys.modules['tool_gohighlevel.IGlobal']

    warning_mock = Mock()
    depends_mod = types.ModuleType('depends')
    depends_mod.load_depends = lambda _file: None
    original_depends = sys.modules.get('depends')
    sys.modules['depends'] = depends_mod
    try:
        with (
            patch.object(iglobal_mod, 'warning', warning_mock),
            patch.object(iglobal_mod.Config, 'getNodeConfig', staticmethod(lambda *_a: dict(config)), create=True),
        ):
            glob = iglobal_mod.IGlobal.__new__(iglobal_mod.IGlobal)
            glob.glb = Mock()
            glob.IEndpoint = Mock()
            glob.IEndpoint.endpoint.openMode = object()  # anything but OPEN_MODE.CONFIG
            yield glob, warning_mock
    finally:
        if original_depends is None:
            sys.modules.pop('depends', None)
        else:
            sys.modules['depends'] = original_depends


class TestIGlobalGroupWarnings:
    @staticmethod
    def _config(**overrides) -> dict:
        cfg = {'privateIntegrationToken': GHL_TEST_TOKEN, 'locationId': LOCATION_ID}
        cfg.update(overrides)
        return cfg

    @staticmethod
    def _logged(warning_mock: Mock) -> str:
        return ' '.join(str(arg) for call in warning_mock.call_args_list for arg in call.args)

    def test_a_partial_typo_narrows_and_warns_in_the_job_log(self):
        with _iglobal_harness(self._config(toolGroups=['contacts', 'nope'])) as (glob, warning_mock):
            glob.beginGlobal()
            assert glob.tool_groups == frozenset({'contacts'})
            logged = self._logged(warning_mock)
            assert 'nope' in logged
            assert 'contacts' in logged

    def test_a_clean_config_warns_nothing(self):
        with _iglobal_harness(self._config(toolGroups=['contacts'])) as (glob, warning_mock):
            glob.beginGlobal()
            assert glob.tool_groups == frozenset({'contacts'})
            warning_mock.assert_not_called()

    def test_a_wholly_unknown_config_stops_startup(self):
        with _iglobal_harness(self._config(toolGroups=['contatcs'])) as (glob, _warning_mock):
            with pytest.raises(ValueError, match='matched no known tool group'):
                glob.beginGlobal()

    def test_validate_config_flags_a_value_that_would_fail_startup(self):
        """The editor sees both halves: the unknown names and the startup consequence."""
        with _iglobal_harness(self._config(toolGroups=['contatcs'])) as (glob, warning_mock):
            glob.validateConfig()
            logged = self._logged(warning_mock)
            assert 'unknown tool group' in logged
            assert 'fail to start' in logged


# ---------------------------------------------------------------------------
# Every field that carries a time of day names its zone
# ---------------------------------------------------------------------------
# THE BUG THIS PINS. `due_time` was documented as 'Due time, HH:MM.' and nothing
# more. Pipedrive stores it as UTC and renders it in each viewer's own zone, so a
# meeting asked for at 12:30 in California was written as "12:30" and shown back
# to the person who asked for it as 05:30. Nothing rejected it — a wrong hour
# looks exactly like a right one.
#
# A model cannot infer a field's zone. It reads the description, and where the
# description is silent it writes the words the person said.
#
# The same audit runs against `tool_gohighlevel`, which was already keeping this
# rule when Pipedrive was not. Two CRMs, two different correct answers, one
# obligation — which is what makes this the CRM-agnostic half of the fix.


class TestEveryTimeFieldNamesItsZone:
    #: A LENGTH, not an instant. "A two-hour meeting" is 02:00 in every zone
    #: there is, and converting it would turn a duration into a wrong duration.
    #: Exempt by decision rather than by the matcher missing it.
    ALLOWED = ('duration',)

    def test_no_published_parameter_describes_a_time_without_saying_which_zone(self):
        assert audit_time_fields(IInstance, self.ALLOWED) == []

    def test_the_audit_can_actually_fail(self):
        """
        The guard on the guard.

        A matcher that silently stopped matching would leave the test above
        passing for ever while saying nothing, which is the failure mode of
        every audit written against a live surface.
        """

        class Silent:
            def book(self):
                pass

            book.__tool_meta__ = {'input_schema': {'properties': {'due_time': {'description': 'Due time, HH:MM.'}}}}

        assert audit_time_fields(Silent) == ['book.due_time']
