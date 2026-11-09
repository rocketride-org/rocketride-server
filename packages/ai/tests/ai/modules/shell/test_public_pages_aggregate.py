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
Aggregate tests: build from published manifests, legacy fallback, atomic
rebuild on publish/unpublish/rung-repoint, pre-release isolation, and the
hooks that keep it current (startup build, deploy-change rebuild).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

import ai.modules.shell.public_pages as pp
import ai.modules.task.deploy_events as deploy_events
from ai.modules.shell.public_pages import Published, build_aggregate, legacy_aggregate, load_published

from .hostile_fixtures import HOME_MANIFEST, LEAK_MARKERS, dist_of, hostile_account

# Every hostile platform app is a root claimant here, so ONLY the serving
# gate (disabled / unapproved / unbuilt / gated / team rung) keeps it out.
ALL_ROOTS = 'rocketride.home,rocketride.secret,rocketride.review,rocketride.building,rocketride.gated,rocketride.preview,evil.squatter'


@pytest.fixture(autouse=True)
def _roots(monkeypatch):
    monkeypatch.setenv('RR_PUBLIC_ROOT_APPS', ALL_ROOTS)


def _paths(agg):
    return [p.path for p in agg.pages()]


@pytest.fixture
def warnings(monkeypatch):
    out = []
    monkeypatch.setattr(pp, 'warning', out.append)
    return out


def _store_timeout(monkeypatch, app_id='rocketride.home'):
    """Fail every store read of ``app_id``'s versions, as a transient store error does; return the real reader."""
    read = pp.read_artifact_file

    async def flaky(path):
        if f'/.deployments/{app_id}/' in path:
            raise OSError('store timeout')
        return await read(path)

    monkeypatch.setattr(pp, 'read_artifact_file', flaky)
    return read


# ---------------------------------------------------------------------------
# Loader + build (with the hostile state)
# ---------------------------------------------------------------------------


async def test_loader_keeps_only_the_served_platform_manifests():
    published = await load_published(hostile_account())
    assert [p.app_id for p in published] == ['rocketride.home']
    home = published[0]
    assert home.dist_dir == 'orgs/00000000-platform/files/.deployments/rocketride.home/v000001-abc/dist'
    assert home.version == 1
    assert home.published_at == 1_700_000_100.0


async def test_aggregate_from_hostile_state_has_no_leaks():
    agg = build_aggregate(await load_published(hostile_account()))
    assert not agg.legacy
    assert _paths(agg) == ['/', '/marketplace', '/pricing', '/store']
    assert agg.site == {k: HOME_MANIFEST['site'][k] for k in ('title', 'blurb', 'docsUrl', 'organization')}
    blob = repr(agg)
    for marker in LEAK_MARKERS:
        assert marker not in blob


async def test_third_party_root_squatter_never_claims_anything():
    acct = hostile_account()
    # Even alone on the platform (no home app), the squatter gets nothing.
    acct.rows = [r for r in acct.rows if r['appId'] == 'evil.squatter']
    agg = build_aggregate(await load_published(acct))
    assert agg.legacy


async def test_pre_release_rungs_never_affect_the_aggregate():
    acct = hostile_account()
    # Repoint home's TEAM rung at a version with different pages: the public
    # (production) rung still decides.
    preview = dict(HOME_MANIFEST, publicPages=[{'path': '/preview-only', 'title': 'P'}])
    acct.add('00000000-platform', 'rocketride.home', preview, version=2, audience={'type': 'team', 'id': 't'})
    acct.add('00000000-platform', 'rocketride.home', preview, version=3, audience={'type': 'user', 'id': 'u'})
    agg = build_aggregate(await load_published(acct))
    assert '/preview-only' not in _paths(agg) and '/pricing' in _paths(agg)


