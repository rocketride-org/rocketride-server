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

"""The server's half of ``self.state`` (plan 5.7): physical keys, values, expiry, the per-node limit, leases, the bound."""

import pytest

from ai.account import state_store
from ai.account.state_store import (
    MemoryStateStore,
    StateError,
    check_write,
    encode_value,
    install_state_store,
    state_key,
    state_scope,
)
from ai.constants import (
    CONST_STATE_MAX_KEY_LENGTH,
    CONST_STATE_MAX_KEYS_PER_NODE,
    CONST_STATE_MAX_TTL_SECONDS,
    CONST_STATE_MAX_VALUE_BYTES,
)

# ==== Constants ==================================================================

#: Two nodes of one owner's pipeline.
SCOPE = state_scope('org-1', '=user/user-1', 'acme.mon.webhook', 'node_1')
OTHER = state_scope('org-1', '=user/user-1', 'acme.mon.webhook', 'node_2')

#: The expiry and the per-node limit the writes below name unless a test is about them.
TTL = 60.0
LIMIT = CONST_STATE_MAX_KEYS_PER_NODE


def _k(name, scope=SCOPE):
    """The physical key of a node's key in a scope."""
    return f'{scope}/{name}'


# ==== Keys and values ============================================================


def test_the_physical_key_is_owner_and_node_prefixed_and_escaped():
    assert (
        state_scope('org-1', '=user/user-1', 'acme.mon.webhook', 'anomaly_1')
        == 'org-1/%3Duser%2Fuser-1/acme.mon.webhook/anomaly_1'
    )
    assert (
        state_key('org-1', '=user/user-1', 'acme.mon.webhook', 'anomaly_1', 'series:cpu')
        == 'org-1/%3Duser%2Fuser-1/acme.mon.webhook/anomaly_1/series%3Acpu'
    )


def test_a_key_is_its_scope_then_the_escaped_key():
    parts = ('org 1', '=team/1', 'acme.mon.webhook', 'node:1')
    scope = state_scope(*parts)
    assert scope == 'org%201/%3Dteam%2F1/acme.mon.webhook/node%3A1'
    assert state_key(*parts, 'a/b') == scope + '/a%2Fb'


def test_a_user_a_team_and_an_org_of_one_id_have_three_scopes():
    # A standalone server names its one user, team and org 'local': the
    # owner's kind alone keeps @me, @team and @org apart
    scopes = {
        state_scope('local', f'={kind}/local', 'rocketride.probe.webhook_1', 'probe_1')
        for kind in ('user', 'team', 'org')
    }
    assert len(scopes) == 3


@pytest.mark.parametrize('owner', ['local', 'user-1', '', None, '@me', '@public', '=public', '=user/', 'user/local'])
def test_an_owner_without_its_kind_is_refused(owner):
    with pytest.raises(StateError, match='state owner'):
        state_scope('o', owner, 'a', 'n')
    with pytest.raises(StateError, match='state owner'):
        state_key('o', owner, 'a', 'n', 'k')


def test_two_nodes_naming_one_key_have_two_physical_keys():
    first = state_key('org-1', '=user/user-1', 'acme.mon.webhook', 'anomaly_1', 'series:cpu')
    second = state_key('org-1', '=user/user-1', 'acme.mon.webhook', 'anomaly_2', 'series:cpu')
    assert first != second


def test_a_slash_in_any_segment_never_forges_another_owners_prefix():
    forged = state_key(
        'org-1', '=user/user-1', 'acme.mon.webhook', 'n', '../../org-2/=user/user-2/acme.mon.webhook/n/k'
    )
    assert forged.count('/') == 4
    assert forged.startswith('org-1/%3Duser%2Fuser-1/acme.mon.webhook/n/')
    assert state_key('org-1', '=user/u', 'a/b', 'n', 'k') != state_key('org-1', '=user/u', 'a', 'b/n', 'k')


def test_a_slash_in_the_node_id_never_forges_another_nodes_scope():
    # A node id that spells another node's id and key stays one segment
    forged = state_key('o', '=user/u', 'a', 'node_2/k', 'x')
    assert forged.count('/') == 4
    assert not forged.startswith(state_scope('o', '=user/u', 'a', 'node_2') + '/')
    assert state_key('o', '=user/u', 'a', 'n/k', 'x') != state_key('o', '=user/u', 'a', 'n', 'k/x')


