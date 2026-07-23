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

"""Unit tests for tool_oura pure helpers (no network)."""

from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Bootstrap: when run under a bare interpreter that lacks the engine runtime,
# inject lightweight stubs ONLY for modules that are not already present,
# import the module under test, then REMOVE the stubs we added. Restoring is
# essential: under the full `builder nodes:test-full` run these modules are
# real and shared across the whole pytest session, so a leaked MagicMock stub
# would break unrelated nodes' tests. The pure helpers under test hold no
# runtime dependency on the stubbed modules, so dropping the stubs after
# import is safe.
# ---------------------------------------------------------------------------

import importlib

# Add nodes/src to sys.path so `nodes.tool_oura.oura_client` is resolvable.
_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


def _build_import_stubs():
    """Return {module_name: stub} for the deps needed only to import the module.

    Importing ``nodes.tool_oura.oura_client`` first imports the ``nodes`` and
    ``nodes.tool_oura`` packages, whose __init__ modules pull in the engine
    runtime (depends, rocketlib, ai.common) — stub all of it.
    """
    requests = MagicMock()
    # Use real exception classes so oura_client's except clauses (which
    # reference these) can actually catch them under the stub.
    requests.Timeout = TimeoutError
    requests.ConnectionError = ConnectionError
    requests.RequestException = Exception

    class _HTTPError(Exception):
        """Stand-in for requests.HTTPError, which carries the failed response."""

        def __init__(self, *args, response=None):
            super().__init__(*args)
            self.response = response

    requests.HTTPError = _HTTPError

    # oura_client compares against named HTTP status codes per repo convention
    # (from requests.status_codes import codes); mirror the real values here.
    class _Codes:
        unauthorized = 401
        forbidden = 403
        not_found = 404
        unprocessable_entity = 422
        upgrade_required = 426
        too_many_requests = 429

    status_codes = MagicMock()
    status_codes.codes = _Codes
    requests.status_codes = status_codes

    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object  # must be a real class for inheritance
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f  # pass-through decorator
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = lambda *a, **kw: None
    rocketlib.OPEN_MODE = MagicMock()

    depends = MagicMock()
    depends.load_depends = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}
    ai_common_utils.require_str = lambda args, key, **kw: str(args[key])
    # Fail loudly rather than silently returning a MagicMock if a test reaches
    # the network layer without patching it.
    ai_common_utils.get_with_retry = MagicMock(side_effect=AssertionError('get_with_retry must be patched in tests'))

    return {
        'requests': requests,
        'requests.status_codes': status_codes,
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.config': MagicMock(),
    }


_added_stubs = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added_stubs.append(_name)

mod = importlib.import_module('nodes.tool_oura.oura_client')
glb_mod = importlib.import_module('nodes.tool_oura.IGlobal')
inst_mod = importlib.import_module('nodes.tool_oura.IInstance')

# Drop the stubs we injected so they never leak into the shared pytest session.
for _name in _added_stubs:
    sys.modules.pop(_name, None)


# ---------------------------------------------------------------------------
# resolve_date_range
# ---------------------------------------------------------------------------


def test_resolve_date_range_explicit():
    start, end = mod.resolve_date_range({'start_date': '2026-07-01', 'end_date': '2026-07-08'})
    assert start == '2026-07-01'
    assert end == '2026-07-08'


def test_resolve_date_range_defaults_to_last_week():
    start, end = mod.resolve_date_range({}, default_days=7)
    # Default end is UTC tomorrow so wearers ahead of UTC never lose their
    # current local day (Oura `day` fields are in the wearer's timezone).
    default_end = datetime.now(timezone.utc).date() + timedelta(days=1)
    assert end == default_end.isoformat()
    assert start == (default_end - timedelta(days=7)).isoformat()


def test_resolve_date_range_default_start_follows_explicit_end():
    start, end = mod.resolve_date_range({'end_date': '2026-03-10'}, default_days=3)
    assert end == '2026-03-10'
    assert start == '2026-03-07'