@pytest.mark.parametrize('blocked', [{'state': 'disabled'}, {'artifact_state': 'rejected'}, {'build': 'failed'}])
async def test_a_blocked_row_that_wins_precedence_does_not_hide_a_serving_one(blocked):
    # The store walk drops rows that do not serve, then picks each app's winner
    # among the rest. A lower org id wins precedence, so a blocked row there
    # must not drop an app the store still serves from the platform org.
    acct = hostile_account()
    acct.add('00000000-aaaa', 'rocketride.home', HOME_MANIFEST, **blocked)
    published = {p.app_id: p for p in await load_published(acct)}
    assert published['rocketride.home'].dist_dir.startswith('orgs/00000000-platform/')


# ---------------------------------------------------------------------------
# Legacy fallback
# ---------------------------------------------------------------------------


def test_legacy_fallback_when_no_manifest_declares_pages():
    agg = build_aggregate([])
    assert agg.legacy
    assert '/pricing' in agg.exact and agg.exact['/store'].listed is False
    assert agg.exact['/pricing'].head_title == 'Pricing | RocketRide'
    assert agg.exact['/'].head_title == 'RocketRide'
    assert agg.site['docsUrl'] == 'https://docs.rocketride.org/llms.txt'


def test_legacy_fallback_when_every_declared_page_is_invalid():
    agg = build_aggregate([Published('rocketride.home', {'publicPages': [{'path': '/Bad', 'title': 'x'}]})])
    assert agg.legacy


def test_the_legacy_aggregate_is_the_legacy_page_list_with_its_unlisted_pages():
    from ai.modules.shell.legacy_manifest import _LEGACY_ROUTES

    agg = legacy_aggregate()
    assert [(p.path, p.title, p.description) for p in agg.exact.values()] == _LEGACY_ROUTES
    assert len(agg.exact) == 25
    assert {p.path for p in agg.pages() if not p.listed} == {
        '/oss',
        '/mcp-server',
        '/store',
        '/marketplace',
        '/build-publish-earn',
    }


def test_legacy_fallback_is_filtered_against_live_routes():
    agg = build_aggregate([], live_conflict=lambda p: 'GET /contact' if p == '/contact' else None)
    assert agg.legacy and '/contact' not in agg.exact and '/pricing' in agg.exact


def test_current_is_the_legacy_aggregate_before_the_first_build():
    assert pp.current().legacy and pp.current() is pp.current()


# ---------------------------------------------------------------------------
# Claims
# ---------------------------------------------------------------------------


def test_first_claim_wins_across_root_claimants():
    early = Published(
        'rocketride.home',
        {'publicPages': [{'path': '/', 'title': 'H'}, {'path': '/x', 'title': 'H'}]},
        published_at=1.0,
    )
    late = Published(
        'rocketride.secret',
        {'publicPages': [{'path': '/x', 'title': 'S'}, {'path': '/y', 'title': 'S'}]},
        published_at=2.0,
    )
    agg = build_aggregate([late, early])
    assert agg.exact['/x'].app_id == 'rocketride.home'
    assert agg.exact['/y'].app_id == 'rocketride.secret'


def test_a_published_manifests_dropped_pages_are_warnings(warnings):
    # A seeded platform row never passed the gate: without a warning, a broken
    # home-ui manifest would fall back to the legacy list with nothing logged.
    home = Published('rocketride.home', {'publicPages': [{'path': '/', 'title': 'H'}, {'path': '/x', 'title': 'H'}]})
    other = Published(
        'rocketride.secret', {'publicPages': [{'path': '/x', 'title': 'S'}, {'path': '/API', 'title': 'S'}]}
    )
    build_aggregate([home, other])
    assert len(warnings) == 2
    # Both apps are named: the one whose page was dropped, and the first claim that kept it.
    assert any('rocketride.secret: /x already claimed by rocketride.home (page skipped)' in w for w in warnings)
    assert any("'/API'" in w for w in warnings)


def test_site_only_from_the_root_owner():
    home = Published(
        'rocketride.home', {'publicPages': [{'path': '/', 'title': 'H'}], 'site': {'title': 'Home'}}, published_at=1
    )
    other = Published(
        'rocketride.secret', {'publicPages': [{'path': '/', 'title': 'S'}], 'site': {'title': 'Evil'}}, published_at=2
    )
    assert build_aggregate([other, home]).site == {'title': 'Home'}


