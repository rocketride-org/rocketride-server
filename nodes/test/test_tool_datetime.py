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
The arithmetic behind `tool_datetime`.

NO STUBS, AND THAT IS THE POINT OF THE SPLIT. `datetime_math` imports nothing
from the engine — no rocketlib, no ai.common — so it is importable and testable
on a bare interpreter. Every other tool node's tests begin by injecting
MagicMock modules and removing them again; a node whose whole job is arithmetic
should not need that between the assertion and the sum.

What is pinned here is the set of answers a model gets wrong: month lengths,
weekday counting, quarter boundaries, and the hour that appears or vanishes
when a clock changes.
"""

from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

_MODULE = Path(__file__).resolve().parents[1] / 'src' / 'nodes' / 'tool_datetime' / 'datetime_math.py'
_spec = importlib.util.spec_from_file_location('tool_datetime_math', _MODULE)
dtm = importlib.util.module_from_spec(_spec)
sys.modules['tool_datetime_math'] = dtm
_spec.loader.exec_module(dtm)

LA = 'America/Los_Angeles'


def at(year, month, day, hour=12, minute=0, zone=None):
    """A unix timestamp, written the way a person would say the moment."""
    tz = timezone.utc if zone is None else ZoneInfo(zone)
    return datetime(year, month, day, hour, minute, tzinfo=tz).timestamp()


# ---------------------------------------------------------------------------
# Month lengths
# ---------------------------------------------------------------------------


def test_adding_a_month_to_the_31st_lands_on_a_day_that_exists():
    """The 31st of February is the canonical wrong answer."""
    assert dtm.shift(at(2026, 1, 31), 1, 'month')['date'] == '2026-02-28'


def test_subtracting_a_month_clamps_the_same_way():
    assert dtm.shift(at(2026, 3, 31), -1, 'month')['date'] == '2026-02-28'


def test_a_leap_february_keeps_its_29th():
    assert dtm.shift(at(2028, 1, 31), 1, 'month')['date'] == '2028-02-29'


def test_a_year_of_months_returns_to_the_same_date():
    assert dtm.shift(at(2026, 6, 15), 12, 'month')['date'] == '2027-06-15'


def test_months_roll_across_the_year_boundary_in_both_directions():
    assert dtm.shift(at(2026, 11, 15), 3, 'month')['date'] == '2027-02-15'
    assert dtm.shift(at(2026, 2, 15), -3, 'month')['date'] == '2025-11-15'


# ---------------------------------------------------------------------------
# Counting weekdays
# ---------------------------------------------------------------------------


def test_next_tuesday_from_a_thursday():
    # 2026-09-03 is a Thursday — the day this node was written to fix.
    assert dtm.next_weekday(at(2026, 9, 3), 'tuesday')['date'] == '2026-09-08'


def test_next_tuesday_asked_on_a_tuesday_means_the_one_coming():
    """
    THE DECISION THIS FILE EXISTS TO STATE. There is no right answer, only a
    stated one: asked on a Tuesday to book something "next Tuesday", a person
    means the one coming. Booking today would be a surprise nobody asked for.
    """
    tuesday = at(2026, 9, 8)
    assert dtm.next_weekday(tuesday, 'tuesday')['date'] == '2026-09-15'


def test_today_counts_only_when_the_caller_says_so():
    tuesday = at(2026, 9, 8)
    assert dtm.next_weekday(tuesday, 'tuesday', allow_today=True)['date'] == '2026-09-08'


def test_the_time_of_day_survives_the_move():
    """This moves the date. A follow-up at 09:48 stays at 09:48."""
    assert dtm.next_weekday(at(2026, 9, 3, 9, 48), 'monday')['time'] == '09:48'


def test_a_day_that_is_not_a_day_is_refused():
    with pytest.raises(ValueError):
        dtm.next_weekday(at(2026, 9, 3), 'someday')


# ---------------------------------------------------------------------------
# Daylight saving — where naive arithmetic loses an hour silently
# ---------------------------------------------------------------------------


def test_a_calendar_day_across_a_clock_change_keeps_the_wall_time():
    """
    US clocks go forward on 2026-03-08. "Same time tomorrow" from Saturday
    morning is 09:00 on Sunday, even though only 23 hours have passed.
    """
    moved = dtm.shift(at(2026, 3, 7, 9, 0, LA), 1, 'day', LA)
    assert (moved['date'], moved['time']) == ('2026-03-08', '09:00')


def test_twenty_four_hours_across_a_clock_change_is_still_twenty_four_hours():
    """A duration is not a calendar step, and here they disagree by an hour."""
    moved = dtm.shift(at(2026, 3, 7, 9, 0, LA), 24, 'hour', LA)
    assert (moved['date'], moved['time']) == ('2026-03-08', '10:00')


def test_the_two_kinds_of_shift_differ_by_exactly_the_hour_the_clocks_moved():
    start = at(2026, 3, 7, 9, 0, LA)
    calendar_step = dtm.shift(start, 1, 'day', LA)['epoch']
    duration = dtm.shift(start, 24, 'hour', LA)['epoch']
    assert duration - calendar_step == 3600


# ---------------------------------------------------------------------------
# Period boundaries
# ---------------------------------------------------------------------------


def test_end_of_month_is_the_last_day_not_the_first_of_the_next():
    end = dtm.boundary(at(2026, 9, 3), 'month', 'end')
    assert end['date'] == '2026-09-30'
    assert end['time'] == '23:59'


def test_end_of_february_knows_its_own_length():
    assert dtm.boundary(at(2026, 2, 10), 'month', 'end')['date'] == '2026-02-28'
    assert dtm.boundary(at(2028, 2, 10), 'month', 'end')['date'] == '2028-02-29'


def test_quarters_end_where_quarters_end():
    for month, expected in ((2, '2026-03-31'), (5, '2026-06-30'), (9, '2026-09-30'), (11, '2026-12-31')):
        assert dtm.boundary(at(2026, month, 10), 'quarter', 'end')['date'] == expected


def test_a_week_starts_on_monday():
    # 2026-09-03 is a Thursday.
    assert dtm.boundary(at(2026, 9, 3), 'week', 'start')['date'] == '2026-08-31'


def test_start_of_a_period_is_midnight():
    assert dtm.boundary(at(2026, 9, 3), 'month', 'start')['time'] == '00:00'


# ---------------------------------------------------------------------------
# Distance
# ---------------------------------------------------------------------------


def test_ninety_days_is_ninety_days_across_month_boundaries():
    start = at(2026, 9, 3)
    end = dtm.shift(start, 90, 'day')['epoch']
    assert dtm.render(end)['date'] == '2026-12-02'
    assert dtm.difference(start, end, 'day')['calendar_days'] == 90


def test_late_at_night_tomorrow_is_one_day_away_and_an_hour_away():
    """
    THE AMBIGUITY, PINNED. At 23:00 on Thursday, midnight is 60 minutes off and
    also the next date. Answering only one of those is how "how many days until"
    comes back as zero.
    """
    late = at(2026, 9, 3, 23, 0)
    midnight = at(2026, 9, 4, 0, 0)

    answer = dtm.difference(late, midnight, 'hour')

    assert answer['elapsed'] == 1.0
    assert answer['calendar_days'] == 1


def test_going_backwards_is_negative_rather_than_an_error():
    later = at(2026, 9, 10)
    assert dtm.difference(later, at(2026, 9, 3), 'day')['calendar_days'] == -7


# ---------------------------------------------------------------------------
# Zones
# ---------------------------------------------------------------------------


def test_a_zone_decides_what_date_an_instant_falls_on():
    """
    The whole reason the argument exists. 02:00 UTC on the 4th is still the
    evening of the 3rd in California, and a follow-up booked "today" differs.
    """
    instant = at(2026, 9, 4, 2, 0)
    assert dtm.render(instant)['date'] == '2026-09-04'
    assert dtm.render(instant, LA)['date'] == '2026-09-03'


def test_an_unusable_zone_answers_in_utc_and_says_so():
    """
    Never an exception. A mistyped zone should cost a UTC answer the caller can
    see and correct, not a failed turn — the same rule `clock.normalize_zone`
    already follows.
    """
    for bad in ('Mars/Olympus', 'not a zone', '', None):
        assert dtm.render(at(2026, 9, 3), bad)['timezone'] == 'UTC'


def test_every_answer_names_the_zone_it_used():
    assert dtm.render(at(2026, 9, 3), LA)['timezone'] == LA
    assert dtm.shift(at(2026, 9, 3), 1, 'day', LA)['timezone'] == LA
    assert dtm.boundary(at(2026, 9, 3), 'month', 'end', LA)['timezone'] == LA
    assert dtm.difference(at(2026, 9, 3), at(2026, 9, 4), 'day', LA)['timezone'] == LA


# ---------------------------------------------------------------------------
# The shape a CRM is handed
# ---------------------------------------------------------------------------


def test_the_rendered_fields_are_the_formats_the_crms_document():
    """
    Pipedrive documents `due_date` as YYYY-MM-DD and `due_time` as HH:MM, and
    validates neither — so a wrong shape is stored, not rejected. These fields
    exist so nothing has to format an instant by hand.
    """
    rendered = dtm.render(at(2026, 9, 3, 9, 48))

    assert rendered['date'] == '2026-09-03'
    assert rendered['time'] == '09:48'
    assert rendered['weekday'] == 'Thursday'
    assert rendered['epoch'] == int(at(2026, 9, 3, 9, 48))


def test_an_unknown_unit_is_refused_rather_than_guessed():
    with pytest.raises(ValueError):
        dtm.shift(at(2026, 9, 3), 1, 'fortnight')
    with pytest.raises(ValueError):
        dtm.boundary(at(2026, 9, 3), 'decade', 'end')
    with pytest.raises(ValueError):
        dtm.boundary(at(2026, 9, 3), 'month', 'middle')


# ---------------------------------------------------------------------------
# The zone a CRM field is read in
# ---------------------------------------------------------------------------
# A booking asked for at 12:30 Pacific was written to Pipedrive as "12:30",
# which that API reads as UTC, and shown back to the person who asked for it as
# 05:30. The hour was never touched by any tool here — it came from the words
# and went straight through — so nothing above could have caught it. What was
# missing was a way to say "12:30 in this zone" and get the UTC form back.


def test_every_answer_carries_the_same_instant_in_utc():
    """
    Both renderings, on every answer.

    An instant has a different date and time in every zone, and which one a CRM
    field wants is a fact about the field. Carrying both is what makes writing
    the right one a matter of reading a different key.
    """
    for answer in (
        dtm.now(LA),
        dtm.render(at(2026, 9, 9, 12, 30, LA), LA),
        dtm.shift(at(2026, 9, 9, 12, 30, LA), 1, 'day', LA),
        dtm.next_weekday(at(2026, 9, 3), 'wednesday', zone=LA),
        dtm.boundary(at(2026, 9, 9), 'month', 'end', LA),
        dtm.at('2026-09-09', '12:30', LA),
    ):
        assert answer['utc_date'] and answer['utc_time'] and answer['utc_iso']
        assert dtm.render(answer['epoch'])['time'] == answer['utc_time']


def test_the_failing_booking():
    """
    THE TURN THIS EXISTS FOR. "meet with anna next wednesday at 12:30pm",
    asked from California. Pipedrive reads `due_time` as UTC, so 19:30 is the
    value that displays as 12:30 to the person who asked.
    """
    booked = dtm.at('2026-09-09', '12:30', LA)

    assert (booked['date'], booked['time']) == ('2026-09-09', '12:30')
    assert (booked['utc_date'], booked['utc_time']) == ('2026-09-09', '19:30')


def test_late_evening_is_a_different_date_in_utc():
    """The defect moves days, not only hours: 8pm Wednesday is Thursday in UTC."""
    booked = dtm.at('2026-09-09', '20:00', LA)

    assert (booked['date'], booked['weekday']) == ('2026-09-09', 'Wednesday')
    assert (booked['utc_date'], booked['utc_time']) == ('2026-09-10', '03:00')


def test_an_hour_that_does_not_exist_is_resolved_and_flagged():
    """
    US clocks go forward on 2026-03-08, so 02:30 never happens that morning.

    Booked at the next real instant rather than refused — a meeting that has to
    be booked is better booked an hour out than not at all — and `adjusted`
    says so, so the hour is visible instead of surfacing from the calendar.
    """
    booked = dtm.at('2026-03-08', '02:30', LA)

    assert booked['time'] == '03:30'
    assert booked['requested'] == '2026-03-08 02:30'
    assert booked['adjusted'] is True
    assert booked['ambiguous'] is False


def test_an_hour_that_happens_twice_takes_the_first_and_says_so():
    """Clocks go back on 2026-11-01: 01:30 comes round at -07:00 and again at -08:00."""
    booked = dtm.at('2026-11-01', '01:30', LA)

    assert booked['time'] == '01:30'
    assert booked['utc_time'] == '08:30', 'the earlier of the two, deterministically'
    assert booked['ambiguous'] is True
    assert booked['adjusted'] is False


def test_an_ordinary_time_is_neither_adjusted_nor_ambiguous():
    booked = dtm.at('2026-09-09', '12:30', LA)

    assert booked['adjusted'] is False
    assert booked['ambiguous'] is False


def test_at_round_trips_through_render():
    """What `at` composes, `render` takes apart again."""
    booked = dtm.at('2026-09-09', '12:30', LA)
    back = dtm.render(booked['epoch'], LA)

    assert (back['date'], back['time']) == ('2026-09-09', '12:30')


def test_at_accepts_seconds_and_drops_them_from_the_crm_fields():
    assert dtm.at('2026-09-09', '12:30:45', LA)['utc_time'] == '19:30'


def test_at_with_no_zone_reads_the_wall_time_as_utc():
    """Consistent with every other function here, and the answer names the zone."""
    booked = dtm.at('2026-09-09', '12:30')

    assert booked['timezone'] == 'UTC'
    assert booked['utc_time'] == '12:30'


def test_a_date_that_is_not_a_date_is_refused():
    """
    Unlike a bad zone, which answers in UTC and says so. A misparsed date has no
    honest answer to fall back to — every instant it could mean is a guess.
    """
    for date, time in (('9 sept 2026', '12:30'), ('2026-09-09', 'half twelve'), ('', ''), ('2026-13-40', '12:30')):
        with pytest.raises(ValueError):
            dtm.at(date, time, LA)
