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
Every tool parameter that carries a time of day must name its timezone.

WHAT THIS EXISTS TO CATCH. Pipedrive's `activity_create` documented `due_time`
as ``'Due time, HH:MM.'`` and nothing more. The API stores that value as UTC and
shows it back in each viewer's own zone, so a meeting asked for at 12:30 in
California was written as "12:30", stored, and displayed to the person who asked
for it as 05:30. Nothing rejected it — a wrong hour looks exactly like a right
one — and the only reason anybody found out was that they looked at the calendar.

A model cannot infer a field's zone. It reads the description, and if the
description does not say, it writes what the person said. So the rule is that
the description says.

WHY IT IS A SHARED HELPER. The same rule has to hold for every CRM this app
speaks to, and the CRMs do not agree on the answer: Pipedrive wants a naked UTC
``HH:MM``, GoHighLevel wants ISO-8601 carrying a numeric offset. There is no
CRM-neutral value — only a CRM-neutral obligation to state one. `tool_gohighlevel`
was already keeping it (`appointments._APPOINTMENT_TIMEZONE_DESC`) when Pipedrive
was not, which is what made this worth pinning rather than remembering.

Keyed on the DESCRIPTION rather than the field name, deliberately. Pipedrive's
`add_time` names no time in its key but carries one; `expected_close_date` looks
like a date field and correctly needs no zone. Only the text says which is which.

Pure stdlib and no engine imports, so it is safe to import from test modules that
install their own stub modules before importing the node under test.
"""

from __future__ import annotations

from typing import Any, Iterable

#: A description mentioning one of these is describing a time of day, not a date.
#:
#: `HH:MM` covers the split date/time pairs and `HH:MM:SS` timestamps; the ISO
#: and RFC names cover the single-string forms. A bare ``YYYY-MM-DD`` is absent
#: on purpose — a calendar date names no instant, so no zone can be wrong about
#: it, and demanding one would be noise on every close date in the API.
CARRIES_A_TIME = ('HH:MM', 'ISO 8601', 'ISO-8601', 'RFC3339', 'RFC 3339')

#: Any one of these, anywhere in the description, settles the question.
#:
#: Deliberately generous: this test is here to catch a field that says NOTHING,
#: which is the failure that actually happened. Judging whether what it says is
#: correct is a person's job, and a stricter matcher would only teach people to
#: append the word "UTC" to get past it.
NAMES_A_ZONE = ('UTC', 'timezone', 'time zone', 'IANA', 'offset', 'Z"', 'local time')


def audit_time_fields(instance_class: Any, allowed: Iterable[str] = ()) -> list[str]:
    """
    Published parameters that carry a time of day and never say in which zone.

    Args:
        instance_class: The node's ``IInstance`` class. Every attribute carrying
            a ``__tool_meta__`` is treated as a published tool.
        allowed: Parameter names exempt by deliberate decision — a duration is
            a length rather than an instant, and converting one corrupts it.
            Kept as an explicit list so an exemption is a choice somebody made
            and can be read back, rather than a hole in the matcher.

    Returns:
        ``tool.parameter`` for each offender, sorted. Empty is the passing case.
    """
    exempt = set(allowed)
    offenders = []

    for name in dir(instance_class):
        tool = getattr(instance_class, name, None)
        meta = getattr(tool, '__tool_meta__', None)
        if not isinstance(meta, dict):
            continue

        schema = meta.get('input_schema')
        properties = schema.get('properties') if isinstance(schema, dict) else None
        if not isinstance(properties, dict):
            continue

        for field, spec in properties.items():
            if field in exempt or not isinstance(spec, dict):
                continue
            description = str(spec.get('description') or '')
            if not any(token in description for token in CARRIES_A_TIME):
                continue
            if any(token in description for token in NAMES_A_ZONE):
                continue
            offenders.append(f'{name}.{field}')

    return sorted(offenders)