def test_live_route_conflicts_are_dropped_at_build():
    pub = Published(
        'rocketride.home', {'publicPages': [{'path': '/status', 'title': 'S'}, {'path': '/ok', 'title': 'O'}]}
    )
    agg = build_aggregate([pub], live_conflict=lambda p: 'GET /status' if p == '/status' else None)
    assert _paths(agg) == ['/ok']


def test_pages_carry_their_version_and_binding_time():
    pub = Published(
        'rocketride.home',
        {'publicPages': [{'path': '/', 'title': 'H', 'image': '/og.png', 'futureField': 1}]},
        dist_dir='orgs/p/dist',
        published_at=5.0,
        version=7,
    )
    page = build_aggregate([pub]).exact['/']
    assert (page.app_id, page.dist_dir, page.version, page.published_at) == ('rocketride.home', 'orgs/p/dist', 7, 5.0)
    assert page.image == '/og.png' and dict(page.extra) == {'futureField': 1}


# ---------------------------------------------------------------------------
# Rebuild: atomic swap on publish / unpublish / rung repoint
# ---------------------------------------------------------------------------


async def test_rebuild_tracks_publish_unpublish_and_repoint():
    acct = hostile_account()
    swaps = []
    pp.on_swap(lambda old, new: swaps.append((old, new)))
    assert pp.current().legacy  # before the first build: the legacy map serves

    assert await pp.rebuild(acct)
    assert '/pricing' in pp.current().exact and len(swaps) == 1

    # Repoint the public rung to v2, which drops /pricing and adds /about.
    v2 = dict(HOME_MANIFEST, publicPages=[{'path': '/', 'title': 'R'}, {'path': '/about', 'title': 'A'}])
    acct.add('00000000-platform', 'rocketride.home', v2, version=2)
    acct.rows = [r for r in acct.rows if not (r['appId'] == 'rocketride.home' and r['version'] == 1)]
    assert await pp.rebuild(acct)
    assert _paths(pp.current()) == ['/', '/about']

    # Unpublish (binding disabled): back to the legacy fallback.
    for row in acct.rows:
        if row['appId'] == 'rocketride.home':
            row['state'] = 'disabled'
    assert await pp.rebuild(acct)
    assert pp.current().legacy and len(swaps) == 3


async def test_rebuild_failure_keeps_the_previous_aggregate():
    acct = hostile_account()
    assert await pp.rebuild(acct)
    before = pp.current()
    acct.fail = True
    assert not await pp.rebuild(acct)
    assert pp.current() is before


async def _a_swap_listener_fails(monkeypatch):
    def boom(old, new):
        raise RuntimeError('listener down')

    pp.on_swap(boom)
    assert await pp.rebuild(hostile_account())


async def _the_rebuild_times_out(monkeypatch):
    async def hung(acct=None, strict=False, exclude='', unreadable=None):
        await asyncio.Event().wait()  # never set

    monkeypatch.setattr(pp, 'BUILD_SECONDS', 0.01)
    monkeypatch.setattr(pp, 'load_published', hung)
    assert await pp.rebuild() is False


async def _the_rebuild_fails(monkeypatch):
    def boom(published, live_conflict=None):
        raise RuntimeError('bad manifest')

    monkeypatch.setattr(pp, 'build_aggregate', boom)
    assert await pp.rebuild(hostile_account()) is False


async def _the_first_build_outlasts_the_startup_bound(monkeypatch):
    release = asyncio.Event()

    async def slow(acct=None, strict=False, exclude='', unreadable=None):
        await release.wait()
        return []

    monkeypatch.setattr(pp, 'load_published', slow)
    monkeypatch.setattr(pp, 'STARTUP_BUILD_SECONDS', 0.01)
    assert await pp.build_at_startup() is False
    release.set()
    await pp.page_map._rebuild_task


