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

import importlib.util
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

# Load oura_client.py directly under a unique module name instead of touching
# sys.path. Importing through the `nodes` package is not possible here because
# nodes/__init__.py depends on the engine-only `depends` bootstrapper, and
# injecting the node directory into sys.path would shadow top-level module
# names and duplicate the module if it is also imported through the package.
_CLIENT_PATH = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'tool_oura' / 'oura_client.py'
_spec = importlib.util.spec_from_file_location('tool_oura_live_client', _CLIENT_PATH)
_client = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_client)

call = _client.call
fetch_collection = _client.fetch_collection
merge_daily_summary = _client.merge_daily_summary

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
        try:
            data = call(TOKEN, '/usercollection/personal_info')
        except ValueError as exc:
            _skip_if_scope_missing(exc)
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
        try:
            collections = {
                name: fetch_collection(TOKEN, name, params=params)['data']
                for name in ('daily_sleep', 'daily_readiness', 'daily_activity', 'daily_stress')
            }
        except ValueError as exc:
            _skip_if_scope_missing(exc)
        merged = merge_daily_summary(collections)
        assert isinstance(merged, list)
        assert merged == sorted(merged, key=lambda d: d['day'])


class TestDetailedCollections:
    def test_sleep_periods(self):
        try:
            result = fetch_collection(TOKEN, 'sleep', params=_last_week())
        except ValueError as exc:
            _skip_if_scope_missing(exc)
        assert isinstance(result['data'], list)

    def test_heartrate_window(self):
        end = datetime.now(timezone.utc)
        start = end - timedelta(hours=6)
        try:
            result = fetch_collection(
                TOKEN,
                'heartrate',
                params={'start_datetime': start.isoformat(), 'end_datetime': end.isoformat()},
                max_pages=1,
            )
        except ValueError as exc:
            _skip_if_scope_missing(exc)
        assert isinstance(result['data'], list)

    def test_workouts(self):
        try:
            result = fetch_collection(TOKEN, 'workout', params=_last_week())
        except ValueError as exc:
            _skip_if_scope_missing(exc)
        assert isinstance(result['data'], list)


class TestErrors:
    def test_bad_token_maps_to_auth_error(self):
        with pytest.raises(ValueError, match='authentication failed'):
            call('not-a-real-token', '/usercollection/personal_info')

    def test_unknown_collection_rejected_locally(self):
        with pytest.raises(ValueError, match='Unknown Oura collection'):
            fetch_collection(TOKEN, 'nope')
