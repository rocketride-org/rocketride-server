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

"""Monitor key scope tests — no server required.

The scope IS the kind: a monitor key with ``team_id`` addresses the team's
DEPLOYED run; without it, the caller's own dev run. These tests pin the
wire arguments and, critically, the key-string ENCODE/DECODE round-trip:
reconnect replays subscriptions through that pair, so an encoder-only
change would silently drop the team scope after a reconnect.
"""

import pytest

from rocketride.mixins.events import EventMixin


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _ClientShell(EventMixin):
    """Detached client shell: mixin methods available, no socket.

    Captures rrext_monitor wire calls instead of sending them.
    """

    def __init__(self):
        # Deliberately skip DAPClient.__init__ — these tests exercise only
        # the monitor bookkeeping, never the transport.
        self._monitor_keys = {}
        self.calls = []

    def is_connected(self) -> bool:
        """Always 'connected' so _sync_monitor reaches the capture below."""
        return True

    async def call(self, command, **kwargs):
        """Record the wire call instead of sending it."""
        self.calls.append(kwargs)


def _round_trip(key):
    """Round-trip a key through the private encode/decode pair."""
    return EventMixin._monitor_string_to_key(EventMixin._monitor_key_to_string(key))


# ---------------------------------------------------------------------------
# Key string round-trip — the reconnect path depends on this symmetry
# ---------------------------------------------------------------------------


def test_round_trips_dev_key():
    """A dev key (no team_id) survives encode/decode unchanged."""
    key = {'project_id': 'proj-1', 'source': 'src-1'}
    assert _round_trip(key) == key


def test_round_trips_team_scoped_key():
    """A team-scoped key keeps its team_id through the round-trip."""
    key = {'project_id': 'proj-1', 'source': 'src-1', 'team_id': 'team-1'}
    assert _round_trip(key) == key


def test_round_trips_team_scoped_pipe_key():
    """team_id and pipe_id coexist through the round-trip."""
    key = {'project_id': 'proj-1', 'source': 'src-1', 'pipe_id': 42, 'team_id': 'team-1'}
    assert _round_trip(key) == key


def test_round_trips_token_key():
    """Token keys are untouched by the scope suffix."""
    assert _round_trip({'token': 'tk_abc'}) == {'token': 'tk_abc'}


def test_dev_and_team_keys_are_distinct_entries():
    """The same project/source in dev vs team scope must not share a map slot."""
    dev = EventMixin._monitor_key_to_string({'project_id': 'proj-1', 'source': 'src-1'})
    team = EventMixin._monitor_key_to_string({'project_id': 'proj-1', 'source': 'src-1', 'team_id': 'team-1'})
    assert dev != team


# ---------------------------------------------------------------------------
# Wire arguments
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_team_id_rides_the_wire_only_when_present():
    """The teamId argument is sent for team-scoped keys and omitted for dev keys."""
    shell = _ClientShell()
    await shell.add_monitor({'project_id': 'proj-1', 'source': 'src-1', 'team_id': 'team-1'}, ['all'])
    await shell.add_monitor({'project_id': 'proj-1', 'source': 'src-1'}, ['all'])
    assert shell.calls[0]['teamId'] == 'team-1'
    assert 'teamId' not in shell.calls[1]


@pytest.mark.asyncio
async def test_reconnect_resubscribe_keeps_team_scope():
    """The reconnect replay must re-register with the team scope intact."""
    shell = _ClientShell()
    await shell.add_monitor({'project_id': 'proj-1', 'source': 'src-1', 'team_id': 'team-1'}, ['summary'])
    shell.calls.clear()
    await shell._resubscribe_all_monitors()
    assert len(shell.calls) == 1
    assert shell.calls[0]['teamId'] == 'team-1'


@pytest.mark.asyncio
async def test_remove_monitor_releases_the_scoped_subscription():
    """remove_monitor with the matching scoped key sends the empty unsubscribe."""
    shell = _ClientShell()
    key = {'project_id': 'proj-1', 'source': 'src-1', 'team_id': 'team-1'}
    await shell.add_monitor(key, ['all'])
    await shell.remove_monitor(key, ['all'])
    # Second call is the empty-types unsubscribe for the SAME scoped key.
    assert len(shell.calls) == 2
    assert shell.calls[1]['teamId'] == 'team-1'
    assert shell.calls[1]['types'] == []
