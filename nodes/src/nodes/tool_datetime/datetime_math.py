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
The arithmetic, with no engine around it.

Separated from ``IInstance`` so it can be tested as plain functions: this node
exists because a model gets date arithmetic wrong, and a node whose arithmetic
is only reachable through a running pipeline would be asking to be trusted on
exactly the thing it was built to be doubted about.

TWO KINDS OF SHIFT, AND THE DIFFERENCE MATTERS.

``minute`` and ``hour`` are durations: add them to the instant. ``day``, ``week``,
``month`` and ``year`` are calendar steps: convert to local time, move the
calendar, convert back. Across a daylight-saving boundary those disagree by an
hour, and the calendar answer is the one a person means. "Same time tomorrow"
is 09:00 tomorrow, not 08:00 because the clocks moved.
"""

from __future__ import annotations

import calendar
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

try:  # pragma: no cover - exercised by whichever branch the platform takes
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore[assignment]

#: Where an unusable zone lands. Never an exception: a mistyped zone should
#: cost the caller a UTC answer it can see and correct, not a failed turn.
DEFAULT_ZONE = 'UTC'

#: Calendar steps, which move the local date. See the module docstring.
CALENDAR_UNITS = ('day', 'week', 'month', 'year')

#: Durations, which move the instant.
DURATION_UNITS = ('second', 'minute', 'hour')

UNITS = DURATION_UNITS + CALENDAR_UNITS

#: Monday-first, matching ISO and `datetime.weekday()`.
WEEKDAYS = ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')

BOUNDARY_UNITS = ('day', 'week', 'month', 'quarter', 'year')


def resolve_zone(name: Optional[str]) -> tuple[Any, str]:
    """
    A timezone object and the name it actually resolved to.

    Args:
        name: An IANA name, or None/'' for the default.

    Returns:
        The tzinfo and the name to report, which is ``UTC`` whenever the
        requested one could not be used.
    """
    wanted = (name or '').strip()
    if not wanted or wanted.upper() == 'UTC' or ZoneInfo is None:
        return timezone.utc, DEFAULT_ZONE
    try:
        return ZoneInfo(wanted), wanted
    except Exception:  # noqa: BLE001 — a bad zone is an answer, not a failure
        return timezone.utc, DEFAULT_ZONE


def render(epoch: float, zone: Optional[str] = None) -> dict[str, Any]:
    """
    One instant, in every shape a caller might need.

    The `date` and `time` fields are the CRMs' formats — Pipedrive documents
    `due_date` as YYYY-MM-DD and `due_time` as HH:MM — so a caller never has to
    format an instant by hand, which is one more place to get it wrong.

    BOTH RENDERINGS, ALWAYS, and that is the point of the `utc_` fields.

    An instant has no single date and time: it has one per zone. A CRM field
    wants a particular one, and which is a fact about the field, not about the
    caller — Pipedrive reads `due_time` as UTC while GoHighLevel wants an
    offset-bearing local string. A booking asked for at 12:30 Pacific was
    written as `12:30`, stored as UTC, and shown back to the person who asked
    for it as 05:30.

    Nothing here can know which field it is feeding. What it can do is refuse to
    make the caller choose blind: every answer carries the local rendering and
    the UTC one side by side, so writing the right one is reading a different
    key rather than doing arithmetic. Subtracting an offset by hand is exactly
    the class of mistake this node exists to take away.

    `render` is the single funnel — `shift`, `next_weekday`, `boundary`, `at`
    and `now` all return through it — so these fields reach every tool answer.

    Args:
        epoch: Unix seconds.
        zone: IANA name, or None for UTC.

    Returns:
        The rendering, including the zone actually used and the UTC form.
    """
    tz, name = resolve_zone(zone)
    local = datetime.fromtimestamp(float(epoch), tz)
    utc = datetime.fromtimestamp(float(epoch), timezone.utc)
    return {
        'epoch': int(epoch),
        'iso': local.isoformat(),
        'date': local.strftime('%Y-%m-%d'),
        'time': local.strftime('%H:%M'),
        'weekday': local.strftime('%A'),
        'timezone': name,
        'utc_iso': utc.isoformat(),
        'utc_date': utc.strftime('%Y-%m-%d'),
        'utc_time': utc.strftime('%H:%M'),
    }


def _clamped(year: int, month: int, day: int) -> tuple[int, int, int]:
    """The same day of a different month, or that month's last day."""
    while month > 12:
        year, month = year + 1, month - 12
    while month < 1:
        year, month = year - 1, month + 12
    return year, month, min(day, calendar.monthrange(year, month)[1])


