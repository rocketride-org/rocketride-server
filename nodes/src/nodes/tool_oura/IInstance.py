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
Oura tool node instance.

Exposes the Oura API v2 (https://api.ouraring.com/v2) as read-only agent
tools: daily sleep / readiness / activity / stress / resilience scores,
detailed sleep periods, heart rate, SpO2, workouts, sessions, tags, VO2 max,
cardiovascular age, rest mode, sleep-time recommendations, ring configuration,
and personal info — plus a cross-collection daily summary.
"""

from __future__ import annotations

from datetime import datetime, timezone

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input, require_str

from .oura_client import (
    COLLECTIONS,
    call,
    compact_document,
    compact_result,
    fetch_collection,
    merge_daily_summary,
    resolve_date_range,
    resolve_datetime_range,
)
from .IGlobal import IGlobal

# ---------------------------------------------------------------------------
# Shared parameter descriptions
# ---------------------------------------------------------------------------
_START_DATE_DESC = 'Start date, ISO format YYYY-MM-DD (default: end_date minus 7 days).'
_END_DATE_DESC = 'End date, ISO format YYYY-MM-DD (default: today, UTC).'
_NEXT_TOKEN_DESC = 'Pagination token from a previous truncated response. When set, date filters are ignored.'
_INCLUDE_DETAIL_DESC = (
    'Include heavy time-series fields (5-minute phase strings, per-second samples). '
    'Default false — the compact form is enough for scores and trends.'
)

_DATE_RANGE_PROPS = {
    'start_date': {'type': 'string', 'description': _START_DATE_DESC},
    'end_date': {'type': 'string', 'description': _END_DATE_DESC},
    'next_token': {'type': 'string', 'description': _NEXT_TOKEN_DESC},
}


def _dated(text: str):
    """Return a callable description that appends today's date at tool-query time.

    LLMs do not reliably know the current date and will
    otherwise hallucinate ranges from their training era; anchoring every
    description with today's date lets them resolve "last week" correctly.
    The engine evaluates callable tool_function parameters per query, so the
    date stays current on long-running pipelines.
    """

    def _desc(self) -> str:  # noqa: ANN001 - signature fixed by tool_function contract
        today = datetime.now(timezone.utc).date().isoformat()
        return f'{text} Today (UTC) is {today}; omit dates to get the most recent window.'

    return _desc


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------

    def _token(self) -> str:
        return self.IGlobal.token

    def _fetch_range(self, collection: str, args: dict, *, default_days: int = 7) -> dict:
        """Fetch a date-filtered collection and return a compact result envelope."""
        start, end = resolve_date_range(args, default_days=default_days)
        result = fetch_collection(
            self._token(),
            collection,
            params={'start_date': start, 'end_date': end},
            next_token=(args.get('next_token') or None),
        )
        compacted = compact_result(result, include_detail=bool(args.get('include_detail')))
        compacted['query'] = {'collection': collection, 'start_date': start, 'end_date': end}
        return compacted

    # =======================================================================
    # PROFILE
    # =======================================================================

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description='Get the Oura profile of the authenticated user: age, weight, height, biological sex, email.',
    )
    def personal_info(self, args):
        normalize_tool_input(args, tool_name='tool_oura')
        return call(self._token(), '/usercollection/personal_info')

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {'next_token': {'type': 'string', 'description': _NEXT_TOKEN_DESC}},
        },
        description='Get the ring hardware configuration: color, design, firmware version, hardware type, size.',
    )
    def ring_configuration(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        result = fetch_collection(self._token(), 'ring_configuration', next_token=(args.get('next_token') or None))
        return result

    # =======================================================================
    # DAILY SUMMARIES
    # =======================================================================

    @tool_function(
        input_schema={'type': 'object', 'properties': dict(_DATE_RANGE_PROPS)},
        description=_dated(
            'Get a merged day-by-day overview combining sleep score, readiness score, activity '
            '(steps, calories), and stress. The best first call for "how have I been doing" questions.'
        ),
    )
    def daily_summary(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        start, end = resolve_date_range(args, default_days=7)
        params = {'start_date': start, 'end_date': end}
        collections = {}
        for name in ('daily_sleep', 'daily_readiness', 'daily_activity', 'daily_stress'):
            collections[name] = fetch_collection(self._token(), name, params=params)['data']
        return {
            'query': {'start_date': start, 'end_date': end},
            'days': merge_daily_summary(collections),
        }

    @tool_function(
        input_schema={'type': 'object', 'properties': dict(_DATE_RANGE_PROPS)},
        description=_dated('Get daily sleep scores and their contributors (deep sleep, efficiency, latency, REM, restfulness, timing, total sleep).'),
    )
    def sleep_daily(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('daily_sleep', args)

    @tool_function(
        input_schema={'type': 'object', 'properties': dict(_DATE_RANGE_PROPS)},
        description=_dated('Get daily readiness scores and contributors (HRV balance, resting heart rate, body temperature, recovery index, previous day activity).'),
    )
    def readiness_daily(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('daily_readiness', args)

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                **_DATE_RANGE_PROPS,
                'include_detail': {'type': 'boolean', 'description': _INCLUDE_DETAIL_DESC},
            },
        },
        description=_dated('Get daily activity: score, steps, active/total/target calories, MET minutes, sedentary and resting time.'),
    )
    def activity_daily(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('daily_activity', args)

    @tool_function(
        input_schema={'type': 'object', 'properties': dict(_DATE_RANGE_PROPS)},
        description=_dated('Get daily stress: high-stress and high-recovery seconds and the day summary (restored / normal / stressful).'),
    )
    def stress_daily(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('daily_stress', args)

    @tool_function(
        input_schema={'type': 'object', 'properties': dict(_DATE_RANGE_PROPS)},
        description=_dated('Get daily resilience: level (limited/adequate/solid/strong/exceptional) and sleep/daytime recovery contributors.'),
    )
    def resilience_daily(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('daily_resilience', args)

    @tool_function(
        input_schema={'type': 'object', 'properties': dict(_DATE_RANGE_PROPS)},
        description=_dated('Get daily blood oxygen saturation (SpO2) averages and breathing disturbance index from sleep.'),
    )
    def spo2_daily(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('daily_spo2', args)

    @tool_function(
        input_schema={'type': 'object', 'properties': dict(_DATE_RANGE_PROPS)},
        description=_dated('Get daily cardiovascular age estimates (vascular age relative to chronological age).'),
    )
    def cardiovascular_age_daily(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('daily_cardiovascular_age', args)

    # =======================================================================
    # DETAILED RECORDS
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                **_DATE_RANGE_PROPS,
                'include_detail': {'type': 'boolean', 'description': _INCLUDE_DETAIL_DESC},
            },
        },
        description=_dated(
            'Get detailed sleep periods: bedtime start/end, sleep stage durations (deep/REM/light), '
            'latency, average and lowest heart rate, average HRV, respiratory rate, efficiency. '
            'One document per sleep period (naps included).'
        ),
    )
    def sleep_periods(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('sleep', args)

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                'start_datetime': {
                    'type': 'string',
                    'description': 'Start of the window, ISO 8601 datetime (default: 24 hours before end).',
                },
                'end_datetime': {
                    'type': 'string',
                    'description': 'End of the window, ISO 8601 datetime (default: now, UTC).',
                },
                'next_token': {'type': 'string', 'description': _NEXT_TOKEN_DESC},
            },
        },
        description=_dated(
            'Get raw heart rate samples (bpm with timestamp and source: awake/rest/sleep/session/workout). '
            'High volume — keep the window small (hours, not weeks).'
        ),
    )
    def heartrate(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        start, end = resolve_datetime_range(args, default_hours=24)
        result = fetch_collection(
            self._token(),
            'heartrate',
            params={'start_datetime': start, 'end_datetime': end},
            next_token=(args.get('next_token') or None),
        )
        result['query'] = {'start_datetime': start, 'end_datetime': end}
        return result

    @tool_function(
        input_schema={'type': 'object', 'properties': dict(_DATE_RANGE_PROPS)},
        description=_dated('Get logged workouts: activity type, intensity, calories, distance, start/end time, source.'),
    )
    def workouts(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('workout', args, default_days=30)

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                **_DATE_RANGE_PROPS,
                'include_detail': {'type': 'boolean', 'description': _INCLUDE_DETAIL_DESC},
            },
        },
        description=_dated('Get guided and unguided sessions (meditation, breathing, relaxation, rest) with heart rate and HRV outcomes.'),
    )
    def sessions(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('session', args, default_days=30)

    @tool_function(
        input_schema={'type': 'object', 'properties': dict(_DATE_RANGE_PROPS)},
        description=_dated('Get enhanced tags: user-logged events (caffeine, alcohol, sickness, custom tags) with timestamps and comments.'),
    )
    def tags(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('enhanced_tag', args, default_days=30)

    @tool_function(
        input_schema={'type': 'object', 'properties': dict(_DATE_RANGE_PROPS)},
        description=_dated('Get rest mode periods (times the user enabled rest mode, e.g. while sick or recovering).'),
    )
    def rest_mode_periods(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('rest_mode_period', args, default_days=90)

    @tool_function(
        input_schema={'type': 'object', 'properties': dict(_DATE_RANGE_PROPS)},
        description=_dated("Get Oura's recommended bedtime windows and sleep-timing status per day."),
    )
    def sleep_time(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('sleep_time', args)

    @tool_function(
        input_schema={'type': 'object', 'properties': dict(_DATE_RANGE_PROPS)},
        description=_dated('Get VO2 max estimates (cardio capacity) per day.'),
    )
    def vo2_max(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('vO2_max', args, default_days=30)

    # =======================================================================
    # GENERIC ESCAPE HATCHES
    # =======================================================================

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['collection'],
            'properties': {
                'collection': {
                    'type': 'string',
                    'enum': sorted(COLLECTIONS),
                    'description': 'Oura usercollection name.',
                },
                **_DATE_RANGE_PROPS,
                'include_detail': {'type': 'boolean', 'description': _INCLUDE_DETAIL_DESC},
            },
        },
        description=_dated(
            'Fetch any Oura usercollection by name with a date range. Escape hatch for collections '
            'not covered by a dedicated tool, or for cross-checking raw responses.'
        ),
    )
    def collection_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        collection = require_str(args, 'collection', tool_name='collection_get')
        if collection not in COLLECTIONS:
            raise ValueError(
                f'collection_get: unknown collection {collection!r}. Valid: {", ".join(sorted(COLLECTIONS))}'
            )
        return self._fetch_range(collection, args)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['collection', 'document_id'],
            'properties': {
                'collection': {
                    'type': 'string',
                    'enum': sorted(COLLECTIONS),
                    'description': 'Oura usercollection name.',
                },
                'document_id': {'type': 'string', 'description': 'Document ID from a previous list response.'},
                'include_detail': {'type': 'boolean', 'description': _INCLUDE_DETAIL_DESC},
            },
        },
        description='Fetch a single Oura document by its ID, e.g. one specific sleep period or workout.',
    )
    def document_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        collection = require_str(args, 'collection', tool_name='document_get')
        document_id = require_str(args, 'document_id', tool_name='document_get')
        if collection not in COLLECTIONS:
            raise ValueError(
                f'document_get: unknown collection {collection!r}. Valid: {", ".join(sorted(COLLECTIONS))}'
            )
        doc = call(self._token(), f'/usercollection/{collection}/{document_id}')
        return compact_document(doc, include_detail=bool(args.get('include_detail')))
