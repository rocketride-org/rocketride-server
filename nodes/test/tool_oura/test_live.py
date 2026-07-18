"""
Live integration tests for tool_oura.

Calls the real Oura API v2 with a bearer token (an OAuth2 access token from a
registered Oura app, or a legacy personal access token). Read-only: the Oura
v2 API has no write endpoints for personal data, so these tests cannot modify
anything on the account.

    export OURA_TOKEN=<your access token>
    pytest nodes/test/tool_oura/test_live.py -v
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_oura'))
from oura_client import call, fetch_collection, merge_daily_summary  # noqa: E402

TOKEN = os.getenv('OURA_TOKEN', '')

pytestmark = pytest.mark.skipif(not TOKEN, reason='OURA_TOKEN must be set')


def _last_week() -> dict:
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=7)
    return {'start_date': start.isoformat(), 'end_date': end.isoformat()}


def _skip_if_scope_missing(exc: ValueError) -> None:
    """OAuth tokens may legitimately omit scopes — that's a config choice, not a failure."""
    if 'scope' in str(exc).lower():
        pytest.skip(f'token lacks scope: {exc}')
    raise exc


class TestProfile:
    def test_personal_info(self):
        data = call(TOKEN, '/usercollection/personal_info')
        assert 'id' in data

    def test_ring_configuration(self):
        try:
            result = fetch_collection(TOKEN, 'ring_configuration')
        except ValueError as exc:
            _skip_if_scope_missing(exc)
        assert isinstance(result['data'], list)


class TestDailyCollections:
    @pytest.mark.parametrize(
        'collection',
        ['daily_sleep', 'daily_readiness', 'daily_activity', 'daily_stress', 'daily_spo2'],
    )
    def test_daily_collection_shape(self, collection):
        try:
            result = fetch_collection(TOKEN, collection, params=_last_week())
        except ValueError as exc:
            _skip_if_scope_missing(exc)
        assert isinstance(result['data'], list)
        for doc in result['data']:
            assert 'day' in doc

    def test_daily_summary_merge(self):
        params = _last_week()
        collections = {
            name: fetch_collection(TOKEN, name, params=params)['data']
            for name in ('daily_sleep', 'daily_readiness', 'daily_activity', 'daily_stress')
        }
        merged = merge_daily_summary(collections)
        assert isinstance(merged, list)
        assert merged == sorted(merged, key=lambda d: d['day'])


class TestDetailedCollections:
    def test_sleep_periods(self):
        result = fetch_collection(TOKEN, 'sleep', params=_last_week())
        assert isinstance(result['data'], list)

    def test_heartrate_window(self):
        end = datetime.now(timezone.utc)
        start = end - timedelta(hours=6)
        result = fetch_collection(
            TOKEN,
            'heartrate',
            params={'start_datetime': start.isoformat(), 'end_datetime': end.isoformat()},
            max_pages=1,
        )
        assert isinstance(result['data'], list)

    def test_workouts(self):
        result = fetch_collection(TOKEN, 'workout', params=_last_week())
        assert isinstance(result['data'], list)


class TestErrors:
    def test_bad_token_maps_to_auth_error(self):
        with pytest.raises(ValueError, match='authentication failed'):
            call('not-a-real-token', '/usercollection/personal_info')

    def test_unknown_collection_rejected_locally(self):
        with pytest.raises(ValueError, match='Unknown Oura collection'):
            fetch_collection(TOKEN, 'nope')
