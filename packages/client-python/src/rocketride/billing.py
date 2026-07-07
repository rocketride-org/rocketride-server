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
    plans = await client.billing.get_product_prices(app_id)
    balance = await client.billing.get_credit_balance(org_id)
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .types.billing import (
    AppPrice,
    BillingDetail,
    CreditBalance,
    CreditPack,
    PromoRedemption,
    PromoValidation,
    TransactionsResult,
    UsageRollup,
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

    async def get_product_prices(self, app_id: str) -> list[AppPrice]:
        """
        Fetch the active subscription plans (prices) for an app.

        Plans are returned sorted month-first, year-second, formatted for
        display in the checkout plan picker. The server resolves the app's
        Stripe product internally and calls ``stripe.Price.list()`` so pricing
        changes in the Stripe dashboard are reflected immediately.

        Args:
            app_id: App identifier (e.g. "rocketride.pipeBuilder").

        Returns:
            Array of AppPrice rows from the local database.
        """
        body = await self._client.call('rrext_account_billing', subcommand='prices', appId=app_id)
        return body.get('plans', [])

    async def create_checkout_session(
        self,
        org_id: str,
        app_id: str,
        price_id: str,
        promotion_code: str | None = None,
    ) -> dict:
        """
        Create a Stripe subscription and return the Stripe Elements client_secret.

        The returned ``clientSecret`` is passed to ``stripe.confirmPayment()`` to
        complete the checkout without a browser redirect to Stripe.

        ``clientSecret`` is None when the first invoice is $0 (e.g. a 100%-off
        promotion code) — the subscription is already active and no payment
        step is needed.

        Args:
            org_id: Organisation UUID to subscribe.
            app_id: App being subscribed (e.g. "brandi").
            price_id: Stripe price_* identifier for the plan.
            promotion_code: Optional promo code to apply (validated server-side).

        Returns:
            Dict with ``clientSecret`` (or None), ``subscriptionId``, and ``status``.
        """
        kwargs: dict = {
            'subcommand': 'subscribe',
            'orgId': org_id,
            'appId': app_id,
            'priceId': price_id,
        }
        if promotion_code:
            kwargs['promotionCode'] = promotion_code
        return await self._client.call('rrext_account_billing', **kwargs)

    async def validate_promo_code(
        self,
        org_id: str,
        code: str,
        price_id: str | None = None,
    ) -> PromoValidation:
        """
        Resolve a promo code without side effects.

        An unknown or expired code returns ``{'valid': False, 'reason': ...}``
        — it never raises. Pass ``price_id`` to also get the discounted
        first-invoice amount for the selected plan.

        Args:
            org_id: Organisation UUID (context only — validation is global).
            code: Customer-facing code string (case-insensitive).
            price_id: Optional plan to compute ``discountedAmountCents`` against.

        Returns:
            Promo validation result.
        """
        kwargs: dict = {
            'subcommand': 'promo_validate',
            'orgId': org_id,
            'code': code,
        }
        if price_id:
            kwargs['priceId'] = price_id
        return await self._client.call('rrext_account_billing', **kwargs)

    async def redeem_promo_code(self, org_id: str, code: str) -> PromoRedemption:
        """
        Redeem a credit-grant (hackathon) code for the caller's org.

        Creates a $0 subscription for the app named in the code's metadata
        (no payment method required) and grants the metadata-defined credits
        immediately. If the org is already subscribed to the app, only the
        credits are granted (``mode: 'credits_only'``). Discount-only codes
        are rejected — those are applied during checkout instead.

        Any authenticated org member may redeem; the server derives the org
        from the caller's own membership.

        Args:
            org_id: Organisation UUID (context only — server uses the caller's org).
            code: Customer-facing code string (case-insensitive).

        Returns:
            Redemption result with mode and granted credits.
        """
        return await self._client.call(
            'rrext_account_billing',
            subcommand='promo_redeem',
            orgId=org_id,
            code=code,
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

    async def upgrade_subscription(
        self,
        org_id: str,
        app_id: str,
        new_price_id: str,
    ) -> dict:
        """
        Upgrade (or downgrade) an existing subscription to a different plan.

        The server swaps the Stripe subscription item to the new price and
        handles proration automatically. The local database row is updated
        before the response is returned.

        Args:
            org_id: Organisation UUID that owns the subscription.
            app_id: App whose plan is changing.
            new_price_id: Stripe price_* identifier for the target plan.

        Returns:
            Dict with ``status``, ``subscriptionId``, ``newPriceId``,
            ``planNickname``, ``unitAmount``, ``billingInterval``.
        """
        return await self._client.call(
            'rrext_account_billing',
            subcommand='upgrade',
            orgId=org_id,
            appId=app_id,
            newPriceId=new_price_id,
        )

    # =========================================================================
    # TOP-UP PURCHASE
    # =========================================================================

    async def purchase_topup(self, org_id: str, price_id: str) -> dict:
        """
        Purchase a top-up pack by charging the customer's card on file.

        On success, credits are applied to the ledger immediately.

        Args:
            org_id: Organisation UUID.
            price_id: Stripe price_* identifier for the top-up plan.

        Returns:
            Dict with ``status`` ('succeeded' or 'requires_action') and
            optionally ``clientSecret`` for 3DS.
        """
        return await self._client.call(
            'rrext_account_billing',
            subcommand='purchase_topup',
            orgId=org_id,
            priceId=price_id,
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

    # =========================================================================
    # TRANSACTIONS & USAGE
    # =========================================================================

    async def get_transactions(
        self,
        org_id: str,
        scope: str = 'org',
        scope_id: str | None = None,
        page: int = 1,
        page_size: int = 50,
        since: str | None = None,
    ) -> TransactionsResult:
        """
        Fetch paginated transaction detail from the credit ledger.

        Args:
            org_id: Organisation UUID.
            scope: ``org``, ``team``, or ``user``.
            scope_id: Team or user ID when scope is not ``org``.
            page: 1-based page number.
            page_size: Rows per page (max 100).
            since: ISO datetime string -- only return rows at or after this time.

        Returns:
            Paginated transaction result.
        """
        kwargs: dict = {
            'subcommand': 'transactions',
            'orgId': org_id,
            'scope': scope,
            'page': page,
            'pageSize': page_size,
        }
        if scope_id:
            kwargs['scopeId'] = scope_id
        if since:
            kwargs['since'] = since
        return await self._client.call('rrext_account_billing', **kwargs)

    async def get_usage_by_user(self, org_id: str) -> list[UsageRollup]:
        """
        Fetch per-user consumption rollup for an org.

        Args:
            org_id: Organisation UUID.

        Returns:
            List of usage rollup rows ordered by total consumption descending.
        """
        body = await self._client.call('rrext_account_billing', subcommand='usage_by_user', orgId=org_id)
        return body.get('usage', [])

    async def get_usage_by_team(self, org_id: str) -> list[UsageRollup]:
        """
        Fetch per-team consumption rollup for an org.

        Args:
            org_id: Organisation UUID.

        Returns:
            List of usage rollup rows ordered by total consumption descending.
        """
        body = await self._client.call('rrext_account_billing', subcommand='usage_by_team', orgId=org_id)
        return body.get('usage', [])

    # =========================================================================
    # CREDIT PACK CHECKOUT
    # =========================================================================

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
