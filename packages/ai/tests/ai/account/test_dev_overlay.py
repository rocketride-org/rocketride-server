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


def test_synthetic_entry_renders_registered_manifest_basics():
    """register_dev meta (name/description/icon/appVersion) feeds the
    synthetic tile so a never-published app renders like a store tile; a
    registration without meta keeps the bare fallbacks (older clients).
    """
    _reset_overlay()
    dev_overlay.register(
        'alice',
        1,
        'acme_new',
        'http://localhost:3013/remoteEntry.js',
        'acme.new',
        meta={
            'name': 'Hello World',
            'description': 'A simple Hello World demo application',
            'icon': 'data:image/svg+xml;base64,AAAA',
            'appVersion': '1.2.0',
        },
    )
    dev_overlay.register('alice', 2, 'acme_bare', 'http://localhost:3014/remoteEntry.js', 'acme.bare')

    out = {e['id']: e for e in dev_overlay.apply_overlay('alice', [])}

    rich = out['acme.new']
    assert rich['name'] == 'Hello World'
    assert rich['description'] == 'A simple Hello World demo application'
    assert rich['icon'] == 'data:image/svg+xml;base64,AAAA'
    assert rich['version'] == '1.2.0'
    bare = out['acme.bare']
    assert bare['name'] == 'acme.bare'
    assert bare['description'] == 'Local development app'
    assert bare['icon'] == ''
    assert bare['version'] == ''


def test_matched_app_keeps_manifest_values_over_registration_meta():
    """Meta decorates only SYNTHETIC entries — a published app's manifest
    name/description/icon are the truth; the overlay swaps entry + dev only.
    """
    _reset_overlay()
    dev_overlay.register(
        'alice',
        1,
        'acme_brandy',
        'http://localhost:3011/remoteEntry.js',
        'acme.brandy',
        meta={'name': 'LOCAL NAME', 'description': 'LOCAL DESC'},
    )
    apps = [
        {'id': 'acme.brandy', 'moduleId': 'acme_brandy', 'entry': '/x.js', 'name': 'Brandy', 'description': 'Published'}
    ]

    out = dev_overlay.apply_overlay('alice', apps)

    assert out[0]['name'] == 'Brandy'
    assert out[0]['description'] == 'Published'
    assert out[0]['entry'] == 'http://localhost:3011/remoteEntry.js'
    assert out[0]['dev'] is True


def test_sanitize_meta_drops_oversize_and_malformed_values():
    """Caps are DROP-not-fail: oversize text, non-string values, and icons
    that are not data:image/ URIs (or exceed the char cap) all vanish while
    valid siblings survive — registration itself must never break on
    cosmetic input.
    """
    args = {
        'name': 'Fine',
        'description': 'x' * 2001,
        'appVersion': 7,
        'icon': 'https://evil.example/icon.png',
    }
    assert dev_overlay._sanitize_meta(args) == {'name': 'Fine'}
    assert dev_overlay._sanitize_meta({'icon': 'data:image/png;base64,' + 'A' * 400_001}) == {}
    assert dev_overlay._sanitize_meta({'icon': 'data:image/png;base64,AA'}) == {'icon': 'data:image/png;base64,AA'}


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
    dev_overlay._overlay['alice']['mod_a'][1]['expires_at'] = time.time() - 1

    assert dev_overlay.entries_for('alice') == []
    # The bucket is fully cleaned up once empty
    assert 'alice' not in dev_overlay._overlay


def test_reregister_refreshes_idle_expiry():
    """Re-registering the same module refreshes its idle expiry stamp."""
    _reset_overlay()
    dev_overlay.register('alice', 1, 'mod_a', 'http://localhost:3011/a.js', 'a')
    dev_overlay._overlay['alice']['mod_a'][1]['expires_at'] = time.time() + 5

    dev_overlay.register('alice', 1, 'mod_a', 'http://localhost:3011/a.js', 'a')

    remaining = dev_overlay._overlay['alice']['mod_a'][1]['expires_at'] - time.time()
    assert remaining > dev_overlay._IDLE_TTL_SECONDS - 60


# =============================================================================
# ORG-SWITCH DROP (drop_user)
# =============================================================================


def test_drop_user_clears_the_whole_bucket():
    """Every entry for the user is removed regardless of registering
    connection — the org-switch sweep (a reconnect alone cannot clear the
    userId-keyed bucket, and apply_overlay would re-apply it).
    """
    _reset_overlay()
    dev_overlay.register('alice', 1, 'mod_one', 'http://localhost:3011/remoteEntry.js', 'acme.one')
    dev_overlay.register('alice', 2, 'mod_two', 'http://localhost:3012/remoteEntry.js', 'acme.two')

    assert dev_overlay.drop_user('alice') is True
    assert dev_overlay.entries_for('alice') == []


def test_drop_user_is_a_noop_on_an_empty_bucket():
    """No entries -> False, no raise (the switch handler drops unconditionally)."""
    _reset_overlay()
    assert dev_overlay.drop_user('nobody') is False


