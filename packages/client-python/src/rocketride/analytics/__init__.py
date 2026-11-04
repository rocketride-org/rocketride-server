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
rocketride.analytics — bound per-app event reporters (bare bones).

A HOST mints one reporter per app with ``create_reporter(app, sink)`` and hands
it over; the app calls ``report(event, props, options)`` with any string event
and free-form props — event names are NOT constrained to a central list; each
app owns its own taxonomy. Every reported event carries ``app``, closed over at
creation, so a late event from a backgrounded app still names its true emitter —
there is deliberately NO module-global "current app" state to re-point. The
TypeScript mirror lives at ``rocketride/analytics`` in the TypeScript SDK.
Nothing else lives here.
"""

from __future__ import annotations

from typing import Callable, Optional

# Per-call capture options a sink may honor (transport/timestamp/uuid — see the
# TypeScript mirror's SendOptions). Plain dict: Python sinks are server-side
# and simply forward what they understand.
SendOptions = dict

ReportSink = Callable[[str, Optional[dict], Optional[SendOptions]], None]
Reporter = Callable[[str, Optional[dict], Optional[SendOptions]], None]

__all__ = ['ReportSink', 'Reporter', 'SendOptions', 'create_reporter']


def create_reporter(app: str, sink: ReportSink) -> Reporter:
    """Mint the bound reporter for one app.

    The returned function stamps ``app`` last (caller props can never overwrite
    the emitting-app id), ignores non-string or empty event names, and never
    raises — telemetry must never break the app.

    Args:
        app: The emitting app's id, fixed for the reporter's lifetime.
        sink: The transport events go to.

    Returns:
        The app's ``report(event, props=None, options=None)``.
    """

    def report(event: str, props: dict | None = None, options: SendOptions | None = None) -> None:
        if not isinstance(event, str) or not event:
            return  # string-ish enforcement, nothing stricter
        try:
            # Stamp last so caller props can never overwrite the emitting-app id.
            sink(event, {**(props or {}), 'app': app}, options)
        except Exception:  # noqa: BLE001 — telemetry must never break the app
            pass

    return report