def test_resolve_date_range_rejects_inverted_range():
    with pytest.raises(ValueError, match='after end_date'):
        mod.resolve_date_range({'start_date': '2026-07-08', 'end_date': '2026-07-01'})


def test_resolve_date_range_rejects_malformed_date():
    with pytest.raises(ValueError, match='ISO date'):
        mod.resolve_date_range({'start_date': 'last tuesday'})


# ---------------------------------------------------------------------------
# resolve_datetime_range
# ---------------------------------------------------------------------------


def test_resolve_datetime_range_explicit_and_z_suffix():
    start, end = mod.resolve_datetime_range(
        {'start_datetime': '2026-07-01T00:00:00Z', 'end_datetime': '2026-07-01T12:00:00+02:00'}
    )
    assert datetime.fromisoformat(start) == datetime(2026, 7, 1, tzinfo=timezone.utc)
    assert datetime.fromisoformat(end).utcoffset() == timedelta(hours=2)


def test_resolve_datetime_range_naive_treated_as_utc():
    start, _ = mod.resolve_datetime_range(
        {'start_datetime': '2026-07-01T06:30:00', 'end_datetime': '2026-07-02T00:00:00'}
    )
    assert datetime.fromisoformat(start).utcoffset() == timedelta(0)


def test_resolve_datetime_range_rejects_inverted_range():
    with pytest.raises(ValueError, match='after end_datetime'):
        mod.resolve_datetime_range({'start_datetime': '2026-07-02T00:00:00Z', 'end_datetime': '2026-07-01T00:00:00Z'})


# ---------------------------------------------------------------------------
# compact_document / compact_result
# ---------------------------------------------------------------------------


def test_compact_document_strips_time_series():
    doc = {
        'id': 'abc',
        'score': 82,
        'class_5_min': '111222333',
        'heart_rate': {'interval': 300, 'items': [55, 56], 'timestamp': 't'},
        'readiness': {'score': 80, 'hrv': {'items': [40, 41]}},
    }
    compacted = mod.compact_document(doc)
    assert compacted == {'id': 'abc', 'score': 82, 'readiness': {'score': 80}}


def test_compact_document_include_detail_passthrough():
    doc = {'id': 'abc', 'class_5_min': '111'}
    assert mod.compact_document(doc, include_detail=True) is doc


def test_compact_document_non_dict_passthrough():
    assert mod.compact_document([1, 2, 3]) == [1, 2, 3]
    assert mod.compact_document(None) is None


def test_compact_document_recurses_into_lists():
    doc = {'sessions': [{'score': 1, 'heart_rate': {'items': [50]}}, {'score': 2}]}
    assert mod.compact_document(doc) == {'sessions': [{'score': 1}, {'score': 2}]}


def test_compact_result_wraps_data_and_token():
    result = {'data': [{'id': '1', 'met': {'items': []}}], 'next_token': 'tok'}
    compacted = mod.compact_result(result)
    assert compacted == {'data': [{'id': '1'}], 'next_token': 'tok'}


# ---------------------------------------------------------------------------
# merge_daily_summary
# ---------------------------------------------------------------------------


def test_merge_daily_summary_merges_and_sorts_by_day():
    merged = mod.merge_daily_summary(
        {
            'daily_sleep': [
                {'day': '2026-07-02', 'score': 88, 'contributors': {'deep_sleep': 90}, 'id': 'x'},
                {'day': '2026-07-01', 'score': 70, 'contributors': {'deep_sleep': 60}, 'id': 'y'},
            ],
            'daily_readiness': [{'day': '2026-07-01', 'score': 75, 'temperature_deviation': -0.1}],
            'daily_activity': [{'day': '2026-07-01', 'score': 92, 'steps': 10450, 'active_calories': 500}],
            'daily_stress': [
                {'day': '2026-07-01', 'stress_high': 3600, 'recovery_high': 7200, 'day_summary': 'normal'}
            ],
        }
    )
    assert [d['day'] for d in merged] == ['2026-07-01', '2026-07-02']
    day1 = merged[0]
    assert day1['daily_sleep'] == {'score': 70, 'contributors': {'deep_sleep': 60}}
    assert day1['daily_readiness']['score'] == 75
    assert day1['daily_activity']['steps'] == 10450
    assert day1['daily_stress']['day_summary'] == 'normal'
    # id (not a headline key) must not leak into the summary
    assert 'id' not in day1['daily_sleep']
    # day 2 only has sleep data
    assert set(merged[1]) == {'day', 'daily_sleep'}