def shift(epoch: float, amount: int, unit: str, zone: Optional[str] = None) -> dict[str, Any]:
    """
    An instant moved by a whole number of units.

    Args:
        epoch: Unix seconds to move from.
        amount: How many, negative to go back.
        unit: One of `UNITS`.
        zone: The calendar to move within, for calendar units.

    Returns:
        The new instant, rendered.

    Raises:
        ValueError: On an unknown unit, which is a caller bug rather than a
            date that does not exist.
    """
    if unit not in UNITS:
        raise ValueError(f'"unit" must be one of {list(UNITS)}; got {unit!r}')

    if unit in DURATION_UNITS:
        seconds = {'second': 1, 'minute': 60, 'hour': 3600}[unit]
        return render(float(epoch) + amount * seconds, zone)

    tz, _ = resolve_zone(zone)
    local = datetime.fromtimestamp(float(epoch), tz)

    if unit == 'day':
        moved = local + timedelta(days=amount)
    elif unit == 'week':
        moved = local + timedelta(weeks=amount)
    else:
        months = amount if unit == 'month' else amount * 12
        year, month, day = _clamped(local.year, local.month + months, local.day)
        moved = local.replace(year=year, month=month, day=day)

    # Re-anchored in the zone rather than trusting the arithmetic's tzinfo: a
    # date built across a DST change carries the offset it started with, and
    # `timestamp()` on that is an hour out.
    return render(moved.replace(tzinfo=None).replace(tzinfo=tz).timestamp(), zone)


def next_weekday(
    epoch: float,
    weekday: str,
    zone: Optional[str] = None,
    allow_today: bool = False,
) -> dict[str, Any]:
    """
    The next occurrence of a named weekday.

    STRICTLY IN THE FUTURE BY DEFAULT, and that is a choice worth stating rather
    than discovering: asked on a Tuesday to book something "next Tuesday", a
    person means the one coming, not the day they are standing in. A caller that
    wants "today if today qualifies" passes `allow_today`.

    Time of day is preserved — this moves the date, not the clock.

    Args:
        epoch: Unix seconds to count from.
        weekday: A day name, case-insensitive.
        zone: The calendar to count in.
        allow_today: Whether landing on today counts as an occurrence.

    Returns:
        The occurrence, rendered.

    Raises:
        ValueError: On an unrecognised day name.
    """
    wanted = (weekday or '').strip().lower()
    if wanted not in WEEKDAYS:
        raise ValueError(f'"weekday" must be one of {list(WEEKDAYS)}; got {weekday!r}')

    tz, _ = resolve_zone(zone)
    local = datetime.fromtimestamp(float(epoch), tz)
    ahead = (WEEKDAYS.index(wanted) - local.weekday()) % 7
    if ahead == 0 and not allow_today:
        ahead = 7
    return shift(epoch, ahead, 'day', zone)


