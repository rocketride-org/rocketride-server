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

"""The store gate on every door (plan 0 S9/S10, 3.8, 8.4; section 14 Step 6 security matrix).

A caller outside the publisher's org with no subscription to a publication
whose listing is ``subscription`` or ``paywall`` is refused with
``SUBSCRIPTION_REQUIRED`` (address, plan, storeUrl) before any engine starts:
on ``submit(name)``, on a data ``open`` and a standalone ``tool`` borrow by
address (the door ``send``/``pipe`` and the HTTP ``/webhook``/``/task/data``
take) and by control id. A ``free`` listing, the publisher's own org and the
caller's own ``@spec``/``@me`` rungs are never asked. A key scoped to
``endpoints`` is refused on every publication that is not free
(``permission_denied``, ``required='account key'``). The verdict is cached on
the control for ``CONST_SPEND_ALLOW_SECONDS``; a refusal never is.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List
from unittest.mock import AsyncMock

import pytest

from ai.account.base import AccountBase, SubscriptionRequiredError
from ai.account.pipe_deploy import listing_of
from ai.modules.task import store_gate
from ai.modules.task.task_control import DeploymentRef, Listing, TaskControl
from ai.modules.task.task_engine import TaskEngine
from ai.modules.task.task_server_facade import _InProcessConn

from . import test_task_engine_sharing as sharing
from .test_task_engine_sharing import ADDRESS, _caller, _pipeline, _server, _start

# The runtime-model fixtures, shared with the engine-sharing tests
catalog = sharing.catalog
engines = sharing.engines
serving = sharing.serving

#: The registry name a subscription is keyed by.
PIPE = 'acme.docBrain'

# =============================================================================
# HELPERS
# =============================================================================


class _Store(sharing._Deployments):
    """The deployment surface plus the store facts: listings per version and the orgs that subscribe."""

    def __init__(self) -> None:
        super().__init__()
        self.manifests: Dict[tuple, Dict[str, Any]] = {}
        self.subscribers: set = set()
        self.asked: List[tuple] = []

    def list(self, mode: str, *, org: str = 'org-1', version: int = 1, plans=('Pro',)) -> None:
        """Give a version the manifest the pipe door writes from a ``store`` block."""
        self.manifests[(org, PIPE, version)] = {
            'name': 'Doc brain',
            'mode': mode,
            'billing': {'plans': [{'nickname': plan, 'interval': 'month', 'amountCents': 900} for plan in plans]},
        }

    async def deployments_versions(self, org_id, project_id):
        entries = await super().deployments_versions(org_id, project_id)
        for entry in entries:
            manifest = self.manifests.get((org_id, project_id, entry['version']))
            if manifest is not None:
                entry['metadata'] = {'manifest': manifest}
        return entries

    async def has_subscription(self, org_id, registry_name):
        self.asked.append((org_id, registry_name))
        return (org_id, registry_name) in self.subscribers


@pytest.fixture
def store(monkeypatch, serving):
    """The in-memory account behind ``ai.account.account``, with store listings and subscriptions."""
    import ai.account

    fake = _Store()
    monkeypatch.setattr(ai.account, 'account', fake)
    return fake


def _stranger(**kwargs):
    """A caller of another org (globex) who reaches acme's pipe on @public."""
    return _caller('user-z', dev_team='team-z', teams=('team-z',), org='org-2', developer_id='globex', **kwargs)


def _conn(ts, account) -> _InProcessConn:
    """An authenticated connection of ``account`` on ``ts``."""
    conn = _InProcessConn(ts)
    conn._account_info = account
    conn._authenticated = True
    return conn


async def _wire(conn, command: str, **arguments) -> Dict[str, Any]:
    """One request through the connection's inbound seam; the DAP response as the client receives it."""
    await conn.on_receive(conn.build_request(command, arguments=arguments))
    return conn._transport.get_response()


def _expire(control: TaskControl) -> None:
    """Move the control's subscription verdict out of its allow window."""
    control.subscription_allowed_at = time.monotonic() - 3600


# =============================================================================
# THE FACTS
# =============================================================================