@pytest.mark.parametrize(
    'failure,message',
    [
        (_a_swap_listener_fails, 'swap listener failed: listener down'),
        (_the_rebuild_times_out, 'rebuild timed out'),
        (_the_rebuild_fails, 'rebuild failed, keeping the previous aggregate: bad manifest'),
        (_the_first_build_outlasts_the_startup_bound, 'the first build is still running'),
    ],
)
async def test_failures_operators_must_see_are_warnings(monkeypatch, warnings, failure, message):
    # rocketlib's debug is trace-only: a production engine would never show these.
    await failure(monkeypatch)
    assert [w for w in warnings if message in w], warnings


async def test_a_failing_swap_listener_never_stops_the_swap():
    def boom(old, new):
        raise RuntimeError('listener down')

    seen = []
    pp.on_swap(boom)
    pp.on_swap(lambda old, new: seen.append(new))
    assert await pp.rebuild(hostile_account())
    assert seen == [pp.current()] and not pp.current().legacy


async def test_one_unreadable_app_is_skipped_and_never_freezes_the_map(monkeypatch, warnings):
    monkeypatch.setenv('RR_PUBLIC_ROOT_APPS', 'rocketride.home,rocketride.other')
    acct = hostile_account()
    acct.add('00000000-platform', 'rocketride.other', {'publicPages': [{'path': '/other', 'title': 'O'}]})
    del acct.artifacts[('00000000-platform', 'rocketride.home', 1)]  # home unreadable
    assert await pp.rebuild(acct)
    assert _paths(pp.current()) == ['/other']
    assert warnings == []  # a first build has no pages of home's to keep
    # A later unpublish elsewhere still applies (the broken app cannot freeze the map).
    for row in acct.rows:
        if row['appId'] == 'rocketride.other':
            row['state'] = 'disabled'
    assert await pp.rebuild(acct)
    assert pp.current().legacy


async def test_an_unreadable_app_keeps_its_current_pages_until_it_reads_again(monkeypatch, warnings):
    acct = hostile_account()
    assert await pp.rebuild(acct)
    before = pp.current()
    assert before.exact['/pricing'].dist_dir == dist_of('00000000-platform', 'rocketride.home')
    # The public rung moves to v2 while the store cannot be read.
    # Valid on its own: no redirect points at a page v2 no longer has.
    v2_site = {k: v for k, v in HOME_MANIFEST['site'].items() if k != 'redirects'}
    v2 = dict(HOME_MANIFEST, publicPages=[{'path': '/', 'title': 'R'}, {'path': '/about', 'title': 'A'}], site=v2_site)
    acct.add('00000000-platform', 'rocketride.home', v2, version=2, published_at=1_700_000_200.0, emit=True)
    acct.rows = [r for r in acct.rows if not (r['appId'] == 'rocketride.home' and r['version'] == 1)]
    read = _store_timeout(monkeypatch)
    assert await pp.rebuild(acct)
    # The same pages, from the same version's build output: their snapshots still resolve.
    assert pp.current() is before
    assert warnings == ['[public_pages] rocketride.home: unreadable this build, keeping its current pages']
    monkeypatch.setattr(pp, 'read_artifact_file', read)
    assert await pp.rebuild(acct)
    assert _paths(pp.current()) == ['/', '/about']
    assert pp.current().exact['/'].dist_dir == dist_of('00000000-platform', 'rocketride.home', 2)
    assert len(warnings) == 1


@pytest.mark.parametrize(
    'leave',
    [
        lambda acct, row: acct.rows.remove(row),
        lambda acct, row: row.update(state='disabled'),
        lambda acct, row: row['snapshot'].update(public=False),
    ],
    ids=['row removed', 'binding disabled', 'made non-public'],
)
async def test_an_app_no_longer_published_drops_its_pages_even_when_unreadable(monkeypatch, warnings, leave):
    acct = hostile_account()
    assert await pp.rebuild(acct)
    [row] = [r for r in acct.rows if r['appId'] == 'rocketride.home']
    leave(acct, row)
    _store_timeout(monkeypatch)
    assert await pp.rebuild(acct)
    assert 'rocketride.home' not in {p.app_id for p in pp.current().pages()}
    assert warnings == []


