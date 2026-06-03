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

from typing import Literal, NotRequired, TypedDict


# =============================================================================
# SUBSCRIPTION TYPES
# =============================================================================


class BillingDetail(TypedDict):
    """
    Per-app subscription detail row returned by the ``rrext_account_billing``
    ``list`` subcommand. One row per subscribed app.

    Attributes:
        appId: App identifier matching AppManifestEntry.appId (e.g. "rocketride.brandy").
        stripeSubscriptionId: Stripe sub_* subscription identifier.
        stripePriceId: Stripe price_* for the subscribed plan.
        status: One of: active, trialing, past_due, canceled.
        planNickname: Human-readable plan name from Stripe price (e.g. "Pro Monthly"), or None.
        unitAmount: Price in USD cents for the subscribed plan, or None.
        billingInterval: Billing interval ("month" or "year"), or None.
        currentPeriodStart: ISO 8601 datetime when the current billing period started, or None.
        currentPeriodEnd: ISO 8601 datetime when the current billing period ends, or None.
        cancelAtPeriodEnd: True when the user has requested cancellation at period end.
        credits: Credit grants config from Stripe price metadata, or None.
        creditLabels: Display templates for credit resource types, or None.
    """

    appId: str
    stripeSubscriptionId: str
    stripePriceId: str
    status: str
    planNickname: str | None
    unitAmount: int | None
    billingInterval: str | None
    currentPeriodStart: str | None
    currentPeriodEnd: str | None
    cancelAtPeriodEnd: bool
    credits: dict[str, dict[str, int]] | None
    creditLabels: dict[str, str] | None


class PlanAction(TypedDict):
    """
    Alternative click action for a plan card. Plans without an action
    proceed to Stripe checkout. Plans with an action navigate the user
    elsewhere (e.g. GitHub repo for free tier, mailto for enterprise).

    Attributes:
        type: ``link`` opens a URL, ``mailto`` opens email compose.
        url: Target URL (for ``link``) or email address (for ``mailto``).
        subject: Optional email subject line (only for ``mailto``).
        label: Button label shown on the card (e.g. "Get started", "Contact us").
    """

    type: Literal['link', 'mailto']
    url: str
    subject: NotRequired[str]
    label: str


class StripePlan(TypedDict):
    """
    Stripe plan/price row for a given product, returned by the ``prices``
    subcommand. Used in the checkout plan picker.

    Attributes:
        priceId: Stripe price_* identifier.
        label: Human-readable label shown in the plan selector (e.g. "Starter", "Pro").
        amount: Display price string (e.g. "$29", "$290", "Free", "Custom").
        cents: Price in USD cents.
        currency: ISO currency code.
        interval: Billing interval: "month", "year", or empty for non-recurring plans.
        description: Feature description lines from Stripe price metadata, or None.
        action: Alternative click action (link/mailto). None means normal checkout.
        order: Sort order for card positioning. Lower values appear first. Defaults to 500.
        credits: Credit grants config from Stripe price metadata, or None.
        labels: Display templates for credit resource types, or None.
    """

    priceId: str
    label: str
    amount: str
    cents: int
    currency: str
    interval: Literal['month', 'year', '']
    description: NotRequired[list[str] | None]
    action: NotRequired[PlanAction | None]
    order: NotRequired[int]
    credits: NotRequired[dict[str, dict[str, int]] | None]
    labels: NotRequired[dict[str, str] | None]


# =============================================================================
# COMPUTE CREDITS TYPES
# =============================================================================


class CreditBalance(TypedDict):
    """
    Multi-resource credit balance for an organisation's wallet.

    Returned by the ``credits_balance`` subcommand. Each field is a dict
    keyed by resource type (e.g. ``{"tokens": 4200, "video": 80}``).

    Attributes:
        balances: Current unspent balances per resource type.
        lifetimePurchased: Total purchased per resource type.
        lifetimeConsumed: Total consumed per resource type.
        labels: Human-readable display templates per resource type, from Stripe
            price metadata. Supports ``{amount}`` substitution. Falls back to
            the raw resource key when a label is not configured.
    """

    balances: dict[str, int]
    lifetimePurchased: dict[str, int]
    lifetimeConsumed: dict[str, int]
    labels: dict[str, str]


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
