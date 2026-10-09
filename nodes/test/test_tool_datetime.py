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


@pytest.fixture(autouse=True)
def _fresh_tzdb_probe():
    """
    No test inherits another's database probe.

    `_tzdb_missing` is cached for the life of the process — that is the point of
    it — so a test that patches `available_timezones` would otherwise read
    whatever the previous test settled.
    """
    dtm._tzdb_missing.cache_clear()
    yield
    dtm._tzdb_missing.cache_clear()


def _raising_zoneinfo(name):
    """`ZoneInfo` with no database behind it: every name is a lookup failure."""
    raise KeyError(f'No time zone found with key {name}')


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
    answer = dtm.boundary(at(2026, 9, 3), 'month', 'start')
    assert answer['time'] == '00:00'
    assert answer['adjusted'] is False


#: Santiago moves its clocks at 24:00, so on this date 00:00 is a wall-clock
#: reading that names no instant and the day begins at 01:00. Zones that do this
#: — Chile, Cuba, Lebanon, historically Brazil — are the reason a start is
#: defined as the first EXISTING instant rather than as midnight.
SANTIAGO = 'America/Santiago'


def test_a_day_that_starts_at_one_says_it_was_adjusted():
    """
    The assertion above holds only in zones that change their clocks at a
    civilised hour. Where midnight itself is skipped, the date is still right
    and the time is not midnight, and the answer has to say so: an `epoch` taken
    from this boundary is an hour out for anyone scheduling on it.
    """
    answer = dtm.boundary(at(2026, 9, 6, 12, 0, SANTIAGO), 'day', 'start', SANTIAGO)

    assert answer['date'] == '2026-09-06'
    assert answer['time'] == '01:00'
    assert answer['adjusted'] is True


def test_an_ordinary_boundary_is_not_adjusted():
    """The flag is about a missing hour, not about crossing a DST date at all."""
    # 2026-03-08 is the LA spring-forward date, and its midnight exists.
    answer = dtm.boundary(at(2026, 3, 8, 12, 0, LA), 'day', 'start', LA)

    assert answer['time'] == '00:00'
    assert answer['adjusted'] is False


def test_a_calendar_step_onto_a_missing_hour_says_it_moved():
    """
    02:30 on the 7th, plus a day, is 02:30 on the 8th — an hour LA does not
    have. `at()` already reports this for a wall time it was handed; a shift
    that lands on one reports it the same way rather than absorbing it.
    """
    answer = dtm.shift(at(2026, 3, 7, 2, 30, LA), 1, 'day', LA)

    assert answer['date'] == '2026-03-08'
    assert answer['time'] == '03:30'
    assert answer['adjusted'] is True


def test_a_duration_step_is_never_adjusted():
    """A duration moves the instant, so there is no wall time to be missing."""
    answer = dtm.shift(at(2026, 3, 7, 2, 30, LA), 60, 'minute', LA)

    assert answer['time'] == '03:30'
    assert answer['adjusted'] is False


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


def test_a_missing_timezone_database_is_named_rather_than_silently_utc(monkeypatch, caplog):
    """
    THE FALLBACK THAT WOULD RESTORE THE BUG. `zoneinfo` ships no data: it reads
    the system database, or the `tzdata` wheel this node now declares. With
    neither, EVERY name raises and every answer becomes UTC — so a 12:30
    Pacific booking is written as 12:30 UTC, which is the 05:30 failure this
    node exists to remove, back again with nothing on screen.

    A mistyped zone and an absent database raise the same exception, so the two
    are told apart by asking whether any zone at all can be listed.
    """
    monkeypatch.setattr(dtm, 'available_timezones', lambda: set())
    monkeypatch.setattr(dtm, '_tzdb_reported', False)
    monkeypatch.setattr(dtm, 'ZoneInfo', _raising_zoneinfo)

    with caplog.at_level('WARNING'):
        answer = dtm.render(at(2026, 9, 3), LA)

    assert answer['timezone'] == 'UTC'
    assert 'no IANA timezone database' in caplog.text
    assert 'tzdata' in caplog.text


def test_a_mistyped_zone_is_not_blamed_on_the_database(monkeypatch, caplog):
    """The other half: a real database and a bad name warns about nothing."""
    monkeypatch.setattr(dtm, '_tzdb_reported', False)

    with caplog.at_level('WARNING'):
        assert dtm.render(at(2026, 9, 3), 'Mars/Olympus')['timezone'] == 'UTC'

    assert caplog.text == ''