def test_merge_daily_summary_skips_docs_without_day():
    merged = mod.merge_daily_summary({'daily_sleep': [{'score': 1}, 'oops', None]})
    assert merged == []


# ---------------------------------------------------------------------------
# fetch_collection pagination (call() mocked — no network)
# ---------------------------------------------------------------------------


def test_fetch_collection_rejects_unknown_collection():
    with pytest.raises(ValueError, match='Unknown Oura collection'):
        mod.fetch_collection('tok', 'not_a_collection')


def test_fetch_collection_follows_next_token():
    pages = [
        {'data': [{'id': '1'}], 'next_token': 'page2'},
        {'data': [{'id': '2'}], 'next_token': None},
    ]
    calls = []

    def fake_call(token, path, *, params=None):
        calls.append(params)
        return pages[len(calls) - 1]

    with patch.object(mod, 'call', side_effect=fake_call):
        result = mod.fetch_collection('tok', 'daily_sleep', params={'start_date': '2026-07-01'})

    assert [d['id'] for d in result['data']] == ['1', '2']
    assert result['next_token'] is None
    # First page carries the date filter; the follow-up page sends ONLY the
    # next_token (Oura 422s when both are present).
    assert calls[0] == {'start_date': '2026-07-01'}
    assert calls[1] == {'next_token': 'page2'}


def test_fetch_collection_respects_page_cap():
    def fake_call(token, path, *, params=None):
        return {'data': [{'id': 'x'}], 'next_token': 'more'}

    with patch.object(mod, 'call', side_effect=fake_call):
        result = mod.fetch_collection('tok', 'daily_sleep', max_pages=3)

    assert len(result['data']) == 3
    assert result['next_token'] == 'more'  # truncated — caller can continue


# ---------------------------------------------------------------------------
# error mapping
# ---------------------------------------------------------------------------


def _resp(status, payload=None, text='', headers=None):
    resp = MagicMock()
    resp.status_code = status
    resp.text = text
    resp.reason = 'reason'
    resp.headers = headers or {}
    if payload is None:
        resp.json.side_effect = ValueError('no json')
    else:
        resp.json.return_value = payload
    return resp


def test_map_error_401_mentions_token():
    err = mod._map_error(_resp(401, {'detail': 'invalid token'}))
    assert 'authentication failed' in str(err)
    assert 'invalid token' in str(err)


def test_map_error_426_mentions_subscription():
    err = mod._map_error(_resp(426, {'detail': 'subscription expired'}))
    assert 'subscription required' in str(err)


def test_map_error_429_mentions_rate_limit():
    err = mod._map_error(_resp(429, {'detail': 'slow down'}))
    assert 'rate limit' in str(err)


def test_map_error_429_surfaces_retry_after():
    err = mod._map_error(_resp(429, {'detail': 'slow down'}, headers={'Retry-After': '30'}))
    assert 'Retry after 30 seconds' in str(err)


def test_map_error_404_mentions_document_id():
    err = mod._map_error(_resp(404, {'detail': 'not found'}))
    assert 'resource not found' in str(err)
    assert 'document ID' in str(err)


def test_map_error_429_retry_after_http_date_gets_no_seconds_suffix():
    err = mod._map_error(_resp(429, {'detail': 'slow down'}, headers={'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT'}))
    assert 'Retry after Wed, 21 Oct 2026 07:28:00 GMT.' in str(err)
    assert 'GMT seconds' not in str(err)


def test_map_error_401_scope_detected_past_truncation_cap():
    """Scope classification must use the full body, not the truncated excerpt."""
    detail = 'x' * 600 + ' missing scope: daily'
    err = mod._map_error(_resp(401, {'detail': detail}))
    assert 'scope not granted' in str(err)
    assert '(truncated)' in str(err)


