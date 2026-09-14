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

"""``_version_dirs_for``'s verdict cache: hard expiry + the miss-refresh.

The servable map (registry version -> dist dir) is cached per (token, app
id) with a HARD expiry. A warm map that LACKS the version the caller is
about to fetch is re-resolved on the spot — a fleet bump (reseed/publish
repoint) must serve the moment clients ask for the new version, not after
the window drains — bounded by an ESCALATING refractory floor: a fruitless
forced walk doubles the key's floor (capped at the TTL), a walk that
satisfies the caller resets it to the base. So every real publish converges
on the first ask while a nonexistent-version prober decays to one DB walk
per minutes. These tests pin all of it against a fake resolver and a fake
clock: the resolver call count IS the contract.
"""

from __future__ import annotations

import asyncio

import ai.account.app_deploy as app_deploy_mod
import ai.modules.shell.shell as shell_mod


# =============================================================================
# HELPERS
# =============================================================================


class _Clock:
    """Deterministic stand-in for the module's ``time`` import."""

    def __init__(self) -> None:
        self.now = 1_000_000.0

    def time(self) -> float:
        return self.now


def _setup(monkeypatch, maps):
    """Wire _version_dirs_for to canned resolver results on a fake clock.

    Patches the module onto the OSS resolution leg (``open_version_dirs``)
    so no account/auth machinery runs — the unit under test is the cache
    policy, which is edition-neutral.

    Args:
        monkeypatch: pytest fixture.
        maps:        Successive maps the resolver returns; the last one
                     repeats once the list is exhausted.

    Returns:
        (clock, calls): the controllable clock and the resolver call log.
    """
    clock = _Clock()
    calls: list = []

    async def fake_open_version_dirs(app_id: str) -> dict:
        """Log the walk and hand out the next canned map."""
        calls.append(app_id)
        return maps[min(len(calls) - 1, len(maps) - 1)]

    monkeypatch.setattr(shell_mod, 'time', clock)
    monkeypatch.setattr(shell_mod, '_version_dir_cache', {})
    monkeypatch.setattr(shell_mod, '_is_saas', lambda: False)
    monkeypatch.setattr(app_deploy_mod, 'open_version_dirs', fake_open_version_dirs)
    return clock, calls


def _dirs(want=None):
    """One resolution as the serving route performs it."""
    return asyncio.run(shell_mod._version_dirs_for('tok', 'app.x', want=want))


# =============================================================================
# TESTS
# =============================================================================


def test_warm_hit_serves_without_resolving_again(monkeypatch):
    """A wanted version PRESENT in the warm map answers from cache — the
    steady-state fetch never touches the DB, refractory or not.
    """
    clock, calls = _setup(monkeypatch, [{1: 'app.x/v1/dist'}])

    assert _dirs(want=1) == {1: 'app.x/v1/dist'}
    clock.now += shell_mod._VERSION_MISS_REFRACTORY + 1
    assert _dirs(want=1) == {1: 'app.x/v1/dist'}

    assert calls == ['app.x']


def test_missing_wanted_version_forces_one_refresh(monkeypatch):
    """A warm map lacking the requested version re-resolves immediately —
    the fleet-bump convergence path: pins repointed to a fresh version
    serve on the first ask instead of 404ing until the hard expiry.
    """
    clock, calls = _setup(monkeypatch, [{1: 'app.x/v1/dist'}, {1: 'app.x/v1/dist', 2: 'app.x/v2/dist'}])

    assert _dirs(want=1) == {1: 'app.x/v1/dist'}
    # Past the refractory floor but WELL inside the hard expiry.
    clock.now += shell_mod._VERSION_MISS_REFRACTORY + 1
    assert _dirs(want=2)[2] == 'app.x/v2/dist'

    assert calls == ['app.x', 'app.x']


def test_fresh_map_answers_stale_inside_the_refractory_floor(monkeypatch):
    """A map YOUNGER than the floor answers as-is even on a miss — the
    bound that keeps nonexistent-version probing off the DB.
    """
    clock, calls = _setup(monkeypatch, [{1: 'a'}, {1: 'a', 2: 'b'}])

    assert _dirs(want=1) == {1: 'a'}
    clock.now += 1.0  # inside the floor
    assert 2 not in _dirs(want=2)

    assert calls == ['app.x']