@pytest.mark.parametrize(
    'mode, rung, caller_org, needed',
    [
        ('free', 'public', 'org-2', False),
        ('subscription', 'public', 'org-2', True),
        ('paywall', 'public', 'org-2', True),
        ('subscription', 'team', 'org-2', True),
        ('subscription', 'public', 'org-1', False),
        ('subscription', 'spec', 'org-2', False),
        ('subscription', 'me', 'org-2', False),
        ('subscription', 'public', '', True),
    ],
    ids=['free', 'subscription', 'paywall', 'team', 'publisher-org', 'spec', 'me', 'no-org'],
)
def test_who_needs_a_subscription(mode, rung, caller_org, needed):
    """A paid listing, called from outside the publisher's org on a rung that is not the caller's own."""
    assert store_gate.needs_subscription(Listing(mode=mode), rung, caller_org, 'org-1') is needed


def test_a_listing_is_free_unless_its_mode_says_otherwise():
    """No store block is free; any mode but free (an unknown one included) is paid."""
    assert not Listing().paid
    assert Listing(mode='subscription').paid and Listing(mode='paywall').paid and Listing(mode='usage').paid


def test_the_store_url_is_the_catalog_of_this_deployment(monkeypatch):
    """The hosted origin when ``RR_APP_URL`` pins one, the path alone otherwise."""
    monkeypatch.setenv('RR_APP_URL', 'https://app.example.com/')
    assert store_gate.store_url() == 'https://app.example.com/catalog'
    monkeypatch.delenv('RR_APP_URL')
    assert store_gate.store_url() == '/catalog'


@pytest.mark.asyncio
async def test_oss_holds_every_subscription():
    """OSS has no store billing: the facade answers True for any org and name."""
    assert await AccountBase.has_subscription(None, 'org-2', PIPE) is True


@pytest.mark.asyncio
async def test_the_listing_of_a_version_is_read_from_its_manifest(store):
    """The mode and the first plan's nickname come from ``metadata.manifest``; no store block, or no version, is free."""
    store.publish()
    assert await listing_of(store, 'org-1', PIPE, 1) == Listing()

    store.list('paywall', plans=('Starter', 'Pro'))
    assert await listing_of(store, 'org-1', PIPE, 1) == Listing(mode='paywall', plan='Starter')
    assert await listing_of(store, 'org-1', PIPE, 2) == Listing()

    # The minimal manifest a deploy without a store block gets is unlisted
    store.manifests[('org-1', PIPE, 1)] = {'name': 'Doc brain'}
    assert await listing_of(store, 'org-1', PIPE, 1) == Listing()


@pytest.mark.asyncio
async def test_a_failing_registry_never_serves_a_paid_pipe_as_free(store, monkeypatch):
    """The listing read raises; the resolver fails closed."""
    monkeypatch.setattr(store, 'deployments_versions', AsyncMock(side_effect=RuntimeError('registry down')))
    with pytest.raises(RuntimeError, match='registry down'):
        await listing_of(store, 'org-1', PIPE, 1)


# =============================================================================
# THE RESOLVER: submit(name), open/tool by address, and the HTTP door through them
# =============================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['subscription', 'paywall'])
async def test_a_caller_without_a_subscription_is_refused_before_any_engine_starts(catalog, engines, store, mode):
    """The refusal carries the address, the listing's plan and where to subscribe; nothing is registered."""
    ts = _server()
    store.publish()
    store.list(mode)

    with pytest.raises(SubscriptionRequiredError) as refused:
        await ts.resolve_or_start(ADDRESS, _stranger(), 'task.data')

    error = refused.value
    assert error.code == 'SUBSCRIPTION_REQUIRED'
    assert (error.address, error.plan) == (ADDRESS, 'Pro')
    assert error.storeUrl.endswith('/catalog') and error.storeUrl in str(error)
    assert store.asked == [('org-2', PIPE)]
    assert len(ts._engines) == 0 and list(ts._task_control) == []


@pytest.mark.asyncio
async def test_a_free_pipe_is_never_refused_and_never_asks(catalog, engines, store):
    """Free by its store block, or with no store block at all."""
    ts = _server()
    store.publish()

    unlisted = await ts.resolve_or_start(ADDRESS, _stranger(), 'task.data')
    assert unlisted.listing == Listing()

    store.list('free')
    other = _caller('user-y', dev_team='team-y', teams=('team-y',), org='org-3', developer_id='initech')
    listed = await ts.resolve_or_start(ADDRESS, other, 'task.data')
    assert listed.rung == 'public' and listed.listing.mode == 'free'
    assert store.asked == []