async def test_kept_pages_claim_against_the_fresh_ones(monkeypatch, warnings):
    monkeypatch.setenv('RR_PUBLIC_ROOT_APPS', 'rocketride.home,rocketride.other')
    acct = hostile_account()
    other = {'publicPages': [{'path': '/pricing', 'title': 'Other'}]}
    acct.add('00000000-platform', 'rocketride.other', other, published_at=1.0)
    artifact = acct.artifacts.pop(('00000000-platform', 'rocketride.other', 1))  # unreadable at first
    assert await pp.rebuild(acct)
    assert pp.current().exact['/pricing'].app_id == 'rocketride.home'
    acct.artifacts[('00000000-platform', 'rocketride.other', 1)] = artifact
    _store_timeout(monkeypatch)
    assert await pp.rebuild(acct)
    # home's kept claims lose to the earlier binding, as fresh ones would.
    assert pp.current().exact['/pricing'].app_id == 'rocketride.other'
    assert pp.current().exact['/'].app_id == 'rocketride.home'
    assert len(warnings) == 2 and 'unreadable this build' in warnings[0]
    assert '/pricing already claimed by rocketride.other' in warnings[1]


async def test_malformed_rows_are_skipped():
    acct = hostile_account()
    for row in acct.rows:
        if row['appId'] == 'rocketride.home':
            row['artifactPath'] = ''  # would map every app to '/dist'
    assert await pp.rebuild(acct)
    assert pp.current().legacy


async def test_the_gate_loader_is_strict_for_root_claimants_and_names_the_app(monkeypatch):
    monkeypatch.setenv('RR_PUBLIC_ROOT_APPS', 'rocketride.home')
    acct = hostile_account()
    acct.add('00000000-platform', 'rocketride.tool', {'name': 'Tool'})
    del acct.artifacts[('00000000-platform', 'rocketride.tool', 1)]
    # A platform app that may not claim root holds no claims: skipped, never fatal.
    assert [p.app_id for p in await load_published(acct, strict=True)] == ['rocketride.home']
    del acct.artifacts[('00000000-platform', 'rocketride.home', 1)]
    with pytest.raises(RuntimeError, match='cannot read the published manifest of rocketride.home'):
        await load_published(acct, strict=True)
    # The publishing app itself is left out unread, so it can always replace its own version.
    assert await load_published(acct, strict=True, exclude='rocketride.home') == []


async def test_public_false_platform_apps_contribute_nothing():
    acct = hostile_account()
    for row in acct.rows:
        if row['appId'] == 'rocketride.home':
            row['snapshot']['public'] = False
    assert await pp.rebuild(acct)
    assert pp.current().legacy
    # The DB edition drops the snapshot flag: the manifest's own flag counts too.
    acct2 = hostile_account()
    acct2.artifacts[('00000000-platform', 'rocketride.home', 1)]['metadata']['manifest']['public'] = False
    assert await pp.rebuild(acct2)
    assert pp.current().legacy


async def test_schedule_rebuild_coalesces_events(monkeypatch):
    calls = []
    gate = asyncio.Event()

    async def slow_rebuild(acct=None):
        calls.append(1)
        await gate.wait()
        return True

    monkeypatch.setattr(pp.page_map, 'rebuild', slow_rebuild)
    pp.app_changed('rocketride.home')
    await asyncio.sleep(0)  # the first rebuild is now running
    for _ in range(4):
        pp.app_changed('rocketride.home')
    gate.set()
    await pp.page_map._rebuild_task
    # One running rebuild + exactly one follow-up for the events it missed.
    assert len(calls) == 2


def test_schedule_rebuild_outside_a_loop_is_a_no_op():
    pp.schedule_rebuild()
    assert pp.page_map._rebuild_task is None


async def test_only_platform_app_changes_schedule_a_rebuild(monkeypatch):
    rebuilds = []

    async def rebuild(acct=None):
        rebuilds.append(acct)
        return True

    monkeypatch.setattr(pp.page_map, 'rebuild', rebuild)
    pp.app_changed('acme.brandy')
    assert pp.page_map._rebuild_task is None and not pp.page_map._rebuild_pending
    pp.app_changed('rocketride.home')
    await pp.page_map._rebuild_task
    assert rebuilds == [None]