def test_fruitless_refresh_doubles_the_floor(monkeypatch):
    """A miss-forced walk that comes back WITHOUT the wanted version doubles
    the key's floor: the base floor no longer re-walks, only the doubled one
    draining does — the prober-decay half of the contract.
    """
    clock, calls = _setup(monkeypatch, [{1: 'a'}, {1: 'a'}, {1: 'a', 2: 'b'}])

    assert _dirs(want=1) == {1: 'a'}
    clock.now += shell_mod._VERSION_MISS_REFRACTORY + 1
    assert 2 not in _dirs(want=2)  # walk #2 — fruitless, floor doubles
    assert 2 not in _dirs(want=2)  # immediate retry: inside the floor, no walk
    clock.now += shell_mod._VERSION_MISS_REFRACTORY + 1
    assert 2 not in _dirs(want=2)  # base floor drained but DOUBLED floor has not
    clock.now += shell_mod._VERSION_MISS_REFRACTORY + 1
    assert _dirs(want=2)[2] == 'b'  # doubled floor drained — walk #3 lands v2

    assert calls == ['app.x', 'app.x', 'app.x']


def test_successful_refresh_resets_the_floor(monkeypatch):
    """A miss-forced walk that FINDS the wanted version resets the floor to
    the base: the next legitimate bump converges after the base floor again
    instead of inheriting the escalated one.
    """
    clock, calls = _setup(monkeypatch, [{1: 'a'}, {1: 'a'}, {1: 'a', 2: 'b'}, {1: 'a', 2: 'b', 3: 'c'}])

    assert _dirs(want=1) == {1: 'a'}
    clock.now += shell_mod._VERSION_MISS_REFRACTORY + 1
    assert 2 not in _dirs(want=2)  # walk #2 — fruitless, floor 2x
    clock.now += 2 * shell_mod._VERSION_MISS_REFRACTORY + 1
    assert _dirs(want=2)[2] == 'b'  # walk #3 — found: floor resets to base
    clock.now += shell_mod._VERSION_MISS_REFRACTORY + 1
    assert _dirs(want=3)[3] == 'c'  # walk #4 — base floor was enough again

    assert calls == ['app.x'] * 4


def test_floor_escalation_caps_at_the_hard_expiry(monkeypatch):
    """Consecutive fruitless walks double the floor up to the TTL and never
    beyond — the decay curve is bounded on both ends.
    """
    clock, calls = _setup(monkeypatch, [{1: 'a'}])

    assert _dirs(want=1) == {1: 'a'}
    floors = []
    # Each round waits out the CURRENT floor, forces a fruitless walk for a
    # version that never lands, and records the escalated floor.
    for _ in range(6):
        entry = next(iter(shell_mod._version_dir_cache.values()))
        clock.now += entry['floor'] + 1
        assert 99 not in _dirs(want=99)
        floors.append(next(iter(shell_mod._version_dir_cache.values()))['floor'])

    expected = [min(shell_mod._VERSION_MISS_REFRACTORY * 2**n, shell_mod._APP_AUTH_TTL) for n in range(1, 7)]
    assert floors == expected
    assert floors[-1] == shell_mod._APP_AUTH_TTL
    assert calls == ['app.x'] * 7


def test_no_want_keeps_the_plain_hard_expiry(monkeypatch):
    """Without a wanted version the cache behaves exactly as before: warm
    answers until the hard expiry, then one fresh walk.
    """
    clock, calls = _setup(monkeypatch, [{1: 'a'}, {2: 'b'}])

    assert _dirs() == {1: 'a'}
    clock.now += shell_mod._VERSION_MISS_REFRACTORY + 1
    assert _dirs() == {1: 'a'}  # still the warm map — no miss-refresh without want
    clock.now += shell_mod._APP_AUTH_TTL
    assert _dirs() == {2: 'b'}

    assert calls == ['app.x', 'app.x']
