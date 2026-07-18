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
_NODES_SRC = Path(__file__).resolve().parents[1] / 'src'
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

    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object  # must be a real class for inheritance
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f  # pass-through decorator
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = lambda *a, **kw: None
    rocketlib.OPEN_MODE = MagicMock()

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}
    ai_common_utils.require_str = lambda args, key, **kw: str(args[key])

    return {
        'requests': requests,
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
    today = datetime.now(timezone.utc).date()
    assert end == today.isoformat()
    assert start == (today - timedelta(days=7)).isoformat()


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
    assert datetime.fromisoformat(start).tzinfo is not None


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


def _resp(status, payload=None, text=''):
    resp = MagicMock()
    resp.status_code = status
    resp.text = text
    resp.reason = 'reason'
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
