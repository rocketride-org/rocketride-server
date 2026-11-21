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
The store gate: who may call a publication whose listing is not free (plan 0 S9/S10, 8.4).

Two refusals, decided from the listing of the version a publication points at
(``Listing``, read once when the control is created):

- an API key that carries an ``endpoints`` scope is an owner-pays credential
  and is refused on every publication whose listing is not ``free``
  (``permission_denied`` with ``required='account key'``);
- a caller outside the publisher's org with no subscription is refused with
  ``SubscriptionRequiredError`` (``SUBSCRIPTION_REQUIRED``: the address, the
  plan and where to subscribe).

The publisher's own org is never asked for a subscription, nor is a caller on
their own ``@spec`` or ``@me`` rung. A ``free`` listing is never refused.

The decision is made where the publication row is in hand (the resolver,
before an engine starts) and remembered ON THE CONTROL for
``CONST_SPEND_ALLOW_SECONDS``, the credit check's own window: a request inside
the window asks no question, and a refusal is never remembered, so a caller
who subscribes is admitted on the next request. The engine's pipe gate asks
the same question over ``spend.check`` for the bindings the server never sees.
"""

import os
import time
from typing import TYPE_CHECKING, Any, Optional

from ai.account.base import SubscriptionRequiredError

from .task_control import Listing

if TYPE_CHECKING:
    from .task_control import TaskControl

# ==== Constants ================================================================

#: What a scoped key lacked on a paid publication: the ``required`` field of
#: the ``permission_denied`` error body (plan 3.8).
ACCOUNT_KEY_REQUIRED = 'account key'

#: The rungs a caller reaches only as their own: no subscription is asked.
OWN_RUNGS = ('spec', 'me')

#: The catalog page of the hosted deployment, where a caller subscribes.
CATALOG_PATH = '/catalog'


# ==== The facts ================================================================


def store_url() -> str:
    """
    Where a caller subscribes: the catalog of this deployment.

    ``RR_APP_URL`` pins the public origin of the hosted deployment; without
    it the path alone is returned, for the client to resolve against the
    server it called.

    Returns:
        The catalog URL.
    """
    return os.environ.get('RR_APP_URL', '').rstrip('/') + CATALOG_PATH


def needs_subscription(listing: Listing, rung: str, caller_org: str, publisher_org: str) -> bool:
    """
    Whether a call must be backed by a subscription.

    Args:
        listing: The listing of the version that serves the call.
        rung: The rung that answered.
        caller_org: The calling org.
        publisher_org: The org that published the pipe.

    Returns:
        True for a paid listing called from outside the publisher's org on a
        rung that is not the caller's own.
    """
    return listing.paid and rung not in OWN_RUNGS and caller_org != publisher_org


# ==== The refusals =============================================================


def require_account_key(listing: Listing, endpoints: Optional[Any], address: str) -> None:
    """
    Refuse an ``endpoints``-scoped key on a publication that is not free (plan 0 S10).

    A scoped key is the owner-pays credential of a public endpoint: its
    holder is anonymous, so a paid pipe must be called with the caller's own
    account key.

    Args:
        listing: The listing of the version that serves the call.
        endpoints: The key's scope (``AccountInfo.endpoints``); None for an account key.
        address: The address the caller named.

    Raises:
        PermissionError: The key is scoped and the listing is not free;
            ``required`` names what was needed.
    """
    if endpoints is None or not listing.paid:
        return
    error = PermissionError(
        f'{address!r} is a {listing.mode} pipeline: call it with your account key, not a key scoped to endpoints'
    )
    error.required = ACCOUNT_KEY_REQUIRED
    error.address = address
    raise error


async def subscription_refusal(
    listing: Listing, *, rung: str, caller_org: str, publisher_org: str, pipe_name: str, address: str
) -> Optional[SubscriptionRequiredError]:
    """
    Ask the account whether the caller's org holds the subscription a call needs.

    Args:
        listing: The listing of the version that serves the call.
        rung: The rung that answered.
        caller_org: The calling org.
        publisher_org: The org that published the pipe.
        pipe_name: The registry name ``developerId.pipeId`` a subscription is keyed by.
        address: The address the caller named.

    Returns:
        The refusal, or None when the call needs no subscription or has one.
    """
    from ai.account import account

    if not needs_subscription(listing, rung, caller_org, publisher_org):
        return None
    if await account.has_subscription(caller_org, pipe_name):
        return None
    url = store_url()
    plan = f' (plan {listing.plan!r})' if listing.plan else ''
    return SubscriptionRequiredError(
        f'{pipe_name!r} needs a subscription{plan}: subscribe at {url} ({address})',
        address=address,
        plan=listing.plan,
        store_url=url,
    )


# ==== The gate on a control ====================================================


def _publication_of(control: 'TaskControl') -> Optional[tuple]:
    """The ``(publisher org, registry name)`` a control serves through, or None for a dev run."""
    deployment = control.deployment
    if deployment is None:
        return None
    return deployment.org_id, deployment.project_id


async def control_refusal(control: 'TaskControl') -> Optional[SubscriptionRequiredError]:
    """
    Why a control's caller may not use its paid listing, or None: the cached subscription verdict.

    One account question per control per ``CONST_SPEND_ALLOW_SECONDS``; an
    allow is remembered on the control, a refusal never is.

    Args:
        control: The resolved control; its org is the calling org.

    Returns:
        The refusal, or None.
    """
    publication = _publication_of(control)
    if publication is None or not control.listing.paid:
        return None
    publisher_org, pipe_name = publication
    if not needs_subscription(control.listing, control.rung, control.orgId, publisher_org):
        return None
    # Step 1: a recent confirmation answers without asking
    now = time.monotonic()
    if control.subscription_allowed(now):
        return None
    # Step 2: ask the account; remember a confirmation only
    refusal = await subscription_refusal(
        control.listing,
        rung=control.rung,
        caller_org=control.orgId,
        publisher_org=publisher_org,
        pipe_name=pipe_name,
        address=control.address,
    )
    if refusal is None:
        control.subscription_allowed_at = now
    return refusal


async def require_access(control: 'TaskControl', account_info: Any) -> None:
    """
    Refuse a request on a control whose paid listing the caller may not use.

    The gate of every door that starts a binding (plan 0 S9): a name call
    resolves through it, and so does an open or a standalone tool call that
    names a control id.

    Args:
        control: The resolved control.
        account_info: The request's account (its ``endpoints`` scope is the key's).

    Raises:
        PermissionError: A scoped key on a paid publication.
        SubscriptionRequiredError: The caller's org holds no subscription.
    """
    if control.deployment is None or not control.listing.paid:
        return
    require_account_key(control.listing, getattr(account_info, 'endpoints', None), control.address)
    refusal = await control_refusal(control)
    if refusal is not None:
        raise refusal
