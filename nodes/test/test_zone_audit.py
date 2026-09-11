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
Tests for `zone_audit` itself, run once rather than once per node that uses it.

Each CRM node's own suite asserts only its verdict (`audit_time_fields(IInstance,
ALLOWED) == []`). Whether the audit can fail at all, and how exemptions are
scoped, is a property of the helper and lives here.
"""

import pytest

from test.zone_audit import audit_time_fields


def _node(**tools):
    """A stand-in node class: one published tool per keyword, mapping field -> description."""
    attrs = {}
    for tool, fields in tools.items():

        def method(self):
            pass

        method.__tool_meta__ = {
            'input_schema': {'properties': {field: {'description': text} for field, text in fields.items()}}
        }
        attrs[tool] = method
    return type('Node', (), attrs)


def test_the_audit_can_actually_fail():
    """
    The guard on the guard.

    A matcher that silently stopped matching would leave every node's audit
    passing for ever while saying nothing, which is the failure mode of every
    audit written against a live surface.
    """
    node = _node(book={'due_time': 'Due time, HH:MM.'})

    assert audit_time_fields(node) == ['book.due_time']


def test_a_field_that_names_its_zone_passes():
    node = _node(book={'due_time': 'Due time, HH:MM, in UTC.'})

    assert audit_time_fields(node) == []


def test_a_calendar_date_needs_no_zone():
    """A bare YYYY-MM-DD names no instant, so no zone can be wrong about it."""
    node = _node(deal={'expected_close_date': 'Expected close date, YYYY-MM-DD.'})

    assert audit_time_fields(node) == []


def test_an_exemption_covers_exactly_one_tool_parameter():
    """
    Scoped to `tool.parameter`, never a bare name.

    A bare `duration` would also exempt a same-named field on another tool that
    does carry a time of day — silently, since the exemption would still look
    like the decision it was made for.
    """
    node = _node(
        activity_create={'duration': 'Duration, HH:MM.'},
        shift_create={'duration': 'Shift start, HH:MM.'},
    )

    assert audit_time_fields(node, ('activity_create.duration',)) == ['shift_create.duration']


def test_a_bare_field_name_is_not_an_exemption():
    node = _node(activity_create={'duration': 'Duration, HH:MM.'})

    with pytest.raises(ValueError, match='duration'):
        audit_time_fields(node, ('duration',))


def test_an_exemption_that_names_nothing_fails_loudly():
    """A renamed tool or a removed field must not leave an exemption behind that exempts nothing."""
    node = _node(activity_create={'due_time': 'Due time, HH:MM, in UTC.'})

    with pytest.raises(ValueError, match='activity_update.duration'):
        audit_time_fields(node, ('activity_update.duration',))
