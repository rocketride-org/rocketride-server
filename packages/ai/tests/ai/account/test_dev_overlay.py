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

"""Contract tests for the per-user dev overlay.

The overlay is the live-manifest mechanism for app development: per-user
scoping (no cross-talk between users), call-time application to assembled
app lists (URL replacement + synthetic entries), disconnect expiry, and the
30-minute idle cap. Both the SaaS account assembly and the OSS apps.json
reader apply the same module, so these tests define the shared contract.
"""

import time

from ai.account import dev_overlay


def _reset_overlay():
    """Wipe module state between tests (module-level registry)."""
    dev_overlay._overlay.clear()


# =============================================================================
# PER-USER SCOPING
# =============================================================================


def test_register_is_scoped_per_user():
    """Entries registered by one user are invisible to another (no cross-talk)."""
    _reset_overlay()
    dev_overlay.register('alice', 1, 'acme_brandy', 'http://localhost:3011/remoteEntry.js', 'acme.brandy')

    assert len(dev_overlay.entries_for('alice')) == 1
    assert dev_overlay.entries_for('bob') == []


def test_unregister_removes_only_named_module():
    """unregister() drops exactly the named module for exactly that user."""
    _reset_overlay()
    dev_overlay.register('alice', 1, 'mod_a', 'http://localhost:3011/a.js', 'a')
    dev_overlay.register('alice', 1, 'mod_b', 'http://localhost:3012/b.js', 'b')

    assert dev_overlay.unregister('alice', 'mod_a') is True
    remaining = dev_overlay.entries_for('alice')
    assert [e['module_id'] for e in remaining] == ['mod_b']
    # Removing something never registered reports False
    assert dev_overlay.unregister('alice', 'mod_a') is False
    assert dev_overlay.unregister('bob', 'mod_b') is False


# =============================================================================
# MANIFEST APPLICATION
# =============================================================================


def test_apply_overlay_replaces_matching_entry_url():
    """A matching moduleId gets its entry URL replaced and dev:True flagged."""
    _reset_overlay()
    dev_overlay.register('alice', 1, 'acme_brandy', 'http://localhost:3011/remoteEntry.js', 'acme.brandy')
    apps = [{'id': 'acme.brandy', 'moduleId': 'acme_brandy', 'entry': '/apps/brandy/remoteEntry.js', 'name': 'Brandy'}]

    out = dev_overlay.apply_overlay('alice', apps)

    assert out[0]['entry'] == 'http://localhost:3011/remoteEntry.js'
    assert out[0]['dev'] is True
    # Input list is not mutated
    assert apps[0]['entry'] == '/apps/brandy/remoteEntry.js'
    assert 'dev' not in apps[0]


def test_apply_overlay_appends_synthetic_entry_for_unknown_module():
    """An overlay module with no matching app appends a loadable synthetic entry."""
    _reset_overlay()
    dev_overlay.register('alice', 1, 'acme_new', 'http://localhost:3013/remoteEntry.js', 'acme.new')

    out = dev_overlay.apply_overlay('alice', [])

    assert len(out) == 1
    synthetic = out[0]
    assert synthetic['id'] == 'acme.new'
    assert synthetic['moduleId'] == 'acme_new'
    assert synthetic['entry'] == 'http://localhost:3013/remoteEntry.js'
    assert synthetic['dev'] is True
    assert synthetic['appStatus'] == 'dev'


def test_apply_overlay_is_identity_for_other_users():
    """Another user's assembled list passes through untouched."""
    _reset_overlay()
    dev_overlay.register('alice', 1, 'acme_brandy', 'http://localhost:3011/x.js', 'acme.brandy')
    apps = [{'id': 'acme.brandy', 'moduleId': 'acme_brandy', 'entry': '/apps/brandy/remoteEntry.js'}]

    out = dev_overlay.apply_overlay('bob', apps)

    assert out == apps


# =============================================================================
# EXPIRY — disconnect + idle cap
# =============================================================================


def test_drop_connection_removes_only_that_connections_entries():
    """Disconnect expiry drops the closing connection's entries, keeps others."""
    _reset_overlay()
    dev_overlay.register('alice', 1, 'mod_a', 'http://localhost:3011/a.js', 'a')
    dev_overlay.register('alice', 2, 'mod_b', 'http://localhost:3012/b.js', 'b')

    assert dev_overlay.drop_connection('alice', 1) is True
    assert [e['module_id'] for e in dev_overlay.entries_for('alice')] == ['mod_b']
    # Nothing left for connection 1 — a second drop is a no-op
    assert dev_overlay.drop_connection('alice', 1) is False


def test_idle_cap_expires_stale_entries():
    """Entries past the idle TTL are pruned on read; refreshes keep them alive."""
    _reset_overlay()
    dev_overlay.register('alice', 1, 'mod_a', 'http://localhost:3011/a.js', 'a')

    # Age the entry past the idle cap by rewinding its expiry stamp
    dev_overlay._overlay['alice']['mod_a']['expires_at'] = time.time() - 1

    assert dev_overlay.entries_for('alice') == []
    # The bucket is fully cleaned up once empty
    assert 'alice' not in dev_overlay._overlay


def test_reregister_refreshes_idle_expiry():
    """Re-registering the same module refreshes its idle expiry stamp."""
    _reset_overlay()
    dev_overlay.register('alice', 1, 'mod_a', 'http://localhost:3011/a.js', 'a')
    dev_overlay._overlay['alice']['mod_a']['expires_at'] = time.time() + 5

    dev_overlay.register('alice', 1, 'mod_a', 'http://localhost:3011/a.js', 'a')

    remaining = dev_overlay._overlay['alice']['mod_a']['expires_at'] - time.time()
    assert remaining > dev_overlay._IDLE_TTL_SECONDS - 60