@pytest.mark.asyncio
async def test_a_subscriber_is_served_and_the_verdict_stands_on_the_control(catalog, engines, store):
    """One question at the start; the next call through the live control inside the window asks none."""
    ts = _server()
    store.publish()
    store.list('subscription')
    store.subscribers.add(('org-2', PIPE))

    control = await ts.resolve_or_start(ADDRESS, _stranger(), 'task.data')
    assert control.rung == 'public' and control.listing == Listing(mode='subscription', plan='Pro')
    assert control.subscription_allowed_at > 0.0

    assert await ts.resolve_or_start(ADDRESS, _stranger(), 'task.data') is control
    assert store.asked == [('org-2', PIPE)]


@pytest.mark.asyncio
async def test_a_live_control_is_asked_again_after_the_window_and_a_refusal_is_never_cached(catalog, engines, store):
    """A lapsed subscription refuses the caller's own live control; subscribing again admits the next call."""
    ts = _server()
    store.publish()
    store.list('subscription')
    store.subscribers.add(('org-2', PIPE))
    control = await ts.resolve_or_start(ADDRESS, _stranger(), 'task.data')

    # The window passed and the subscription lapsed: refused, every time
    _expire(control)
    store.subscribers.clear()
    for _ in range(2):
        with pytest.raises(SubscriptionRequiredError):
            await ts.resolve_or_start(ADDRESS, _stranger(), 'task.data')
    assert len(store.asked) == 3

    # Subscribed again: the next call is admitted and the allow stands
    store.subscribers.add(('org-2', PIPE))
    assert await ts.resolve_or_start(ADDRESS, _stranger(), 'task.data') is control
    assert await ts.resolve_or_start(ADDRESS, _stranger(), 'task.data') is control
    assert len(store.asked) == 4


@pytest.mark.asyncio
async def test_the_publishers_own_org_is_never_asked(catalog, engines, store):
    """A member of the publishing org reaches its paid @public publication without a subscription."""
    ts = _server()
    store.publish()
    store.list('subscription')
    colleague = _caller('user-q', dev_team='team-q', teams=('team-q',), org='org-1')

    control = await ts.resolve_or_start(ADDRESS, colleague, 'task.data')

    assert control.rung == 'public' and control.listing.paid
    assert store.asked == []


@pytest.mark.asyncio
async def test_the_callers_own_rungs_are_never_asked(catalog, engines, store):
    """@me (the caller's own deployment) and @spec (their own Play) of a paid pipe."""
    ts = _server()
    store.deploy('=user/user-a', billing='team-1')
    store.list('subscription')

    mine = await ts.resolve_or_start(ADDRESS, _caller('user-a'), 'task.data')
    assert mine.rung == 'me' and mine.listing.paid
    await ts.stop_task(mine.key)

    played = await _start(ts, _pipeline(), user='user-a')
    assert await ts.resolve_or_start(ADDRESS, _caller('user-a'), 'task.data') is played
    assert store.asked == []


@pytest.mark.asyncio
async def test_a_scoped_key_is_refused_on_a_paid_publication_even_with_a_subscription(catalog, engines, store):
    """permission_denied naming 'account key' (plan 3.8), before anything starts; on a free pipe it is served."""
    ts = _server()
    store.publish()
    store.list('subscription')
    store.subscribers.add(('org-2', PIPE))
    scoped = _stranger(endpoints=[ADDRESS])

    with pytest.raises(PermissionError) as refused:
        await ts.resolve_or_start(ADDRESS, scoped, 'task.data')
    assert refused.value.required == store_gate.ACCOUNT_KEY_REQUIRED
    assert len(ts._engines) == 0 and list(ts._task_control) == []

    store.list('free')
    assert (await ts.resolve_or_start(ADDRESS, scoped, 'task.data')).rung == 'public'


@pytest.mark.asyncio
async def test_the_owners_scoped_key_is_refused_on_their_own_paid_publication(catalog, engines, store):
    """Any publication whose listing is not free: the owner's webhook key included (plan 0 S10)."""
    ts = _server()
    store.deploy('=user/user-a', billing='team-1')
    store.list('paywall')

    with pytest.raises(PermissionError) as refused:
        await ts.resolve_or_start(ADDRESS, _caller('user-a', endpoints=[ADDRESS]), 'task.data')
    assert refused.value.required == 'account key'


