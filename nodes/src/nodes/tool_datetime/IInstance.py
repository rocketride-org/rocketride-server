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
Date and time tool node instance.

WHY THIS EXISTS. A model has no clock, and telling it the date does not fix
arithmetic. It can be told today is Thursday 3 September and still book a
follow-up for "next Tuesday" on the wrong Tuesday, or add a month to 31 January
and produce the 31st of February. Those are the errors this node removes, by
doing the counting somewhere that counts correctly.

UNIX SECONDS ARE THE WIRE FORMAT. Every instant in and out is an integer epoch.
A timestamp carries no timezone to be wrong about, so nothing is lost passing one
between the model, this tool and a CRM. Dates, weekdays and "start of the month"
are a RENDERING of an instant, and `timezone` is the argument that resolves them.

THE DESCRIPTIONS CARRY THE CURRENT TIME. `@tool_function` evaluates a callable
`description` at tool.query time, so an agent reading its tool list learns what
"now" is without anything else having injected it. That matters where the agent
doing the work is a sub-agent several delegations deep, which is exactly where
an injected anchor tends not to reach.
"""

from __future__ import annotations

from typing import Any

from rocketlib import IInstanceBase, tool_function

from . import datetime_math as dtm
from .IGlobal import IGlobal

#: Reused by every schema. The one argument that decides what a date means.
_ZONE_ARG = {
    'type': 'string',
    'description': (
        'IANA timezone name, e.g. "America/Los_Angeles". Pass the caller\'s own '
        'zone whenever it is known — it decides what date an instant falls on. '
        'Omitted, the deployment default is used and the answer says which.'
    ),
}

_EPOCH_ARG = {
    'type': 'integer',
    'description': 'Unix timestamp in seconds. Use the epoch from an earlier call rather than re-deriving it.',
}

#: What every instant-returning tool answers with.
#:
#: TWO RENDERINGS, AND THE CALLER PICKS BY FIELD, NOT BY PREFERENCE. An instant
#: has a different date and time in every zone; which one a CRM field wants is a
#: fact about that field. Pipedrive reads an activity's `due_time` as UTC, while
#: GoHighLevel wants an offset-bearing local string. Both forms travel on every
#: answer so that writing the right one is reading a different key — never
#: subtracting an offset by hand, which is what put a 12:30 meeting into the CRM
#: at 05:30.
_INSTANT_RESULT = {
    'type': 'object',
    'description': (
        'epoch (unix seconds), iso, date (YYYY-MM-DD), time (HH:MM), weekday, '
        'the timezone actually used, and utc_iso/utc_date/utc_time — the SAME '
        'instant written in UTC. Write one of these pairs straight into a CRM '
        'rather than formatting or converting an instant yourself: use date/time '
        'for a field stored in local time, and utc_date/utc_time for a field '
        'the CRM reads as UTC. Check which the field wants; getting it wrong '
        'stores a real-looking time that is hours out.'
    ),
}


def _dated(text: str):
    """
    A description that states the current instant, refreshed on every read.

    The engine re-evaluates a callable description at tool.query time, so this
    never goes stale on a long-running task. Same device as `tool_oura`, for the
    same reason: without it a model dates from whenever its weights were frozen.

    AND IT SAYS WHOSE CLOCK IT IS. The zone here is the deployment's, which is
    not necessarily the zone of whoever is asking. Left unqualified, this line
    said "Right now it is … in UTC" beside a prompt anchor naming the caller's
    real zone — two statements that disagree about what day it is for anyone
    west of Greenwich in the evening, with nothing to say which to believe. A
    reader that resolves that by picking one has picked at random.
    """

    def _describe(self) -> str:
        moment = dtm.now(self.IGlobal.default_zone)
        return (
            f'{text} Right now it is {moment["date"]} {moment["time"]} '
            f'({moment["weekday"]}) in {moment["timezone"]}, '
            f'which is unix timestamp {moment["epoch"]}. That zone is this '
            f'deployment default, not necessarily the zone of the person you are '
            f'working for - pass theirs to get the date they are having.'
        )

    return _describe


class IInstance(IInstanceBase):
    IGlobal: IGlobal

    def _zone(self, args: dict, key: str = 'timezone') -> str:
        """The caller's zone, or the deployment's."""
        return str(args.get(key) or '').strip() or self.IGlobal.default_zone

    @staticmethod
    def _args(args: Any) -> dict:
        if not isinstance(args, dict):
            raise ValueError('Tool input must be a JSON object')
        return args

    @staticmethod
    def _epoch(args: dict, key: str = 'epoch') -> float:
        value = args.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f'"{key}" is required and must be a unix timestamp in seconds')
        return float(value)

    @tool_function(
        input_schema={'type': 'object', 'properties': {'timezone': _ZONE_ARG}},
        output_schema=_INSTANT_RESULT,
        description=_dated(
            'The current date and time. Call this before working out any date '
            'from words like "today", "tomorrow" or "next week" — never date '
            'those from your own sense of now.'
        ),
    )
    def now(self, args):
        """The current instant."""
        args = self._args(args or {})
        return dtm.now(self._zone(args))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['date', 'time'],
            'properties': {
                'date': {
                    'type': 'string',
                    'description': 'Calendar date, YYYY-MM-DD. Resolve a relative one with the other tools first.',
                },
                'time': {
                    'type': 'string',
                    'description': 'Wall-clock time as the person said it, 24-hour HH:MM. "12:30pm" is "12:30"; "8pm" is "20:00".',
                },
                'timezone': _ZONE_ARG,
            },
        },
        output_schema={
            'type': 'object',
            'description': (
                'The instant, in the shape every tool here returns — plus requested '
                '(the wall time asked for), adjusted (true when that hour does not '
                'exist, on the morning clocks go forward) and ambiguous (true when it '
                'happens twice, on the morning they go back). Say so in your report '
                'when either is true.'
            ),
        },
        description=_dated(
            'Turn a date and a clock time into an instant. Use this whenever a '
            'person names a time of day — "next Wednesday at 12:30pm" — and pass '
            'their timezone: a time of day means nothing without one. The answer '
            'carries both the local and the UTC form, so write whichever the CRM '
            'field asks for instead of converting it yourself.'
        ),
    )
    def at(self, args):
        """The instant a wall-clock date and time name in one zone."""
        args = self._args(args)
        return dtm.at(str(args.get('date') or ''), str(args.get('time') or ''), self._zone(args))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['epoch', 'amount', 'unit'],
            'properties': {
                'epoch': _EPOCH_ARG,
                'amount': {
                    'type': 'integer',
                    'description': 'How many units to move. Negative goes backwards.',
                },
                'unit': {
                    'type': 'string',
                    'enum': list(dtm.UNITS),
                    'description': (
                        'second/minute/hour move the instant by that duration. '
                        'day/week/month/year move the calendar and keep the time '
                        'of day, which is what "same time next week" means. '
                        'Month arithmetic clamps: 31 January plus one month is '
                        'the last day of February.'
                    ),
                },
                'timezone': _ZONE_ARG,
            },
        },
        output_schema=_INSTANT_RESULT,
        description=_dated(
            'Add or subtract time. Use this for "in 90 days", "three weeks '
            'from now", "a month before the close date" — do not do the '
            'arithmetic yourself.'
        ),
    )
    def shift(self, args):
        """An instant moved by a whole number of units."""
        args = self._args(args)
        amount = args.get('amount')
        if isinstance(amount, bool) or not isinstance(amount, int):
            raise ValueError('"amount" is required and must be a whole number')
        return dtm.shift(self._epoch(args), amount, str(args.get('unit') or ''), self._zone(args))

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['epoch', 'weekday'],
            'properties': {
                'epoch': _EPOCH_ARG,
                'weekday': {
                    'type': 'string',
                    'enum': list(dtm.WEEKDAYS),
                    'description': 'The day wanted, e.g. "tuesday".',
                },
                'allow_today': {
                    'type': 'boolean',
                    'description': (
                        'False by default, so "next Tuesday" asked on a Tuesday '
                        'means the one coming, not today. Pass true only when '
                        'today should count.'
                    ),
                },
                'timezone': _ZONE_ARG,
            },
        },
        output_schema=_INSTANT_RESULT,
        description=_dated(
            'The next occurrence of a weekday. Use this for "next Tuesday", '
            '"on Friday", "a week on Monday" — counting weekdays by hand is '
            'where dates most often go wrong.'
        ),
    )
    def next_weekday(self, args):
        """The next occurrence of a named weekday."""
        args = self._args(args)
        return dtm.next_weekday(
            self._epoch(args),
            str(args.get('weekday') or ''),
            self._zone(args),
            bool(args.get('allow_today')),
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['epoch', 'unit', 'edge'],
            'properties': {
                'epoch': _EPOCH_ARG,
                'unit': {
                    'type': 'string',
                    'enum': list(dtm.BOUNDARY_UNITS),
                    'description': 'The period the instant falls in.',
                },
                'edge': {
                    'type': 'string',
                    'enum': ['start', 'end'],
                    'description': (
                        'end is the last second of the period, so end-of-month '
                        'is the 31st rather than the 1st of the next.'
                    ),
                },
                'timezone': _ZONE_ARG,
            },
        },
        output_schema=_INSTANT_RESULT,
        description=_dated(
            'The first or last instant of a day, week, month, quarter or year. '
            'Use this for "end of the month", "this quarter", "start of next '
            'week" — month lengths and quarter boundaries are not worth '
            'recalling from memory.'
        ),
    )
    def boundary(self, args):
        """The first or last instant of a period."""
        args = self._args(args)
        return dtm.boundary(
            self._epoch(args),
            str(args.get('unit') or ''),
            str(args.get('edge') or ''),
            self._zone(args),
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['start', 'end', 'unit'],
            'properties': {
                'start': dict(_EPOCH_ARG, description='The earlier instant, unix seconds.'),
                'end': dict(_EPOCH_ARG, description='The later instant, unix seconds.'),
                'unit': {
                    'type': 'string',
                    'enum': ['second', 'minute', 'hour', 'day', 'week'],
                    'description': 'The unit `elapsed` is measured in.',
                },
                'timezone': _ZONE_ARG,
            },
        },
        output_schema={
            'type': 'object',
            'description': (
                'elapsed (real duration in the unit), calendar_days (how many '
                'dates apart they are on a wall calendar), and the timezone '
                'used. For "how many days until", calendar_days is the answer '
                'a person means.'
            ),
        },
        description=_dated(
            'How far apart two instants are. Returns both the real duration '
            'and the number of calendar days, because at 23:00 on Thursday '
            '"tomorrow" is one day away and 60 minutes away at the same time.'
        ),
    )
    def difference(self, args):
        """How far apart two instants are."""
        args = self._args(args)
        return dtm.difference(
            self._epoch(args, 'start'),
            self._epoch(args, 'end'),
            str(args.get('unit') or ''),
            self._zone(args),
        )

    @tool_function(
        input_schema={
            'type': 'object',
            'required': ['epoch'],
            'properties': {'epoch': _EPOCH_ARG, 'timezone': _ZONE_ARG},
        },
        output_schema=_INSTANT_RESULT,
        description=_dated(
            'Render a timestamp as a date and time in a given zone. Use the '
            'date (YYYY-MM-DD) and time (HH:MM) fields verbatim when writing '
            'to a CRM rather than formatting the instant yourself.'
        ),
    )
    def render(self, args):
        """One instant, in every shape a caller might need."""
        args = self._args(args)
        return dtm.render(self._epoch(args), self._zone(args))