def test_map_error_truncates_huge_non_json_body():
    err = mod._map_error(_resp(502, text='<html>' + 'x' * 5000 + '</html>'))
    assert len(str(err)) < 600
    assert '(truncated)' in str(err)


def test_map_error_422_joins_validation_list():
    err = mod._map_error(_resp(422, {'detail': [{'msg': 'bad start_date'}, {'msg': 'bad end_date'}]}))
    assert 'bad start_date; bad end_date' in str(err)


def test_map_error_non_json_body_falls_back_to_text():
    err = mod._map_error(_resp(500, None, text='internal error'))
    assert 'Oura API 500' in str(err)
    assert 'internal error' in str(err)


# ---------------------------------------------------------------------------
# collection whitelist sanity
# ---------------------------------------------------------------------------


def test_collections_whitelist_contains_core_endpoints():
    for name in ('daily_sleep', 'daily_readiness', 'daily_activity', 'sleep', 'heartrate', 'workout'):
        assert name in mod.COLLECTIONS


def test_date_helpers_reject_non_iso_types():
    with pytest.raises(ValueError):
        mod._parse_date('07/01/2026', 'start_date')
    assert mod._parse_date('2026-07-01', 'start_date') == date(2026, 7, 1)


# ---------------------------------------------------------------------------
# IGlobal._get_token credential precedence
# ---------------------------------------------------------------------------


def test_get_token_node_config_wins_over_all():
    with patch.dict('os.environ', {'ROCKETRIDE_OURA_TOKEN': 'env-token'}):
        token = glb_mod.IGlobal._get_token({'token': 'cfg-token'}, {'token': 'conn-token'})
    assert token == 'cfg-token'


def test_get_token_falls_back_to_connection_config():
    with patch.dict('os.environ', {'ROCKETRIDE_OURA_TOKEN': 'env-token'}):
        token = glb_mod.IGlobal._get_token({}, {'token': 'conn-token'})
    assert token == 'conn-token'


def test_get_token_falls_back_to_environment():
    with patch.dict('os.environ', {'ROCKETRIDE_OURA_TOKEN': 'env-token'}):
        token = glb_mod.IGlobal._get_token({}, {})
    assert token == 'env-token'


def test_get_token_empty_when_no_source():
    with patch.dict('os.environ', {}, clear=False):
        import os

        os.environ.pop('ROCKETRIDE_OURA_TOKEN', None)
        token = glb_mod.IGlobal._get_token({}, {})
    assert token == ''


def test_get_token_strips_whitespace_and_skips_blank_values():
    # A whitespace-only node-config token must not shadow the next source.
    with patch.dict('os.environ', {'ROCKETRIDE_OURA_TOKEN': ''}):
        token = glb_mod.IGlobal._get_token({'token': '   '}, {'token': '  conn-token  '})
    assert token == 'conn-token'


def test_get_token_whitespace_only_env_yields_empty():
    with patch.dict('os.environ', {'ROCKETRIDE_OURA_TOKEN': '   '}):
        token = glb_mod.IGlobal._get_token({}, {})
    assert token == ''


# ---------------------------------------------------------------------------
# IInstance next_token short-circuit
# ---------------------------------------------------------------------------


def _make_instance():
    inst = inst_mod.IInstance.__new__(inst_mod.IInstance)
    inst.IGlobal = type('FakeGlobal', (), {'token': 'tok'})()
    return inst


def _fake_fetch(calls):
    def fetch(token, collection, *, params=None, next_token=None, max_pages=None):
        calls['params'] = params
        calls['next_token'] = next_token
        return {'data': [], 'next_token': None}

    return fetch


def test_fetch_range_next_token_skips_date_validation():
    """A malformed date range must not block a pagination continuation."""
    inst = _make_instance()
    calls = {}
    with patch.object(inst_mod, 'fetch_collection', _fake_fetch(calls)):
        out = inst._fetch_range('daily_sleep', {'next_token': 'abc', 'start_date': 'not-a-date'})
    assert calls['next_token'] == 'abc'
    assert calls['params'] is None
    assert out['query'] == {'collection': 'daily_sleep', 'continued_from_next_token': True}


