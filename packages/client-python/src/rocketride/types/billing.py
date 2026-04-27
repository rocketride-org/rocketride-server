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
Billing Type Definitions for the RocketRide Python SDK.

Data shapes for subscription management, compute credits, and Stripe
integration. These mirror the server's DAP response shapes and the
TypeScript SDK's ``types/billing.ts`` definitions.

Types Defined:
    BillingDetail: Per-app subscription detail row.
    StripePlan: Stripe plan/price row for a given product.
    CreditBalance: Current credit balance for an org's compute wallet.
    CreditPack: Per-pack pricing row for the credit top-up modal.
"""

from typing import Literal, TypedDict


# =============================================================================
# SUBSCRIPTION TYPES
# =============================================================================


class BillingDetail(TypedDict):
    """
    Per-app subscription detail row returned by the ``rrext_account_billing``
    ``list`` subcommand. One row per subscribed app.

    Attributes:
        appId: App identifier matching AppManifestEntry.id (e.g. "brandi").
        stripeSubscriptionId: Stripe sub_* subscription identifier.
        stripePriceId: Stripe price_* for the subscribed plan.
        status: One of: active, trialing, past_due, canceled.
        currentPeriodEnd: ISO 8601 datetime when the current billing period ends, or None.
        cancelAtPeriodEnd: True when the user has requested cancellation at period end.
    """

    appId: str
    stripeSubscriptionId: str
    stripePriceId: str
    status: str
    currentPeriodEnd: str | None
    cancelAtPeriodEnd: bool


class StripePlan(TypedDict):
    """
    Stripe plan/price row for a given product, returned by the ``prices``
    subcommand. Used in the checkout plan picker.

    Attributes:
        priceId: Stripe price_* identifier.
        interval: Billing interval: "month" or "year".
        unitAmount: Price in USD cents.
        nickname: Human-readable nickname, e.g. "Pro Monthly".
    """

    priceId: str
    interval: Literal['month', 'year']
    unitAmount: int
    nickname: str


# =============================================================================
# COMPUTE CREDITS TYPES
# =============================================================================


class CreditBalance(TypedDict):
    """
    Current credit balance for an organisation's compute wallet.

    Returned by the ``credits_balance`` subcommand.

    Attributes:
        balance: Current unspent credit balance for the org.
        lifetime_purchased: Total credits ever purchased.
        lifetime_consumed: Total credits ever consumed.
    """

    balance: int
    lifetime_purchased: int
    lifetime_consumed: int


class CreditPack(TypedDict):
    """
    Per-pack pricing row for the credit top-up modal.

    Mirrors the output of the Terraform ``credit_packs`` map so operators
    can add/edit packs without a frontend deploy.

    Attributes:
        packId: Terraform key ("small", "medium", "large").
        priceId: Stripe price_* identifier for the one-off pack.
        usdCents: Cost of the pack in USD cents.
        credits: Credits added to the wallet on successful purchase.
        nickname: Human-readable label, e.g. "55k credits (10% bonus)".
    """

    packId: str
    priceId: str
    usdCents: int
    credits: int
    nickname: str
