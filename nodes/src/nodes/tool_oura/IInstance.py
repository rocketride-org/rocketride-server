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
ring battery level, and personal info — plus a cross-collection daily summary.
"""

from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import quote

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
_END_DATE_DESC = (
    "End date, ISO format YYYY-MM-DD (default: tomorrow UTC, which always covers the wearer's current local day)."
)
_NEXT_TOKEN_DESC = (
    'Pagination token from a previous truncated response. When set, date/datetime filters are ignored. '
    'Results are date-ascending, so a truncated response is missing the MOST RECENT documents — '
    'pass the token back to fetch them.'
)
_INCLUDE_DETAIL_DESC = (
    'Include heavy time-series fields (5-minute phase strings, per-second samples). '
    'Default false — the compact form is enough for scores and trends.'
)


def _datetime_range_props(default_hours: int) -> dict:
    """Build start/end/next_token schema props for datetime-windowed tools."""
    return {
        'start_datetime': {
            'type': 'string',
            'description': f'Start of the window, ISO 8601 datetime (default: {default_hours} hours before end).',
        },
        'end_datetime': {
            'type': 'string',
            'description': 'End of the window, ISO 8601 datetime (default: now, UTC).',
        },
        'next_token': {'type': 'string', 'description': _NEXT_TOKEN_DESC},
    }


def _date_range_props(default_days: int) -> dict:
    """Build start/end/next_token schema props with the tool's real default window.

    Each tool passes its own ``default_days`` so the advertised default matches
    what ``_fetch_range`` actually does (7 for daily scores, 30 for workouts /
    sessions / tags / VO2 max, 90 for rest mode).
    """
    return {
        'start_date': {
            'type': 'string',
            'description': f'Start date, ISO format YYYY-MM-DD (default: end_date minus {default_days} days).',
        },
        'end_date': {'type': 'string', 'description': _END_DATE_DESC},
        'next_token': {'type': 'string', 'description': _NEXT_TOKEN_DESC},
    }


# Collections the generic escape hatches can serve. heartrate and
# ring_battery_level filter on datetimes (not start_date/end_date) and
# ring_configuration takes no filters at all, so collection_get would send
# parameters Oura rejects or ignores — all three have dedicated tools.
# heartrate and ring_battery_level additionally have no per-document
# endpoint, so document_get excludes them too.
_RANGE_COLLECTIONS = frozenset(COLLECTIONS - {'heartrate', 'ring_battery_level', 'ring_configuration'})
_DOCUMENT_COLLECTIONS = frozenset(COLLECTIONS - {'heartrate', 'ring_battery_level'})


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
        next_token = args.get('next_token') or None
        if next_token:
            # Oura ignores date filters on continuation requests, so skip date
            # resolution entirely — a malformed range must not block pagination.
            result = fetch_collection(self._token(), collection, next_token=next_token)
            compacted = compact_result(result, include_detail=bool(args.get('include_detail')))
            compacted['query'] = {'collection': collection, 'continued_from_next_token': True}
            return compacted

        start, end = resolve_date_range(args, default_days=default_days)
        result = fetch_collection(
            self._token(),
            collection,
            params={'start_date': start, 'end_date': end},
        )
        compacted = compact_result(result, include_detail=bool(args.get('include_detail')))
        compacted['query'] = {'collection': collection, 'start_date': start, 'end_date': end}
        return compacted

    def _fetch_datetime_range(self, collection: str, args: dict, *, default_hours: int = 24) -> dict:
        """Fetch a datetime-windowed collection (heartrate, ring_battery_level).

        Unlike :meth:`_fetch_range` this deliberately does NOT compact: these
        two collections return flat scalar documents (bpm / battery_level plus
        a timestamp) with none of the heavy time-series fields compaction
        strips, so there is nothing to remove and no ``include_detail`` switch
        is offered. Do not "fix" the asymmetry by compacting here — that would
        silently drop fields with no way for a caller to get them back.
        """
        next_token = args.get('next_token') or None
        if next_token:
            # Oura ignores datetime filters on continuation requests, so skip
            # resolution entirely — a malformed range must not block pagination.
            result = fetch_collection(self._token(), collection, next_token=next_token)
            result['query'] = {'collection': collection, 'continued_from_next_token': True}
            return result

        start, end = resolve_datetime_range(args, default_hours=default_hours)
        result = fetch_collection(
            self._token(),
            collection,
            params={'start_datetime': start, 'end_datetime': end},
        )
        result['query'] = {'collection': collection, 'start_datetime': start, 'end_datetime': end}
        return result

    # =======================================================================
    # PROFILE
    # =======================================================================

    @tool_function(
        input_schema={'type': 'object', 'properties': {}},
        description='Get the Oura profile of the authenticated user: age, weight, height, biological sex, email.',
    )
    def personal_info(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
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
        next_token = args.get('next_token') or None
        result = fetch_collection(self._token(), 'ring_configuration', next_token=next_token)
        # Same response contract as _fetch_range so agents see a uniform shape.
        if next_token:
            result['query'] = {'collection': 'ring_configuration', 'continued_from_next_token': True}
        else:
            result['query'] = {'collection': 'ring_configuration'}
        return result

    @tool_function(
        input_schema={'type': 'object', 'properties': _datetime_range_props(72)},
        description=_dated('Get ring battery level samples over time (percentage with timestamp).'),
    )
    def ring_battery_level(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_datetime_range('ring_battery_level', args, default_hours=72)

    # =======================================================================
    # DAILY SUMMARIES
    # =======================================================================

    @tool_function(
        # No next_token here: this tool merges four collections per call and does
        # not paginate, so advertising a pagination param would mislead agents.
        input_schema={
            'type': 'object',
            'properties': {
                'start_date': {
                    'type': 'string',
                    'description': 'Start date, ISO format YYYY-MM-DD (default: end_date minus 7 days).',
                },
                'end_date': {'type': 'string', 'description': _END_DATE_DESC},
            },
        },
        description=_dated(
            'Get a merged day-by-day overview combining sleep score, readiness score, activity '
            '(steps, calories), and stress. The best first call for "how have I been doing" questions. '
            'Collections the token lacks OAuth scopes for are skipped and listed in "skipped_collections". '
            'If the response contains a "truncated" key, the range was too wide and recent days are '
            'missing — retry with a narrower date range.'
        ),
    )
    def daily_summary(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        start, end = resolve_date_range(args, default_days=7)
        params = {'start_date': start, 'end_date': end}
        names = ('daily_sleep', 'daily_readiness', 'daily_activity', 'daily_stress')
        collections = {}
        truncated = []
        skipped = []
        scope_errors = []
        for name in names:
            try:
                result = fetch_collection(self._token(), name, params=params)
            except ValueError as exc:
                # A token may legitimately lack one collection's scope; a partial
                # summary is far more useful to the agent than a wholesale failure.
                # Anything other than a missing scope still fails the call.
                if 'scope' not in str(exc).lower():
                    raise
                skipped.append(name)
                scope_errors.append(exc)
                continue
            collections[name] = result['data']
            if result.get('next_token'):
                # Page cap hit. Data is date-ascending, so the MISSING documents
                # are the most recent ones — the agent must not present this as
                # a complete picture of the range.
                truncated.append(name)
        if not collections:
            raise scope_errors[0]
        response = {
            'query': {'start_date': start, 'end_date': end, 'collections': list(names)},
            'days': merge_daily_summary(collections),
        }
        if skipped:
            response['skipped_collections'] = {
                'collections': skipped,
                'note': 'The token lacks the OAuth scopes for these collections — re-authorize to include them.',
            }
        if truncated:
            response['truncated'] = {
                'collections': truncated,
                'note': 'Range too wide — the most recent days are missing for these collections. Use a narrower date range.',
            }
        return response

    @tool_function(
        input_schema={'type': 'object', 'properties': _date_range_props(7)},
        description=_dated(
            'Get daily sleep scores and their contributors (deep sleep, efficiency, latency, REM, restfulness, timing, total sleep).'
        ),
    )
    def sleep_daily(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('daily_sleep', args)

    @tool_function(
        input_schema={'type': 'object', 'properties': _date_range_props(7)},
        description=_dated(
            'Get daily readiness scores and contributors (HRV balance, resting heart rate, body temperature, recovery index, previous day activity).'
        ),
    )
    def readiness_daily(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('daily_readiness', args)

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                **_date_range_props(7),
                'include_detail': {'type': 'boolean', 'description': _INCLUDE_DETAIL_DESC},
            },
        },
        description=_dated(
            'Get daily activity: score, steps, active/total/target calories, MET minutes, sedentary and resting time.'
        ),
    )
    def activity_daily(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('daily_activity', args)

    @tool_function(
        input_schema={'type': 'object', 'properties': _date_range_props(7)},
        description=_dated(
            'Get daily stress: high-stress and high-recovery seconds and the day summary (restored / normal / stressful).'
        ),
    )
    def stress_daily(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('daily_stress', args)

    @tool_function(
        input_schema={'type': 'object', 'properties': _date_range_props(7)},
        description=_dated(
            'Get daily resilience: level (limited/adequate/solid/strong/exceptional) and sleep/daytime recovery contributors.'
        ),
    )
    def resilience_daily(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('daily_resilience', args)

    @tool_function(
        input_schema={'type': 'object', 'properties': _date_range_props(7)},
        description=_dated(
            'Get daily blood oxygen saturation (SpO2) averages and breathing disturbance index from sleep.'
        ),
    )
    def spo2_daily(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('daily_spo2', args)

    @tool_function(
        input_schema={'type': 'object', 'properties': _date_range_props(7)},
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
                **_date_range_props(7),
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
        input_schema={'type': 'object', 'properties': _datetime_range_props(24)},
        description=_dated(
            'Get raw heart rate samples (bpm with timestamp and source: awake/rest/sleep/session/workout). '
            'High volume — keep the window small (hours, not weeks).'
        ),
    )
    def heartrate(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_datetime_range('heartrate', args, default_hours=24)

    @tool_function(
        input_schema={'type': 'object', 'properties': _date_range_props(30)},
        description=_dated(
            'Get logged workouts: activity type, intensity, calories, distance, start/end time, source.'
        ),
    )
    def workouts(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('workout', args, default_days=30)

    @tool_function(
        input_schema={
            'type': 'object',
            'properties': {
                **_date_range_props(30),
                'include_detail': {'type': 'boolean', 'description': _INCLUDE_DETAIL_DESC},
            },
        },
        description=_dated(
            'Get guided and unguided sessions (meditation, breathing, relaxation, rest) with heart rate and HRV outcomes.'
        ),
    )
    def sessions(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('session', args, default_days=30)

    @tool_function(
        input_schema={'type': 'object', 'properties': _date_range_props(30)},
        description=_dated(
            'Get enhanced tags: user-logged events (caffeine, alcohol, sickness, custom tags) with timestamps and comments.'
        ),
    )
    def tags(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('enhanced_tag', args, default_days=30)

    @tool_function(
        input_schema={'type': 'object', 'properties': _date_range_props(90)},
        description=_dated('Get rest mode periods (times the user enabled rest mode, e.g. while sick or recovering).'),
    )
    def rest_mode_periods(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('rest_mode_period', args, default_days=90)

    @tool_function(
        input_schema={'type': 'object', 'properties': _date_range_props(7)},
        description=_dated("Get Oura's recommended bedtime windows and sleep-timing status per day."),
    )
    def sleep_time(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        return self._fetch_range('sleep_time', args)

    @tool_function(
        input_schema={'type': 'object', 'properties': _date_range_props(30)},
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
                    'enum': sorted(_RANGE_COLLECTIONS),
                    'description': 'Oura usercollection name (date-filtered collections only).',
                },
                **_date_range_props(7),
                'include_detail': {'type': 'boolean', 'description': _INCLUDE_DETAIL_DESC},
            },
        },
        description=_dated(
            'Fetch any date-filtered Oura usercollection by name. Escape hatch for cross-checking '
            'raw responses. Not for heartrate or ring_battery_level (datetime-windowed) or '
            'ring_configuration (no filters) — use their dedicated tools.'
        ),
    )
    def collection_get(self, args):
        args = normalize_tool_input(args, tool_name='tool_oura')
        collection = require_str(args, 'collection', tool_name='collection_get')
        if collection not in _RANGE_COLLECTIONS:
            if collection in COLLECTIONS:
                raise ValueError(
                    f'collection_get: {collection!r} is not a date-filtered collection — '
                    'use its dedicated tools (heartrate, ring_battery_level, ring_configuration).'
                )
            raise ValueError(
                f'collection_get: unknown collection {collection!r}. Valid: {", ".join(sorted(_RANGE_COLLECTIONS))}'
            )
        return self._fetch_range(collection, args)

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['collection', 'document_id'],
            'properties': {
                'collection': {
                    'type': 'string',
                    'enum': sorted(_DOCUMENT_COLLECTIONS),
                    'description': 'Oura usercollection name (heartrate has no per-document endpoint).',
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
        if collection not in _DOCUMENT_COLLECTIONS:
            if collection in COLLECTIONS:
                raise ValueError(f'document_get: {collection!r} has no per-document endpoint.')
            raise ValueError(
                f'document_get: unknown collection {collection!r}. Valid: {", ".join(sorted(_DOCUMENT_COLLECTIONS))}'
            )
        # URL-escape the ID so a value containing '/' or '..' cannot reach a
        # different endpoint on the host (path traversal within the API).
        doc = call(self._token(), f'/usercollection/{collection}/{quote(document_id, safe="")}')
        return compact_document(doc, include_detail=bool(args.get('include_detail')))
