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

# oura_client imports the engine-only `ai.common.utils` for the shared
# retrying GET. Under `builder nodes:test` that package is real and its
# backoff policy is exercised for free; loaded standalone (the case this file
# is built for) it does not exist, so fall back to a single-attempt stand-in
# with the same contract: return the response, raise on an error status.
_added_stubs = []
try:  # pragma: no cover - the engine provides this in a full test run
    import ai.common.utils  # noqa: F401
except ImportError:
    import sys
    import types

    import requests

    _ai_utils = types.ModuleType('ai.common.utils')
    _ai_common = types.ModuleType('ai.common')
    _ai = types.ModuleType('ai')

    def _get_with_retry(url, **kwargs):
        resp = requests.get(url, **kwargs)
        resp.raise_for_status()
        return resp

    _ai_utils.get_with_retry = _get_with_retry
    _ai_common.utils = _ai_utils
    _ai.common = _ai_common
    for _name, _stub in (('ai', _ai), ('ai.common', _ai_common), ('ai.common.utils', _ai_utils)):
        if _name not in sys.modules:
            sys.modules[_name] = _stub
            _added_stubs.append(_name)

_spec = importlib.util.spec_from_file_location('tool_oura_live_client', _CLIENT_PATH)
_client = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_client)

# Drop the stubs again: this module shares a pytest session with the offline
# suite (and every other node's), and a partial `ai.common.utils` left behind
# would shadow the real package for whoever imports it next.
for _name in _added_stubs:
    sys.modules.pop(_name, None)

call = _client.call
fetch_collection = _client.fetch_collection
merge_daily_summary = _client.merge_daily_summary

TOKEN = os.getenv('OURA_TOKEN', '')

pytestmark = pytest.mark.skipif(not TOKEN, reason='OURA_TOKEN must be set')


def _last_week() -> dict:
    # Mirror the connector's default window: end at UTC tomorrow so the
    # wearer's current local day is covered even ahead of UTC.
    end = datetime.now(timezone.utc).date() + timedelta(days=1)
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

    def test_vo2_max(self):
        # Covers the one collection whose API name (vO2_max) has unusual casing.
        try:
            result = fetch_collection(TOKEN, 'vO2_max', params=_last_week())
        except ValueError as exc:
            _skip_if_scope_missing(exc)
        assert isinstance(result['data'], list)

    def test_ring_battery_level(self):
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=3)
        try:
            result = fetch_collection(
                TOKEN,
                'ring_battery_level',
                params={'start_datetime': start.isoformat(), 'end_datetime': end.isoformat()},
                max_pages=1,
            )
        except ValueError as exc:
            _skip_if_scope_missing(exc)
        assert isinstance(result['data'], list)


class TestDateHandling:
    def test_future_end_date_accepted(self):
        """The connector's default range ends at UTC tomorrow — Oura must not reject it."""
        end = datetime.now(timezone.utc).date() + timedelta(days=1)
        try:
            result = fetch_collection(
                TOKEN,
                'daily_sleep',
                params={'start_date': (end - timedelta(days=2)).isoformat(), 'end_date': end.isoformat()},
            )
        except ValueError as exc:
            _skip_if_scope_missing(exc)
        assert isinstance(result['data'], list)


class TestErrors:
    def test_bad_token_maps_to_auth_error(self):
        with pytest.raises(ValueError, match='authentication failed'):
            call('not-a-real-token', '/usercollection/personal_info')
