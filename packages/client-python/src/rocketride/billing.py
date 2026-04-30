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
Billing API namespace for the RocketRide Python SDK.

Provides typed methods for managing subscriptions, Stripe checkout
sessions, billing portal access, and compute credit wallets via DAP
commands over the existing WebSocket connection.

Usage:
    details = await client.billing.get_details(org_id)
    plans = await client.billing.get_product_prices(product_id)
    balance = await client.billing.get_credit_balance(org_id)
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .types.billing import (
    BillingDetail,
    CreditBalance,
    CreditPack,
    StripePlan,
)

if TYPE_CHECKING:
    from .client import RocketRideClient


class BillingApi:
    """
    Billing and subscription namespace on RocketRideClient.

    Accessed via ``client.billing`` -- not instantiated directly. All methods
    delegate to the parent client's ``call()`` method which handles envelope
    construction, sending, error detection, and tracing.
    """

    def __init__(self, client: RocketRideClient) -> None:
        """
        Bind this namespace to its parent client.

        Args:
            client: The RocketRideClient instance that owns this namespace.
        """
        self._client = client

    # =========================================================================
    # SUBSCRIPTION OPERATIONS
    # =========================================================================

    async def get_details(self, org_id: str) -> list[BillingDetail]:
        """
        Fetch the per-app subscription details for the given org.

        Args:
            org_id: Organisation UUID whose subscriptions to load.

        Returns:
            Array of BillingDetail rows (one per subscribed app).
        """
        body = await self._client.call('rrext_account_billing', subcommand='list', orgId=org_id)
        return body.get('subscriptions', [])

    async def get_product_prices(self, app_id: str) -> list[StripePlan]:
        """
        Fetch the active subscription plans (prices) for an app.

        Plans are returned sorted month-first, year-second, formatted for
        display in the checkout plan picker. The server resolves the app's
        Stripe product internally and calls ``stripe.Price.list()`` so pricing
        changes in the Stripe dashboard are reflected immediately.

        Args:
            app_id: App identifier (e.g. "rocketride.pipeBuilder").

        Returns:
            Array of StripePlan objects ready for display.
        """
        body = await self._client.call('rrext_account_billing', subcommand='prices', appId=app_id)
        return body.get('plans', [])

    async def create_checkout_session(
        self,
        org_id: str,
        app_id: str,
        price_id: str,
    ) -> dict:
        """
        Create a Stripe subscription and return the Stripe Elements client_secret.

        The returned ``clientSecret`` is passed to ``stripe.confirmPayment()`` to
        complete the checkout without a browser redirect to Stripe.

        Args:
            org_id: Organisation UUID to subscribe.
            app_id: App being subscribed (e.g. "brandi").
            price_id: Stripe price_* identifier for the plan.

        Returns:
            Dict with ``clientSecret`` for Stripe Elements and ``subscriptionId``.
        """
        return await self._client.call(
            'rrext_account_billing',
            subcommand='subscribe',
            orgId=org_id,
            appId=app_id,
            priceId=price_id,
        )

    async def create_portal_session(self, org_id: str, return_url: str) -> dict:
        """
        Create a Stripe Billing Portal session for managing payment methods.

        Args:
            org_id: Organisation UUID whose Stripe customer portal to open.
            return_url: URL to redirect the user back to after portal interaction.

        Returns:
            Dict with ``url`` to redirect the user to.
        """
        return await self._client.call(
            'rrext_account_billing',
            subcommand='portal',
            orgId=org_id,
            returnUrl=return_url,
        )

    async def cancel_subscription(self, org_id: str, app_id: str) -> dict:
        """
        Schedule an app subscription for cancellation at the end of the current period.

        The user retains access until the period ends. The webhook handler will
        update ``cancel_at_period_end`` in the database asynchronously.

        Args:
            org_id: Organisation UUID that owns the subscription.
            app_id: App to cancel (e.g. "brandi").

        Returns:
            Dict with ``canceled: True`` on success.
        """
        return await self._client.call(
            'rrext_account_billing',
            subcommand='cancel',
            orgId=org_id,
            appId=app_id,
        )

    # =========================================================================
    # COMPUTE CREDITS WALLET
    # =========================================================================

    async def get_credit_balance(self, org_id: str) -> CreditBalance:
        """
        Read the org's compute credit balance.

        The balance lives in a Redis-backed wallet on the engine side; this
        call is cheap and safe to poll (~1 req/s is fine for a live widget).

        Args:
            org_id: Organisation UUID to query.

        Returns:
            The credit balance with lifetime stats.
        """
        return await self._client.call(
            'rrext_account_billing',
            subcommand='credits_balance',
            orgId=org_id,
        )

    async def list_credit_packs(self) -> list[CreditPack]:
        """
        Load the purchasable credit packs from the Stripe catalog.

        Sourced from the Terraform ``credit_packs`` map so operators
        can add/edit packs without a frontend deploy. Call once on modal mount.

        Returns:
            Array of credit pack pricing rows.
        """
        body = await self._client.call('rrext_account_billing', subcommand='credits_packs')
        return body.get('packs', [])

    async def create_credit_checkout(
        self,
        org_id: str,
        pack_id: str,
        return_url: str,
    ) -> dict:
        """
        Create a one-off Stripe Checkout session for a credit pack purchase.

        The frontend redirects the user to Stripe-hosted checkout; on success
        Stripe redirects back to the app, and the ``checkout.session.completed``
        webhook increments the wallet server-side.

        Args:
            org_id: Organisation UUID that the credits belong to.
            pack_id: Pack key returned by :meth:`list_credit_packs`.
            return_url: Where Stripe sends the user after payment.

        Returns:
            Dict with the Stripe checkout ``url``.
        """
        return await self._client.call(
            'rrext_account_billing',
            subcommand='credits_checkout',
            orgId=org_id,
            packId=pack_id,
            returnUrl=return_url,
        )