async def test_an_unchanged_map_is_not_swapped():
    acct = hostile_account()
    swaps = []
    pp.on_swap(lambda old, new: swaps.append(new))
    assert await pp.rebuild(acct)
    built = pp.current()
    assert await pp.rebuild(acct)
    assert pp.current() is built and len(swaps) == 1
    # The legacy list rebuilt over the legacy list: no swap either.
    pp.swap(pp.legacy_aggregate())
    acct.rows = []
    assert await pp.rebuild(acct)
    assert len(swaps) == 2


async def test_rebuilds_run_one_at_a_time_and_the_later_one_lands(monkeypatch):
    running, peak = 0, 0

    async def load(acct=None, strict=False, exclude='', unreadable=None):
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        for _ in range(3):
            await asyncio.sleep(0)
        running -= 1
        return acct

    def published(title):
        return [Published('rocketride.home', {'publicPages': [{'path': '/', 'title': title}]})]

    monkeypatch.setattr(pp, 'load_published', load)
    assert await asyncio.gather(pp.rebuild(published('First')), pp.rebuild(published('Second'))) == [True, True]
    assert peak == 1
    assert pp.current().exact['/'].title == 'Second'


async def test_a_hung_store_read_times_out_and_a_later_rebuild_lands(monkeypatch):
    assert await pp.rebuild(hostile_account())
    before = pp.current()

    async def hung(acct=None, strict=False, exclude='', unreadable=None):
        await asyncio.Event().wait()  # never set

    monkeypatch.setattr(pp, 'BUILD_SECONDS', 0.01)
    monkeypatch.setattr(pp, 'load_published', hung)
    assert await pp.rebuild() is False
    assert pp.current() is before

    async def fixed(acct=None, strict=False, exclude='', unreadable=None):
        return [Published('rocketride.home', {'publicPages': [{'path': '/', 'title': 'Fixed'}]})]

    monkeypatch.setattr(pp, 'load_published', fixed)  # the lock was released: the next rebuild runs
    assert await pp.rebuild() is True
    assert pp.current().exact['/'].title == 'Fixed'


async def test_rebuild_drops_pages_on_the_installed_live_routes():
    pp.set_live_conflict(lambda p: 'GET /pricing' if p == '/pricing' else None)
    assert await pp.rebuild(hostile_account())
    assert '/pricing' not in pp.current().exact and '/marketplace' in pp.current().exact
    assert pp.live_conflict()('/pricing') == 'GET /pricing'


async def test_maybe_refresh_schedules_at_most_one_rebuild_per_period(monkeypatch):
    scheduled = []
    monkeypatch.setattr(pp.page_map, 'schedule_rebuild', lambda: scheduled.append(1))
    monkeypatch.setattr(pp.page_map, '_built_at', pp.time.monotonic())
    pp.maybe_refresh()
    assert scheduled == []
    monkeypatch.setattr(pp.page_map, '_built_at', pp.time.monotonic() - pp.REFRESH_SECONDS - 1)
    pp.maybe_refresh()
    # The clock restarted when it scheduled: an unchanged map is never swapped,
    # and a failing store must not be retried on every request.
    pp.maybe_refresh()
    assert scheduled == [1]


async def test_a_swap_restarts_the_refresh_clock(monkeypatch):
    scheduled = []
    monkeypatch.setattr(pp.page_map, 'schedule_rebuild', lambda: scheduled.append(1))
    monkeypatch.setattr(pp.page_map, '_built_at', pp.time.monotonic() - pp.REFRESH_SECONDS - 1)
    pp.swap(pp.legacy_aggregate())
    pp.maybe_refresh()
    assert scheduled == []