def test_the_database_is_probed_once_however_many_zones_are_mistyped(monkeypatch):
    """
    The probe is cached, because the answer cannot change inside a process.

    It walks the whole database — some 600 zones — and `_tzdb_reported` latches
    only on the branch where the database is MISSING. So with a database
    present, an agent guessing `PST` and then `America/San_Francisco` paid for
    the full listing twice, and every answer being silently UTC gave it no
    reason to stop guessing.
    """
    listings = []
    monkeypatch.setattr(dtm, 'available_timezones', lambda: listings.append(1) or {'UTC'})
    monkeypatch.setattr(dtm, 'ZoneInfo', _raising_zoneinfo)
    monkeypatch.setattr(dtm, '_tzdb_reported', False)

    dtm.render(at(2026, 9, 3), 'Mars/Olympus')
    dtm.render(at(2026, 9, 3), 'America/San_Francisco')

    assert len(listings) == 1


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


def test_a_transition_that_skips_a_whole_day_is_adjusted():
    """
    THE CASE THAT COMPARING ONLY `HH:MM` MISSED.

    Samoa crossed the date line at the end of 2011: 2011-12-30 never happened in
    Pacific/Apia. Midnight on it resolves to midnight on the 31st — same clock
    reading, a different day — so a comparison of the time alone called that
    unadjusted and handed back an instant a day out with nothing to say so.
    """
    booked = dtm.at('2011-12-30', '00:00', 'Pacific/Apia')

    assert booked['date'] == '2011-12-31'
    assert booked['time'] == '00:00'
    assert booked['adjusted'] is True


def test_a_calendar_step_onto_a_skipped_day_is_adjusted():
    """The same hole on the `_anchored` path that `shift` and `boundary` share."""
    day_before = dtm.at('2011-12-29', '00:00', 'Pacific/Apia')['epoch']

    stepped = dtm.shift(day_before, 1, 'day', 'Pacific/Apia')

    assert stepped['date'] == '2011-12-31'
    assert stepped['adjusted'] is True


def test_a_fractional_epoch_describes_one_instant():
    """
    The returned `epoch` and the fields beside it must name the same moment.

    Rendering from the float while returning `int(epoch)` answered 1.9 as
    "epoch 1" next to a time built from 1.9 — a caller storing the number and a
    caller reading the date would disagree about which second it was.
    """
    fractional = dtm.render(1.9, LA)

    assert fractional['epoch'] == 1
    assert fractional == dtm.render(1, LA)


def test_a_negative_fractional_epoch_floors_rather_than_truncating():
    """Truncation moves a pre-1970 instant FORWARD; every other instant floors."""
    assert dtm.render(-0.5, LA)['epoch'] == -1
    assert dtm.render(-0.5, LA) == dtm.render(-1, LA)


def test_seconds_the_caller_sent_survive_into_requested():
    """
    `requested` is what a caller compares our answer against, so it echoes what
    they sent. Dropping the seconds made "09:30:45" read back as "09:30" and
    look like a change we had made.
    """
    assert dtm.at('2026-09-09', '09:30:45', LA)['requested'] == '2026-09-09 09:30:45'
    # A caller who sent no seconds is answered with none.
    assert dtm.at('2026-09-09', '09:30', LA)['requested'] == '2026-09-09 09:30'


def test_the_shape_error_names_both_accepted_times():
    with pytest.raises(ValueError, match='HH:MM:SS'):
        dtm.at('2026-09-09', 'half twelve', LA)


def test_a_large_calendar_offset_is_exact_and_does_not_loop():
    """
    `_clamped` normalises with `divmod`, not a step per year.

    `shift` multiplies a year amount by 12 before the calendar sees it, so the
    loop this replaces ran once per year of a hallucinated offset. The bound in
    `IInstance.shift` refuses the absurd ones at the boundary; this keeps the
    arithmetic itself constant-time, and exact in both directions.
    """
    assert dtm.shift(at(2026, 1, 31), 1200, 'month')['date'] == '2126-01-31'
    # Backwards only as far as the epoch allows: Windows cannot render a
    # pre-1970 instant at all, so 600 months is the honest edge to assert here.
    assert dtm.shift(at(2026, 1, 31), -600, 'month')['date'] == '1976-01-31'
    # The clamp still applies at the far end: February of a non-leap year.
    assert dtm.shift(at(2026, 1, 31), 1201, 'month')['date'] == '2126-02-28'
