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

"""The server's half of ``self.state`` (plan 5.7): physical keys, values, expiry, leases, the bound."""

import pytest

from ai.account import state_store
from ai.account.state_store import MemoryStateStore, StateError, encode_value, install_state_store, state_key
from ai.constants import CONST_STATE_MAX_KEY_LENGTH, CONST_STATE_MAX_VALUE_BYTES

# ==== Keys and values ============================================================


def test_the_physical_key_is_owner_prefixed_and_escaped():
    assert (
        state_key('org-1', 'user-1', 'acme.mon.webhook', 'series:cpu') == 'org-1/user-1/acme.mon.webhook/series%3Acpu'
    )


def test_a_slash_in_any_segment_never_forges_another_owners_prefix():
    forged = state_key('org-1', 'user-1', 'acme.mon.webhook', '../../org-2/user-2/acme.mon.webhook/k')
    assert forged.count('/') == 3
    assert forged.startswith('org-1/user-1/acme.mon.webhook/')
    assert state_key('org-1', 'a/b', 'x', 'k') != state_key('org-1', 'a', 'b/x', 'k')


@pytest.mark.parametrize('key', ['', None, 7, 'k' * (CONST_STATE_MAX_KEY_LENGTH + 1)])
def test_a_bad_key_is_refused(key):
    with pytest.raises(StateError):
        state_key('o', 'u', 'a', key)


def test_values_are_json_and_capped():
    assert encode_value({'window': [1.5, 2]}) == '{"window":[1.5,2]}'
    with pytest.raises(StateError, match='JSON'):
        encode_value({1, 2})
    with pytest.raises(StateError, match='JSON'):
        encode_value(float('nan'))
    with pytest.raises(StateError, match='at most'):
        encode_value('x' * CONST_STATE_MAX_VALUE_BYTES)


# ==== The in-process backend =====================================================


@pytest.fixture
def store():
    return MemoryStateStore(max_entries=4)


@pytest.fixture
def clock(monkeypatch):
    """A monotonic clock the test moves."""
    now = [1000.0]
    monkeypatch.setattr(state_store.time, 'monotonic', lambda: now[0])
    return now


async def test_put_get_delete(store):
    assert await store.get('k') is None
    await store.put('k', '{"a":1}', None)
    assert await store.get('k') == '{"a":1}'
    assert await store.delete('k') is True
    assert await store.delete('k') is False
    assert await store.get('k') is None


async def test_a_value_expires_with_its_ttl(store, clock):
    await store.put('k', '1', 30)
    clock[0] += 29
    assert await store.get('k') == '1'
    clock[0] += 2
    assert await store.get('k') is None
    assert await store.delete('k') is False


async def test_incr_counts_from_zero_and_refuses_a_non_integer(store, clock):
    assert await store.incr('n', 1, None) == 1
    assert await store.incr('n', 5, None) == 6
    assert await store.incr('n', -2, 10) == 4
    clock[0] += 11
    assert await store.incr('n', 1, None) == 1
    await store.put('s', '"text"', None)
    with pytest.raises(StateError, match='not an integer'):
        await store.incr('s', 1, None)


async def test_a_lock_is_a_lease_one_token_holds(store, clock):
    assert await store.try_lock('k', 'a', 10) is True
    assert await store.try_lock('k', 'b', 10) is False
    # The holder may renew; another token may not release it
    assert await store.try_lock('k', 'a', 10) is True
    assert await store.unlock('k', 'b') is False
    assert await store.unlock('k', 'a') is True
    assert await store.try_lock('k', 'b', 10) is True
    # A holder that died loses the key when its lease runs out
    clock[0] += 11
    assert await store.try_lock('k', 'c', 10) is True


async def test_a_write_under_a_lapsed_lease_is_refused(store, clock):
    # A reads under its lease, then stalls past it; B takes the key and writes
    assert await store.try_lock('k', 'a', 10) is True
    await store.put('k', '0', None, token='a')
    clock[0] += 11
    assert await store.try_lock('k', 'b', 10) is True
    await store.put('k', '1', None, token='b')
    # A's stale write, delete and increment never land
    with pytest.raises(StateError, match='lock on this key was lost'):
        await store.put('k', '1', None, token='a')
    with pytest.raises(StateError, match='lock on this key was lost'):
        await store.delete('k', token='a')
    with pytest.raises(StateError, match='lock on this key was lost'):
        await store.incr('k', 1, None, token='a')
    assert await store.get('k') == '1'
    # A lapsed lease nobody took is lost too; a write naming no lock is not fenced
    assert await store.unlock('k', 'b') is True
    with pytest.raises(StateError, match='lock on this key was lost'):
        await store.put('k', '2', None, token='b')
    await store.put('k', '3', None)
    assert await store.get('k') == '3'


async def test_abandoned_locks_are_reclaimed_and_live_ones_never_evicted(store, clock):
    for index in range(4):
        assert await store.try_lock(f'k{index}', 'a', 5 if index == 0 else 60) is True
    with pytest.raises(StateError, match='maximum of 4 locks'):
        await store.try_lock('k4', 'a', 60)
    # The holder of k0 never unlocked; its lapsed lease makes room
    clock[0] += 6
    assert await store.try_lock('k4', 'a', 60) is True
    # Full again with live leases only: a new key is refused, no live lease is evicted
    with pytest.raises(StateError, match='maximum of 4 locks'):
        await store.try_lock('k0', 'b', 60)
    assert await store.try_lock('k1', 'b', 60) is False


async def test_the_store_is_bounded_and_refuses_rather_than_evicting_a_live_value(store, clock):
    for index in range(4):
        await store.put(f'k{index}', '1', 5 if index == 0 else None)
    with pytest.raises(StateError, match='maximum'):
        await store.put('k4', '1', None)
    # Replacing a key needs no room; an expired value makes room
    await store.put('k1', '2', None)
    clock[0] += 6
    await store.put('k4', '1', None)
    assert await store.get('k4') == '1'


# ==== The process store ==========================================================


def test_the_server_store_is_the_installed_backend_else_the_in_process_one():
    installed = MemoryStateStore()
    install_state_store(installed)
    try:
        assert state_store.state_store() is installed
    finally:
        install_state_store(None)
    assert isinstance(state_store.state_store(), MemoryStateStore)
    assert state_store.state_store() is not installed