async def test_a_failing_build_keeps_the_previous_aggregate(monkeypatch):
    before = pp.current()

    def boom(published, live_conflict=None):
        raise RuntimeError('bad manifest')

    monkeypatch.setattr(pp, 'build_aggregate', boom)
    assert await pp.rebuild(hostile_account()) is False
    assert pp.current() is before


# ---------------------------------------------------------------------------
# site.redirects
# ---------------------------------------------------------------------------


def _root(app_id, pages, redirects, at):
    manifest = {
        'publicPages': [{'path': p, 'title': 'T'} for p in pages],
        'site': {'title': app_id, 'redirects': [{'from': f, 'to': t} for f, t in redirects]},
    }
    return Published(app_id, manifest, published_at=at)


def test_the_aggregate_carries_the_root_owners_redirects_outside_site():
    agg = build_aggregate([_root('rocketride.home', ['/', '/legal/terms'], [('/terms', '/legal/terms')], 1)])
    assert agg.redirects == {'/terms': '/legal/terms'}
    assert agg.site == {'title': 'rocketride.home'}


def test_redirects_lose_to_other_apps_pages():
    home = _root('rocketride.home', ['/', '/x', '/kept'], [('/y', '/kept'), ('/fine', '/kept'), ('/moved', '/x')], 1)
    # Published earlier: it owns /x and /y, so home's source /y is its page.
    other = _root('rocketride.secret', ['/x', '/y'], [], 0)
    agg = build_aggregate([home, other])
    assert agg.exact['/x'].app_id == 'rocketride.secret'
    # /x is still a page in the aggregate (another app's), so /moved stands.
    assert agg.redirects == {'/fine': '/kept', '/moved': '/x'}


def test_redirects_whose_slash_twin_another_app_took_are_dropped():
    home = _root('rocketride.home', ['/', '/kept'], [('/y/', '/kept'), ('/fine/', '/kept')], 1)
    other = _root('rocketride.secret', ['/y'], [], 0)
    assert build_aggregate([home, other]).redirects == {'/fine/': '/kept'}


def test_only_the_root_owners_redirects_apply():
    home = _root('rocketride.home', ['/', '/a'], [('/old', '/a')], 1)
    loser = _root('rocketride.secret', ['/', '/b'], [('/other', '/b')], 2)
    assert build_aggregate([loser, home]).redirects == {'/old': '/a'}


def test_a_manifest_without_redirects_has_none():
    assert build_aggregate([Published('rocketride.home', HOME_MANIFEST)]).redirects == {'/plans': '/pricing'}
    assert build_aggregate([_root('rocketride.home', ['/'], [], 1)]).redirects == {}


# home-ui's src/redirects.ts (rocketride-saas), entry for entry: the legacy map
# answers these URLs until home-ui's manifest carries its own.
LEGACY_REDIRECTS = {
    '/terms': '/legal/terms',
    '/terms/': '/legal/terms',
    '/privacy-policy': '/legal/privacy-policy',
    '/privacy-policy/': '/legal/privacy-policy',
    '/privacy': '/legal/privacy-policy',
    '/privacy/': '/legal/privacy-policy',
}


def test_the_legacy_redirect_map_is_home_uis():
    from ai.modules.shell.legacy_manifest import legacy_page_manifest

    redirects = legacy_page_manifest()['site']['redirects']
    assert [(r['from'], r['to']) for r in redirects] == list(LEGACY_REDIRECTS.items())


def test_the_legacy_aggregate_carries_the_legacy_redirect_map():
    agg = legacy_aggregate()
    assert agg.redirects == LEGACY_REDIRECTS
    assert 'redirects' not in agg.site
    assert build_aggregate([]).redirects == LEGACY_REDIRECTS


def test_legacy_redirects_are_filtered_against_live_routes():
    live = {'/terms': 'GET /terms', '/legal/privacy-policy': 'GET /legal/privacy-policy'}
    agg = build_aggregate([], live_conflict=live.get)
    # /terms is a live route (so /terms/, its slash twin, goes too); the
    # privacy-policy target page is gone with its claim.
    dropped = {'/terms', '/terms/', '/privacy-policy', '/privacy-policy/', '/privacy', '/privacy/'}
    assert set(agg.redirects) == set(LEGACY_REDIRECTS) - dropped