def test_fetch_range_without_next_token_still_validates_dates():
    inst = _make_instance()
    with patch.object(inst_mod, 'fetch_collection', _fake_fetch({})):
        with pytest.raises(ValueError, match='ISO date'):
            inst._fetch_range('daily_sleep', {'start_date': 'not-a-date'})


def test_heartrate_next_token_skips_datetime_validation():
    inst = _make_instance()
    calls = {}
    with patch.object(inst_mod, 'fetch_collection', _fake_fetch(calls)):
        out = inst.heartrate({'next_token': 'abc', 'start_datetime': 'garbage'})
    assert calls['next_token'] == 'abc'
    assert calls['params'] is None
    assert out['query'] == {'collection': 'heartrate', 'continued_from_next_token': True}


# ---------------------------------------------------------------------------
# IInstance response contracts
# ---------------------------------------------------------------------------


def test_daily_summary_reports_truncated_collections():
    """A page-cap hit must be surfaced — silent truncation misleads the agent."""
    inst = _make_instance()

    def fetch(token, collection, *, params=None, next_token=None, max_pages=None):
        if collection == 'daily_sleep':
            return {'data': [{'day': '2026-07-01', 'score': 80}], 'next_token': 'more'}
        return {'data': [], 'next_token': None}

    with patch.object(inst_mod, 'fetch_collection', fetch):
        out = inst.daily_summary({'start_date': '2026-01-01', 'end_date': '2026-07-01'})

    assert out['truncated']['collections'] == ['daily_sleep']
    assert 'narrower' in out['truncated']['note']
    assert out['query']['collections'] == ['daily_sleep', 'daily_readiness', 'daily_activity', 'daily_stress']


def test_daily_summary_complete_response_has_no_truncated_key():
    inst = _make_instance()
    with patch.object(inst_mod, 'fetch_collection', _fake_fetch({})):
        out = inst.daily_summary({'start_date': '2026-07-01', 'end_date': '2026-07-08'})
    assert 'truncated' not in out
    assert 'skipped_collections' not in out


def test_daily_summary_skips_scope_missing_collections():
    """A token without one collection's scope must yield a partial summary, not a failure."""
    inst = _make_instance()

    def fetch(token, collection, *, params=None, next_token=None, max_pages=None):
        if collection == 'daily_stress':
            raise ValueError('Oura scope not granted (401) — re-authorize the app with this scope: daily_stress')
        return {'data': [{'day': '2026-07-01', 'score': 80}], 'next_token': None}

    with patch.object(inst_mod, 'fetch_collection', fetch):
        out = inst.daily_summary({'start_date': '2026-07-01', 'end_date': '2026-07-08'})

    assert out['skipped_collections']['collections'] == ['daily_stress']
    assert out['days']  # the other three collections still produced data


def test_daily_summary_raises_when_every_collection_lacks_scope():
    inst = _make_instance()

    def fetch(token, collection, *, params=None, next_token=None, max_pages=None):
        raise ValueError('Oura scope not granted (401)')

    with patch.object(inst_mod, 'fetch_collection', fetch):
        with pytest.raises(ValueError, match='scope not granted'):
            inst.daily_summary({'start_date': '2026-07-01', 'end_date': '2026-07-08'})


def test_daily_summary_non_scope_error_still_fails_the_call():
    """Only scope errors are recoverable — auth/rate-limit failures must propagate."""
    inst = _make_instance()

    def fetch(token, collection, *, params=None, next_token=None, max_pages=None):
        raise ValueError('Oura rate limit exceeded (429) — back off and retry later.')

    with patch.object(inst_mod, 'fetch_collection', fetch):
        with pytest.raises(ValueError, match='rate limit'):
            inst.daily_summary({'start_date': '2026-07-01', 'end_date': '2026-07-08'})