@pytest.mark.parametrize('key', ['', None, 7, 'k' * (CONST_STATE_MAX_KEY_LENGTH + 1)])
def test_a_bad_key_is_refused(key):
    with pytest.raises(StateError):
        state_key('o', '=user/u', 'a', 'n', key)


@pytest.mark.parametrize('node_id', ['', None, 7])
def test_a_bad_node_id_is_refused(node_id):
    with pytest.raises(StateError, match='node id'):
        state_scope('o', '=user/u', 'a', node_id)
    with pytest.raises(StateError, match='node id'):
        state_key('o', '=user/u', 'a', node_id, 'k')


def test_values_are_json_and_capped():
    assert encode_value({'window': [1.5, 2]}) == '{"window":[1.5,2]}'
    with pytest.raises(StateError, match='JSON'):
        encode_value({1, 2})
    with pytest.raises(StateError, match='JSON'):
        encode_value(float('nan'))
    with pytest.raises(StateError, match='at most'):
        encode_value('x' * CONST_STATE_MAX_VALUE_BYTES)


def test_a_write_is_checked_before_any_backend_acts():
    assert check_write(SCOPE, _k('k'), 30, LIMIT) == 30.0
    assert check_write(SCOPE, _k('k'), CONST_STATE_MAX_TTL_SECONDS, 1) == float(CONST_STATE_MAX_TTL_SECONDS)
    # A key of another scope, or of no scope
    with pytest.raises(StateError, match='belongs to the scope'):
        check_write(SCOPE, _k('k', OTHER), TTL, LIMIT)
    with pytest.raises(StateError, match='belongs to the scope'):
        check_write('', '/k', TTL, LIMIT)
    for max_keys in (0, -1, 1.5, True, None):
        with pytest.raises(StateError, match='max_keys'):
            check_write(SCOPE, _k('k'), TTL, max_keys)


# ==== The in-process backend =====================================================


@pytest.fixture
def store():
    return MemoryStateStore(max_entries=4)


@pytest.fixture
def roomy():
    """A store whose global bound is out of the way of the per-node limit."""
    return MemoryStateStore()


@pytest.fixture
def clock(monkeypatch):
    """A monotonic clock the test moves."""
    now = [1000.0]
    monkeypatch.setattr(state_store.time, 'monotonic', lambda: now[0])
    return now


def _consistent(store):
    """True when the per-scope sets hold exactly the stored keys, each under its own scope."""
    listed = {key for keys in store._scopes.values() for key in keys}
    return (
        listed == set(store._values)
        and all(keys for keys in store._scopes.values())
        and all(store._values[key][2] == scope for scope, keys in store._scopes.items() for key in keys)
    )


async def test_put_get_delete(store):
    assert await store.get(_k('k')) is None
    await store.put(SCOPE, _k('k'), '{"a":1}', TTL, LIMIT)
    assert await store.get(_k('k')) == '{"a":1}'
    assert await store.delete(SCOPE, _k('k')) is True
    assert await store.delete(SCOPE, _k('k')) is False
    assert await store.get(_k('k')) is None


async def test_a_value_expires_with_its_ttl(store, clock):
    await store.put(SCOPE, _k('k'), '1', 30, LIMIT)
    clock[0] += 29
    assert await store.get(_k('k')) == '1'
    clock[0] += 2
    assert await store.get(_k('k')) is None
    assert await store.delete(SCOPE, _k('k')) is False


async def test_a_write_restarts_the_expiry(store, clock):
    await store.put(SCOPE, _k('k'), '1', 30, LIMIT)
    clock[0] += 29
    await store.put(SCOPE, _k('k'), '2', 30, LIMIT)
    clock[0] += 29
    assert await store.get(_k('k')) == '2'
    clock[0] += 2
    assert await store.get(_k('k')) is None


@pytest.mark.parametrize(
    'ttl', [None, 0, -1, True, 'soon', float('nan'), float('inf'), CONST_STATE_MAX_TTL_SECONDS + 1]
)
async def test_a_write_without_a_bounded_ttl_is_refused(store, ttl):
    with pytest.raises(StateError, match='ttl is a number of seconds'):
        await store.put(SCOPE, _k('k'), '1', ttl, LIMIT)
    with pytest.raises(StateError, match='ttl is a number of seconds'):
        await store.incr(SCOPE, _k('n'), 1, ttl, LIMIT)
    assert await store.get(_k('k')) is None and await store.get(_k('n')) is None
    assert not store._values and not store._scopes