# ---------------------------------------------------------------------------
# Hooks: the startup build and the deploy-change rebuild
# ---------------------------------------------------------------------------


def _boot(monkeypatch, load):
    """Run ``eaas.run`` with a fake server and account layer; return what happened, in order."""
    from ai import eaas
    from ai.account import account

    events = []

    class Routes(list):
        def append(self, route):
            events.append(('route', route.path))
            super().append(route)

    class Server:
        def __init__(self, config, standardEndpoints):
            self.app = SimpleNamespace(router=SimpleNamespace(routes=Routes()))

        def use(self, module):
            events.append('module')

        def add_catch_all(self, route):
            self.app.router.routes.append(route)

        async def serve(self):
            events.append(('serve', pp.current()))

    async def init_account(server):
        events.append('account')

    async def load_published(acct=None, strict=False, exclude='', unreadable=None):
        events.append('build')
        return await load()

    monkeypatch.setattr(eaas, 'WebServer', Server)
    monkeypatch.setattr(eaas, '_require_writable_task_data', lambda: None)
    monkeypatch.setattr(eaas, '_make_engine_private', lambda: None)
    monkeypatch.setattr(account, 'init_account', init_account)
    monkeypatch.setattr(pp, 'load_published', load_published)
    asyncio.run(eaas.run({'port': 0, 'host': '127.0.0.1'}))
    return events


def test_the_engine_builds_the_page_map_before_it_serves(monkeypatch):
    async def home():
        return [Published('rocketride.home', {'publicPages': [{'path': '/', 'title': 'Home'}]})]

    events = _boot(monkeypatch, home)
    modules = events.count('module')
    catch_all = ('route', '/{public_page_path:path}')
    assert modules and events[:-1] == ['module'] * modules + ['account', catch_all, 'build']
    serve, served = events[-1]
    assert serve == 'serve' and not served.legacy and served.exact['/'].title == 'Home'


def test_a_failing_first_build_never_stops_the_boot(monkeypatch):
    async def down():
        raise RuntimeError('store down')

    events = _boot(monkeypatch, down)
    serve, served = events[-1]
    assert events[-2] == 'build' and serve == 'serve' and served.legacy


async def test_a_slow_first_build_starts_on_the_legacy_list_and_lands_later(monkeypatch):
    release = asyncio.Event()

    async def load(acct=None, strict=False, exclude='', unreadable=None):
        await release.wait()
        return [Published('rocketride.home', {'publicPages': [{'path': '/', 'title': 'Home'}]})]

    monkeypatch.setattr(pp, 'load_published', load)
    monkeypatch.setattr(pp, 'STARTUP_BUILD_SECONDS', 0.01)
    assert await pp.build_at_startup() is False
    assert pp.current().legacy  # the engine starts here
    release.set()
    await pp.page_map._rebuild_task
    assert not pp.current().legacy and pp.current().exact['/'].title == 'Home'


def test_deploy_change_broadcast_schedules_an_aggregate_rebuild(monkeypatch):
    changed = []
    monkeypatch.setattr(pp, 'app_changed', changed.append)

    async def broadcast_server_event(event_type, message, org_id=None):
        pass

    server = SimpleNamespace(broadcast_server_event=broadcast_server_event)
    asyncio.run(deploy_events.broadcast_app_changed(server, 'org1', 'rocketride.home', 'publish'))
    assert changed == ['rocketride.home']


def test_a_failing_rebuild_hook_never_stops_the_broadcast(monkeypatch):
    sent = []

    def boom(app_id):
        raise RuntimeError('nope')

    async def broadcast_server_event(event_type, message, org_id=None):
        sent.append(message['body']['action'])

    monkeypatch.setattr(pp, 'app_changed', boom)
    server = SimpleNamespace(broadcast_server_event=broadcast_server_event)
    asyncio.run(deploy_events.broadcast_app_changed(server, 'org1', 'rocketride.home', 'publish'))
    assert sent == ['publish']