def test_ring_configuration_returns_query_envelope():
    inst = _make_instance()
    with patch.object(inst_mod, 'fetch_collection', _fake_fetch({})):
        out = inst.ring_configuration({})
    assert out['query'] == {'collection': 'ring_configuration'}


def test_ring_configuration_next_token_flags_continuation():
    inst = _make_instance()
    calls = {}
    with patch.object(inst_mod, 'fetch_collection', _fake_fetch(calls)):
        out = inst.ring_configuration({'next_token': 'abc'})
    assert calls['next_token'] == 'abc'
    assert out['query'] == {'collection': 'ring_configuration', 'continued_from_next_token': True}


def test_document_get_url_escapes_document_id():
    """A document_id containing path metacharacters must stay in the path segment."""
    inst = _make_instance()
    paths = []

    def fake_call(token, path, *, params=None):
        paths.append(path)
        return {'id': 'x'}

    with patch.object(inst_mod, 'call', fake_call):
        inst.document_get({'collection': 'sleep', 'document_id': '../personal_info?x=1'})

    assert paths == ['/usercollection/sleep/..%2Fpersonal_info%3Fx%3D1']


def test_collection_get_rejects_heartrate():
    """The date-range escape hatch must refuse heartrate (it filters on datetimes)."""
    inst = _make_instance()
    with pytest.raises(ValueError, match='dedicated tools'):
        inst.collection_get({'collection': 'heartrate'})


def test_collection_get_rejects_ring_configuration():
    inst = _make_instance()
    with pytest.raises(ValueError, match='not a date-filtered collection'):
        inst.collection_get({'collection': 'ring_configuration'})


def test_document_get_rejects_heartrate():
    """Reject heartrate locally — it has no per-document endpoint, so Oura would 404."""
    inst = _make_instance()
    with pytest.raises(ValueError, match='no per-document endpoint'):
        inst.document_get({'collection': 'heartrate', 'document_id': 'abc'})


def test_collection_get_unknown_name_says_unknown():
    """A typo must be reported as unknown, not as a known-but-excluded collection."""
    inst = _make_instance()
    with pytest.raises(ValueError, match='unknown collection'):
        inst.collection_get({'collection': 'daily_slep'})


def test_document_get_unknown_name_says_unknown():
    inst = _make_instance()
    with pytest.raises(ValueError, match='unknown collection'):
        inst.document_get({'collection': 'nope', 'document_id': 'abc'})


def test_date_range_props_advertise_the_real_default_window():
    """The schema must not claim a 7-day default for tools that fetch 30 or 90 days."""
    assert 'minus 30 days' in inst_mod._date_range_props(30)['start_date']['description']
    assert 'minus 90 days' in inst_mod._date_range_props(90)['start_date']['description']


def test_heartrate_query_echoes_collection():
    inst = _make_instance()
    with patch.object(inst_mod, 'fetch_collection', _fake_fetch({})):
        out = inst.heartrate({'start_datetime': '2026-07-01T00:00:00Z', 'end_datetime': '2026-07-01T06:00:00Z'})
    assert out['query']['collection'] == 'heartrate'
    assert out['query']['start_datetime'] == '2026-07-01T00:00:00+00:00'


def test_ring_battery_level_uses_datetime_window():
    inst = _make_instance()
    calls = {}
    with patch.object(inst_mod, 'fetch_collection', _fake_fetch(calls)):
        out = inst.ring_battery_level(
            {'start_datetime': '2026-07-01T00:00:00Z', 'end_datetime': '2026-07-02T00:00:00Z'}
        )
    assert calls['params'] == {
        'start_datetime': '2026-07-01T00:00:00+00:00',
        'end_datetime': '2026-07-02T00:00:00+00:00',
    }
    assert out['query']['collection'] == 'ring_battery_level'


def test_ring_battery_level_next_token_skips_datetime_validation():
    inst = _make_instance()
    calls = {}
    with patch.object(inst_mod, 'fetch_collection', _fake_fetch(calls)):
        out = inst.ring_battery_level({'next_token': 'abc', 'start_datetime': 'garbage'})
    assert calls['next_token'] == 'abc'
    assert out['query'] == {'collection': 'ring_battery_level', 'continued_from_next_token': True}