async def test_the_longest_ttl_is_accepted(store, clock):
    await store.put(SCOPE, _k('k'), '1', CONST_STATE_MAX_TTL_SECONDS, LIMIT)
    clock[0] += CONST_STATE_MAX_TTL_SECONDS - 1
    assert await store.get(_k('k')) == '1'
    clock[0] += 2
    assert await store.get(_k('k')) is None


async def test_incr_counts_from_zero_and_refuses_a_non_integer(store, clock):
    assert await store.incr(SCOPE, _k('n'), 1, TTL, LIMIT) == 1
    assert await store.incr(SCOPE, _k('n'), 5, TTL, LIMIT) == 6
    assert await store.incr(SCOPE, _k('n'), -2, 10, LIMIT) == 4
    clock[0] += 11
    assert await store.incr(SCOPE, _k('n'), 1, TTL, LIMIT) == 1
    await store.put(SCOPE, _k('s'), '"text"', TTL, LIMIT)
    with pytest.raises(StateError, match='not an integer'):
        await store.incr(SCOPE, _k('s'), 1, TTL, LIMIT)


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
    key = _k('k')
    # A reads under its lease, then stalls past it; B takes the key and writes
    assert await store.try_lock(key, 'a', 10) is True
    await store.put(SCOPE, key, '0', TTL, LIMIT, token='a')
    clock[0] += 11
    assert await store.try_lock(key, 'b', 10) is True
    await store.put(SCOPE, key, '1', TTL, LIMIT, token='b')
    # A's stale write, delete and increment never land
    with pytest.raises(StateError, match='lock on this key was lost'):
        await store.put(SCOPE, key, '1', TTL, LIMIT, token='a')
    with pytest.raises(StateError, match='lock on this key was lost'):
        await store.delete(SCOPE, key, token='a')
    with pytest.raises(StateError, match='lock on this key was lost'):
        await store.incr(SCOPE, key, 1, TTL, LIMIT, token='a')
    assert await store.get(key) == '1'
    # A lapsed lease nobody took is lost too; a write naming no lock is not fenced
    assert await store.unlock(key, 'b') is True
    with pytest.raises(StateError, match='lock on this key was lost'):
        await store.put(SCOPE, key, '2', TTL, LIMIT, token='b')
    await store.put(SCOPE, key, '3', TTL, LIMIT)
    assert await store.get(key) == '3'


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
        await store.put(SCOPE, _k(f'k{index}'), '1', 5 if index == 0 else TTL, LIMIT)
    with pytest.raises(StateError, match='maximum of 4 values'):
        await store.put(SCOPE, _k('k4'), '1', TTL, LIMIT)
    # Another node's first key meets the same bound: it is the whole store's
    with pytest.raises(StateError, match='maximum of 4 values'):
        await store.put(OTHER, _k('k', OTHER), '1', TTL, LIMIT)
    # Replacing a key needs no room; an expired value makes room
    await store.put(SCOPE, _k('k1'), '2', TTL, LIMIT)
    clock[0] += 6
    await store.put(SCOPE, _k('k4'), '1', TTL, LIMIT)
    assert await store.get(_k('k4')) == '1'
    assert _consistent(store)


# ==== The per-node limit =========================================================


async def _fill(store, count=LIMIT, scope=SCOPE, ttl=TTL):
    """Write ``count`` keys ``k0..`` into a scope."""
    for index in range(count):
        await store.put(scope, _k(f'k{index}', scope), '1', ttl, LIMIT)


async def test_the_sixteenth_key_fits_and_the_seventeenth_is_refused(roomy):
    assert LIMIT == 16
    await _fill(roomy, 16)
    with pytest.raises(StateError, match='at most 16 state keys'):
        await roomy.put(SCOPE, _k('k16'), '1', TTL, LIMIT)
    # Nothing was stored and nothing was evicted to make room
    assert await roomy.get(_k('k16')) is None
    assert [await roomy.get(_k(f'k{index}')) for index in range(16)] == ['1'] * 16
    assert _consistent(roomy)


async def test_a_key_that_exists_is_always_written_at_the_limit(roomy):
    await _fill(roomy)
    await roomy.put(SCOPE, _k('k3'), '2', TTL, LIMIT)
    assert await roomy.get(_k('k3')) == '2'
    await roomy.put(SCOPE, _k('n'), '5', TTL, LIMIT + 1)
    assert await roomy.incr(SCOPE, _k('n'), 2, TTL, LIMIT) == 7
    assert len(roomy._scopes[SCOPE]) == LIMIT + 1 and _consistent(roomy)