# =============================================================================
# THE DAP DOORS, AS THE CLIENT SEES THEM
# =============================================================================


@pytest.mark.asyncio
async def test_submit_by_name_is_refused_with_the_code_on_the_wire(catalog, engines, store):
    """submit(name) answers SUBSCRIPTION_REQUIRED; no byte reaches an engine."""
    ts = _server()
    store.publish()
    store.list('subscription')

    response = await _wire(_conn(ts, _stranger()), 'rrext_submit', name=ADDRESS, data='hello')

    assert response['success'] is False and response['code'] == 'SUBSCRIPTION_REQUIRED'
    assert 'Pro' in response['message'] and '/catalog' in response['message']
    TaskEngine._send_data.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'frame',
    [
        {'subcommand': 'open', 'object': {'name': 'x'}, 'mimeType': 'text/plain'},
        {'subcommand': 'tool', 'tool': 'dialect', 'nodeId': 'db_1', 'input': {}},
    ],
    ids=['open', 'tool'],
)
async def test_a_binding_by_address_is_refused_with_the_code_on_the_wire(catalog, engines, store, frame):
    """send/pipe, the HTTP door (which opens through them) and a standalone tool borrow, by address."""
    ts = _server()
    store.publish()
    store.list('paywall')

    response = await _wire(_conn(ts, _stranger()), 'rrext_process', token=ADDRESS, **frame)

    assert response['success'] is False and response['code'] == 'SUBSCRIPTION_REQUIRED'
    assert list(ts._task_control) == []
    TaskEngine._send_data.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'frame',
    [
        {'subcommand': 'open', 'object': {'name': 'x'}, 'mimeType': 'text/plain'},
        {'subcommand': 'tool', 'tool': 'dialect', 'nodeId': 'db_1', 'input': {}},
    ],
    ids=['open', 'tool'],
)
async def test_a_binding_by_control_id_is_refused_once_the_subscription_lapses(catalog, engines, store, frame):
    """A frame naming the control id reaches no resolver: the control's own verdict answers, re-asked after the window."""
    ts = _server()
    store.publish()
    store.list('subscription')
    store.subscribers.add(('org-2', PIPE))
    conn = _conn(ts, _stranger())
    control = await ts.resolve_or_start(ADDRESS, _stranger(), 'task.data')

    _expire(control)
    store.subscribers.clear()
    response = await _wire(conn, 'rrext_process', token=control.control_id, **frame)

    assert response['success'] is False and response['code'] == 'SUBSCRIPTION_REQUIRED'
    TaskEngine._send_data.assert_not_awaited()
    assert store.asked == [('org-2', PIPE), ('org-2', PIPE)]


@pytest.mark.asyncio
async def test_a_binding_by_control_id_inside_the_window_asks_nothing(catalog, engines, store):
    """No hot-path cost: the verdict the start confirmed answers the open."""
    ts = _server()
    store.publish()
    store.list('subscription')
    store.subscribers.add(('org-2', PIPE))
    control = await ts.resolve_or_start(ADDRESS, _stranger(), 'task.data')

    await store_gate.require_access(control, _stranger())
    await store_gate.require_access(control, _stranger())

    assert store.asked == [('org-2', PIPE)]


@pytest.mark.asyncio
async def test_a_scoped_key_binding_by_control_id_is_refused_on_a_paid_control(catalog, engines, store):
    """The scoped-key refusal stands on the control too, not only on the resolver."""
    control = TaskControl(address=ADDRESS, orgId='org-2', rung='public')
    control.deployment = DeploymentRef(org_id='org-1', team_id='@public', project_id=PIPE)
    control.listing = Listing(mode='subscription')

    with pytest.raises(PermissionError) as refused:
        await store_gate.require_access(control, _stranger(endpoints=[ADDRESS]))
    assert refused.value.required == 'account key'

    # A dev control serves through no publication: nothing is asked of anyone
    dev = TaskControl(address=ADDRESS, orgId='org-2', rung='spec')
    await store_gate.require_access(dev, _stranger(endpoints=[ADDRESS]))
    assert store.asked == []