def test_escape_hatches_exclude_ring_battery_level():
    """ring_battery_level is datetime-windowed and has no per-document endpoint."""
    inst = _make_instance()
    with pytest.raises(ValueError, match='dedicated tools'):
        inst.collection_get({'collection': 'ring_battery_level'})
    with pytest.raises(ValueError, match='no per-document endpoint'):
        inst.document_get({'collection': 'ring_battery_level', 'document_id': 'abc'})


# ---------------------------------------------------------------------------
# call() transport
# ---------------------------------------------------------------------------


def test_call_returns_parsed_json_on_success():
    """A successful response is parsed and handed back to the caller."""
    with patch.object(mod, 'get_with_retry', return_value=_resp(200, {'data': [{'id': '1'}]})):
        assert mod.call('tok', '/usercollection/daily_sleep') == {'data': [{'id': '1'}]}


def test_call_sends_bearer_token_and_drops_none_params():
    """The bearer header is set and None-valued params are stripped."""
    fake = MagicMock(return_value=_resp(200, {}))
    with patch.object(mod, 'get_with_retry', fake):
        mod.call('tok', '/usercollection/daily_sleep', params={'start_date': '2026-07-01', 'next_token': None})
    kwargs = fake.call_args.kwargs
    assert kwargs['headers']['Authorization'] == 'Bearer tok'
    assert kwargs['params'] == {'start_date': '2026-07-01'}


def test_call_maps_http_error_through_map_error():
    """A non-retryable status still yields the status-specific message."""
    err = mod.requests.HTTPError('401', response=_resp(401, {'detail': 'invalid token'}))
    with patch.object(mod, 'get_with_retry', side_effect=err):
        with pytest.raises(ValueError, match='authentication failed'):
            mod.call('tok', '/usercollection/daily_sleep')


def test_call_timeout_survives_retry_as_timeout_message():
    """A timeout that outlives the retry policy is reported as a timeout."""
    with patch.object(mod, 'get_with_retry', side_effect=mod.requests.Timeout()):
        with pytest.raises(ValueError, match='timed out'):
            mod.call('tok', '/usercollection/daily_sleep')


def test_call_connection_error_survives_retry_as_request_failed():
    """A connection error that outlives the retry policy is reported clearly."""
    with patch.object(mod, 'get_with_retry', side_effect=mod.requests.ConnectionError('boom')):
        with pytest.raises(ValueError, match='request failed'):
            mod.call('tok', '/usercollection/daily_sleep')


def test_call_non_json_success_body_raises():
    """A 2xx with an unparseable body is reported instead of returned raw."""
    with patch.object(mod, 'get_with_retry', return_value=_resp(200)):
        with pytest.raises(ValueError, match='non-JSON'):
            mod.call('tok', '/usercollection/daily_sleep')


# ---------------------------------------------------------------------------
# IGlobal.beginGlobal
# ---------------------------------------------------------------------------


def test_begin_global_raises_when_no_token_available():
    """No token from any source fails the pipeline early with a node-specific message."""
    glb = glb_mod.IGlobal.__new__(glb_mod.IGlobal)
    glb.IEndpoint = MagicMock()
    glb.IEndpoint.endpoint.openMode = object()  # anything but OPEN_MODE.CONFIG
    glb.glb = MagicMock(logicalType='tool_oura', connConfig={})

    # beginGlobal imports `depends` lazily at call time, and the bootstrap
    # stubs were removed after import — re-inject one just for this call.
    depends_stub = MagicMock()
    depends_stub.load_depends = lambda *a, **kw: None

    with patch.dict(sys.modules, {'depends': depends_stub}):
        with patch.object(glb_mod.Config, 'getNodeConfig', return_value={}):
            with patch.dict(os.environ, {'ROCKETRIDE_OURA_TOKEN': ''}, clear=False):
                with pytest.raises(Exception, match='token is required'):
                    glb.beginGlobal()