async def test_an_expired_key_frees_its_slot(roomy, clock):
    await roomy.put(SCOPE, _k('short'), '1', 5, LIMIT)
    await _fill(roomy, LIMIT - 1)
    with pytest.raises(StateError, match='at most 16 state keys'):
        await roomy.put(SCOPE, _k('new'), '1', TTL, LIMIT)
    # Nobody read the expired key: the write that needs its slot discounts it
    clock[0] += 6
    await roomy.put(SCOPE, _k('new'), '1', TTL, LIMIT)
    assert await roomy.get(_k('new')) == '1'
    assert _k('short') not in roomy._values and _consistent(roomy)
    with pytest.raises(StateError, match='at most 16 state keys'):
        await roomy.put(SCOPE, _k('newer'), '1', TTL, LIMIT)


async def test_an_expired_key_written_again_counts_once(roomy, clock):
    await _fill(roomy, ttl=5)
    clock[0] += 6
    # Every key lapsed, so each write adds a value; the sixteen fit again
    await _fill(roomy)
    assert len(roomy._scopes[SCOPE]) == LIMIT and _consistent(roomy)
    with pytest.raises(StateError, match='at most 16 state keys'):
        await roomy.put(SCOPE, _k('k16'), '1', TTL, LIMIT)


async def test_a_deleted_key_frees_its_slot(roomy):
    await _fill(roomy)
    assert await roomy.delete(SCOPE, _k('k0')) is True
    await roomy.put(SCOPE, _k('new'), '1', TTL, LIMIT)
    with pytest.raises(StateError, match='at most 16 state keys'):
        await roomy.put(SCOPE, _k('k0'), '1', TTL, LIMIT)
    assert _consistent(roomy)


async def test_another_nodes_keys_are_not_counted(roomy):
    await _fill(roomy)
    # The same key names in another node's scope: its own sixteen
    await _fill(roomy, scope=OTHER)
    assert await roomy.get(_k('k0', OTHER)) == '1'
    with pytest.raises(StateError, match='at most 16 state keys'):
        await roomy.put(OTHER, _k('k16', OTHER), '1', TTL, LIMIT)
    await roomy.delete(OTHER, _k('k0', OTHER))
    with pytest.raises(StateError, match='at most 16 state keys'):
        await roomy.put(SCOPE, _k('k16'), '1', TTL, LIMIT)
    assert _consistent(roomy)


async def test_incr_on_a_new_key_counts_and_is_refused_at_the_limit(roomy):
    await _fill(roomy, LIMIT - 1)
    assert await roomy.incr(SCOPE, _k('n'), 1, TTL, LIMIT) == 1
    with pytest.raises(StateError, match='at most 16 state keys'):
        await roomy.incr(SCOPE, _k('m'), 1, TTL, LIMIT)
    with pytest.raises(StateError, match='at most 16 state keys'):
        await roomy.put(SCOPE, _k('m'), '1', TTL, LIMIT)
    assert await roomy.get(_k('m')) is None
    assert await roomy.incr(SCOPE, _k('n'), 1, TTL, LIMIT) == 2


async def test_lock_leases_are_not_counted(roomy):
    # Leases on keys that hold no value take no slot
    for index in range(LIMIT + 4):
        assert await roomy.try_lock(_k(f'locked{index}'), 't', 60) is True
    await _fill(roomy)
    with pytest.raises(StateError, match='at most 16 state keys'):
        await roomy.put(SCOPE, _k('k16'), '1', TTL, LIMIT)
    # At the limit a lock is still taken, and a fenced write to a held key that exists lands
    assert await roomy.try_lock(_k('k0'), 't', 60) is True
    await roomy.put(SCOPE, _k('k0'), '2', TTL, LIMIT, token='t')
    assert await roomy.get(_k('k0')) == '2'


async def test_an_emptied_scope_leaves_nothing_behind(roomy, clock):
    await roomy.put(SCOPE, _k('a'), '1', 5, LIMIT)
    await roomy.put(SCOPE, _k('b'), '1', TTL, LIMIT)
    await roomy.delete(SCOPE, _k('b'))
    clock[0] += 6
    assert await roomy.get(_k('a')) is None
    assert roomy._values == {} and roomy._scopes == {}


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