def boundary(epoch: float, unit: str, edge: str, zone: Optional[str] = None) -> dict[str, Any]:
    """
    The first or last instant of the period an instant falls in.

    `end` is the last SECOND of the period, not the first of the next one — so
    an end-of-month date reads as the 31st rather than the 1st, which is what
    somebody asking for "end of the month" means and what a CRM wants stored.

    Args:
        epoch: Unix seconds inside the period.
        unit: One of `BOUNDARY_UNITS`.
        edge: 'start' or 'end'.
        zone: The calendar the period belongs to.

    Returns:
        The boundary instant, rendered.

    Raises:
        ValueError: On an unknown unit or edge.
    """
    if unit not in BOUNDARY_UNITS:
        raise ValueError(f'"unit" must be one of {list(BOUNDARY_UNITS)}; got {unit!r}')
    if edge not in ('start', 'end'):
        raise ValueError(f'"edge" must be "start" or "end"; got {edge!r}')

    tz, _ = resolve_zone(zone)
    local = datetime.fromtimestamp(float(epoch), tz)
    day = local.replace(hour=0, minute=0, second=0, microsecond=0)

    if unit == 'day':
        first = day
    elif unit == 'week':
        first = day - timedelta(days=day.weekday())
    elif unit == 'month':
        first = day.replace(day=1)
    elif unit == 'quarter':
        first = day.replace(month=((day.month - 1) // 3) * 3 + 1, day=1)
    else:
        first = day.replace(month=1, day=1)

    if edge == 'start':
        moment = first
    else:

        def _months_on(value, count):
            year, month, day = _clamped(value.year, value.month + count, 1)
            return value.replace(year=year, month=month, day=day)

        step = {
            'day': lambda d: d + timedelta(days=1),
            'week': lambda d: d + timedelta(days=7),
            'month': lambda d: _months_on(d, 1),
            'quarter': lambda d: _months_on(d, 3),
            'year': lambda d: d.replace(year=d.year + 1),
        }[unit]
        moment = step(first) - timedelta(seconds=1)

    return render(moment.replace(tzinfo=None).replace(tzinfo=tz).timestamp(), zone)


def difference(start: float, end: float, unit: str, zone: Optional[str] = None) -> dict[str, Any]:
    """
    How far apart two instants are.

    BOTH ANSWERS, because the question is ambiguous and picking one silently is
    how "how many days until Friday" comes back as 0 at 23:00 on Thursday.
    `elapsed` is the real duration in the requested unit; `calendar_days` is how
    many dates you cross on a wall calendar in the given zone, which is what a
    person counting days means.

    Args:
        start: Unix seconds.
        end: Unix seconds.
        unit: One of second, minute, hour, day, week.
        zone: The calendar `calendar_days` is counted on.

    Returns:
        `elapsed`, `calendar_days`, and the zone used.

    Raises:
        ValueError: On an unknown unit.
    """
    per = {'second': 1, 'minute': 60, 'hour': 3600, 'day': 86400, 'week': 604800}
    if unit not in per:
        raise ValueError(f'"unit" must be one of {list(per)}; got {unit!r}')

    tz, name = resolve_zone(zone)
    seconds = float(end) - float(start)
    first = datetime.fromtimestamp(float(start), tz).date()
    second = datetime.fromtimestamp(float(end), tz).date()

    return {
        'elapsed': seconds / per[unit],
        'unit': unit,
        'calendar_days': (second - first).days,
        'timezone': name,
    }


def at(date: str, time: str, zone: Optional[str] = None) -> dict[str, Any]:
    """
    The instant a wall-clock date and time name in one zone.

    THE INVERSE OF `render`, AND THE GAP THAT MADE THIS NODE HALF A TOOL.

    Every other function here moves an instant it was already given. None of
    them could accept one: there was no way to say "next Wednesday at 12:30 in
    America/Los_Angeles". The nearest route was `boundary(day, start, zone)`
    then `shift(+750, 'minute')`, which is two calls, documented nowhere, and
    asks the caller to turn 12:30 into 750 — arithmetic in exactly the place
    this node exists to remove it from.

    A wall time is not always an instant, and both ways it fails are real:

    - **It may name no instant.** On the morning the clocks go forward, 02:30
      does not happen. Resolved forward to a real instant, with `adjusted` set
      so the caller can see the hour it actually got rather than discovering it
      from a booking.
    - **It may name two.** On the morning they go back, 01:30 happens twice.
      The earlier one is taken, deterministically, with `ambiguous` set.

    Neither raises. A meeting that has to be booked is better booked at a stated
    wrong-by-an-hour time than not booked at all, and both flags travel with the
    answer so the reason is never invisible.

    Args:
        date: Calendar date, ``YYYY-MM-DD``.
        time: Wall-clock time, ``HH:MM`` or ``HH:MM:SS``.
        zone: IANA name the wall time is read in, or None for UTC.

    Returns:
        The instant, rendered — plus ``requested`` (the wall time asked for),
        ``adjusted`` and ``ambiguous``.

    Raises:
        ValueError: If the date or time is not in the documented shape. A
            misparsed date is not recoverable into an honest answer the way a
            bad zone is, so this one refuses rather than guessing.
    """
    text = f'{str(date).strip()} {str(time).strip()}'
    for shape in ('%Y-%m-%d %H:%M', '%Y-%m-%d %H:%M:%S'):
        try:
            naive = datetime.strptime(text, shape)
            break
        except ValueError:
            continue
    else:
        raise ValueError(f'Expected date as YYYY-MM-DD and time as HH:MM, got "{text}"')

    tz, _ = resolve_zone(zone)
    earlier = naive.replace(tzinfo=tz)
    later = naive.replace(tzinfo=tz, fold=1)

    answer = render(earlier.timestamp(), zone)
    # A gap does not round-trip: ask for 02:30 and the instant reads back 03:30.
    # A fold does round-trip, and is told apart by the two offsets disagreeing.
    answer['requested'] = f'{naive.strftime("%Y-%m-%d")} {naive.strftime("%H:%M")}'
    answer['adjusted'] = answer['time'] != naive.strftime('%H:%M')
    answer['ambiguous'] = not answer['adjusted'] and earlier.utcoffset() != later.utcoffset()
    return answer


def now(zone: Optional[str] = None, at: Optional[float] = None) -> dict[str, Any]:
    """
    The current instant.

    Args:
        zone: IANA name, or None for UTC.
        at: Override the clock. For tests only — nothing else should pass it,
            and a tool that reads its own clock is the point of the node.

    Returns:
        The instant, rendered.
    """
    epoch = datetime.now(timezone.utc).timestamp() if at is None else at
    return render(epoch, zone)