def test_drop_user_only_targets_the_named_user():
    """A sibling user's overlay survives another user's org switch."""
    _reset_overlay()
    dev_overlay.register('alice', 1, 'mod_a', 'http://localhost:3011/remoteEntry.js', 'acme.a')
    dev_overlay.register('bob', 1, 'mod_b', 'http://localhost:3012/remoteEntry.js', 'acme.b')

    dev_overlay.drop_user('alice')
    assert dev_overlay.entries_for('alice') == []
    assert len(dev_overlay.entries_for('bob')) == 1


# =============================================================================
# MULTI-EDITOR — one entry per registering connection
# =============================================================================


def test_two_connections_coexist_on_one_module():
    """Two editors dev-serving the same app hold independent registrations:
    neither register clobbers the other, and apply_overlay exposes BOTH via
    devEntries (newest first) with the newest as the default entry.
    """
    _reset_overlay()
    dev_overlay.register(
        'alice', 1, 'acme_brandy', 'http://localhost:3014/remoteEntry.js', 'acme.brandy', session='s-vscode'
    )
    dev_overlay.register(
        'alice', 2, 'acme_brandy', 'http://localhost:3015/remoteEntry.js', 'acme.brandy', session='s-cursor'
    )
    # Newest wins the default: force a deterministic order
    dev_overlay._overlay['alice']['acme_brandy'][1]['registered_at'] = 100.0
    dev_overlay._overlay['alice']['acme_brandy'][2]['registered_at'] = 200.0

    apps = [{'id': 'acme.brandy', 'moduleId': 'acme_brandy', 'entry': '/apps/brandy/remoteEntry.js'}]
    out = dev_overlay.apply_overlay('alice', apps)

    assert out[0]['entry'] == 'http://localhost:3015/remoteEntry.js'
    assert out[0]['dev'] is True
    assert [d['session'] for d in out[0]['devEntries']] == ['s-cursor', 's-vscode']
    assert [d['url'] for d in out[0]['devEntries']] == [
        'http://localhost:3015/remoteEntry.js',
        'http://localhost:3014/remoteEntry.js',
    ]


def test_reregister_touches_only_the_calling_connections_entry():
    """A rebuild's re-register refreshes the caller's entry without touching
    the sibling editor's URL — the clobbering that made shells loop.
    """
    _reset_overlay()
    dev_overlay.register('alice', 1, 'mod_a', 'http://localhost:3014/remoteEntry.js', 'a')
    dev_overlay.register('alice', 2, 'mod_a', 'http://localhost:3015/remoteEntry.js', 'a')

    dev_overlay.register('alice', 1, 'mod_a', 'http://localhost:3014/remoteEntry.js?t=2', 'a')

    urls = {e['connection_id']: e['url'] for e in dev_overlay.entries_for('alice')}
    assert urls[1] == 'http://localhost:3014/remoteEntry.js?t=2'
    assert urls[2] == 'http://localhost:3015/remoteEntry.js'


def test_connection_scoped_unregister_keeps_the_sibling():
    """One editor closing its panel removes only ITS registration."""
    _reset_overlay()
    dev_overlay.register('alice', 1, 'mod_a', 'http://localhost:3014/remoteEntry.js', 'a')
    dev_overlay.register('alice', 2, 'mod_a', 'http://localhost:3015/remoteEntry.js', 'a')

    assert dev_overlay.unregister('alice', 'mod_a', connection_id=1) is True
    remaining = dev_overlay.entries_for('alice')
    assert [e['connection_id'] for e in remaining] == [2]
    # The sibling's entry still applies to the manifest
    out = dev_overlay.apply_overlay('alice', [{'id': 'a', 'moduleId': 'mod_a', 'entry': '/x.js'}])
    assert out[0]['entry'] == 'http://localhost:3015/remoteEntry.js'


def test_drop_connection_keeps_sibling_entry_of_same_module():
    """Disconnect expiry removes the dead editor's entry for a module while
    the sibling editor's registration for the SAME module survives.
    """
    _reset_overlay()
    dev_overlay.register('alice', 1, 'mod_a', 'http://localhost:3014/remoteEntry.js', 'a')
    dev_overlay.register('alice', 2, 'mod_a', 'http://localhost:3015/remoteEntry.js', 'a')

    assert dev_overlay.drop_connection('alice', 1) is True
    remaining = dev_overlay.entries_for('alice')
    assert [e['url'] for e in remaining] == ['http://localhost:3015/remoteEntry.js']


def test_synthetic_entry_carries_dev_entries():
    """An unpublished app's synthetic manifest row exposes every live
    registration, so session routing works before first publish too.
    """
    _reset_overlay()
    dev_overlay.register('alice', 1, 'acme_new', 'http://localhost:3014/remoteEntry.js', 'acme.new', session='s-one')
    dev_overlay.register('alice', 2, 'acme_new', 'http://localhost:3015/remoteEntry.js', 'acme.new', session='s-two')

    out = dev_overlay.apply_overlay('alice', [])

    assert len(out) == 1
    assert {d['session'] for d in out[0]['devEntries']} == {'s-one', 's-two'}
    assert out[0]['entry'] in {'http://localhost:3014/remoteEntry.js', 'http://localhost:3015/remoteEntry.js'}
