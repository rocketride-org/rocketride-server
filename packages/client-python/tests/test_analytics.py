# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Tests for the RocketRide event taxonomy (:mod:`rocketride.analytics.events`).

The taxonomy is names and shapes only, so these tests guard the two things that
can actually regress: a duplicate event name silently shadowing another, and an
``EVENTS`` member that never made it into the ``EventName`` union.
"""

import re

from rocketride.analytics import EVENTS, EventName

_EVENT_NAME_RE = re.compile(r'^[a-z0-9_]+:[a-z0-9_]+$')


def _event_values() -> list[str]:
    return [v for k, v in vars(EVENTS).items() if not k.startswith('_')]


def test_event_names_are_unique():
    values = _event_values()
    assert len(values) == len(set(values)), 'duplicate event name in EVENTS'


def test_every_events_member_is_in_the_event_name_union():
    # Catches adding a constant to EVENTS without widening EventName.
    assert set(_event_values()) <= set(EventName.__args__)


def test_every_event_name_union_member_has_an_events_constant():
    # Catches the reverse: widening EventName without a named constant.
    assert set(EventName.__args__) <= set(_event_values())


def test_event_names_follow_the_object_action_convention():
    offenders = [v for v in _event_values() if v != '$pageview' and not _EVENT_NAME_RE.match(v)]
    assert offenders == [], f'event names must be object:action — got {offenders}'
