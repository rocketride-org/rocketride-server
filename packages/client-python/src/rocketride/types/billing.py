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
    PromoValidation: Result of resolving a promo code.
    PromoRedemption: Result of redeeming a credit-grant code.
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


class AppPrice(TypedDict):
    """
    App pricing tier row from the ``app_prices`` table.

    Returned by the ``prices`` subcommand. Used in the checkout plan picker.

    Attributes:
        id: Internal price UUID.
        appId: App identifier.
        stripePriceId: Stripe price_* identifier.
        nickname: Human-readable tier label (e.g. "Starter", "Pro").
        amountCents: Price in smallest currency unit (e.g. cents for USD).
        currency: ISO 4217 currency code.
        interval: Billing interval: "month", "year", or "one_time".
        metadata: Full plan metadata (description, action, order, kind, credits, etc.).
        isActive: Whether the price is active.
        createdAt: ISO 8601 creation timestamp, or None.
    """

    id: str
    appId: str
    stripePriceId: str
    nickname: str
    amountCents: int
    currency: str
    interval: Literal['month', 'year', 'one_time', '']
    metadata: NotRequired[dict | None]
    isActive: bool
    createdAt: str | None


# Backward compatibility alias
StripePlan = AppPrice


# =============================================================================
# COMPUTE CREDITS TYPES
# =============================================================================


class CreditBalance(TypedDict):
    """
    Net credit balance for an organisation, grouped by resource.

    Returned by the ``credits_balance`` subcommand. Balance is computed from
    ``SUM(amount) GROUP BY resource`` on the credit ledger.

    Attributes:
        balances: Net balance per resource type (positive = remaining, negative = overspent).
        labels: Human-readable display templates per resource type, from Stripe
            price metadata. Supports ``{amount}`` substitution. Falls back to
            the raw resource key when a label is not configured.
    """

    balances: dict[str, float]
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


# =============================================================================
# PROMO CODE TYPES
# =============================================================================


class PromoValidation(TypedDict):
    """
    Result of resolving a promo code via the ``promo_validate`` subcommand.

    ``valid: False`` carries a human-readable ``reason``. A grant/hackathon
    code is recognisable by ``appId`` + ``creditsGranted``; a discount-only
    code has neither and applies to whichever plan is selected at checkout.

    Attributes:
        valid: Whether the code resolved to an active Stripe promotion code.
        reason: Human-readable failure reason when ``valid`` is False.
        code: Canonical code string as stored in Stripe.
        promotionCodeId: Stripe promo_* identifier (informational).
        description: Human-readable description, e.g. "25% off for 3 months".
        percentOff: Percentage discount (e.g. 25 or 100), if percent-based.
        amountOffCents: Fixed discount in cents, if amount-based.
        currency: ISO currency for ``amountOffCents``.
        duration: Coupon duration: 'once' | 'repeating' | 'forever'.
        durationInMonths: Months the discount repeats for.
        creditsGranted: Credits granted on redemption ({resource: amount}).
        appId: Target app for a grant code.
        amountCents: List price in cents of the plan passed as priceId.
        discountedAmountCents: First-invoice price in cents after the discount.
    """

    valid: bool
    reason: NotRequired[str]
    code: NotRequired[str]
    promotionCodeId: NotRequired[str]
    description: NotRequired[str]
    percentOff: NotRequired[float | None]
    amountOffCents: NotRequired[int | None]
    currency: NotRequired[str | None]
    duration: NotRequired[str | None]
    durationInMonths: NotRequired[int | None]
    creditsGranted: NotRequired[dict[str, float] | None]
    appId: NotRequired[str | None]
    amountCents: NotRequired[int]
    discountedAmountCents: NotRequired[int]


class PromoRedemption(TypedDict):
    """
    Result of redeeming a credit-grant code via the ``promo_redeem`` subcommand.

    Attributes:
        redeemed: True when the redemption succeeded.
        mode: 'subscribed' = new $0 subscription created;
            'credits_only' = org was already subscribed.
        appId: App the code targets.
        status: Subscription status after redemption (e.g. 'active').
        credits: Credits granted ({resource: amount}).
    """

    redeemed: bool
    mode: Literal['subscribed', 'credits_only']
    appId: str
    status: NotRequired[str]
    credits: dict[str, float]


# =============================================================================
# TRANSACTION TYPES
# =============================================================================


class LedgerTransaction(TypedDict):
    """
    A single ledger transaction row returned by the ``transactions`` subcommand.

    Attributes:
        id: Auto-increment row ID.
        type: Transaction type (purchase, usage, credit, refund, etc.).
        resource: Resource type (e.g. cpu_utilization, gpu_memory, tokens).
        amount: Signed amount (positive for credits, negative for debits).
        idempotencyKey: Namespaced dedup key.
        userId: User who triggered the transaction, or None.
        teamId: Team context, or None.
        context: Human-readable audit context, or None.
        createdAt: ISO 8601 creation timestamp, or None.
    """

    id: int
    type: str
    resource: str
    amount: float
    idempotencyKey: str
    userId: str | None
    teamId: str | None
    context: dict | None
    createdAt: str | None


class TransactionsResult(TypedDict):
    """
    Paginated result from the ``transactions`` subcommand.

    Attributes:
        transactions: Transaction rows for the current page.
        total: Total matching rows (for pagination).
        page: Current page number (1-based).
        pageSize: Rows per page.
    """

    transactions: list[LedgerTransaction]
    total: int
    page: int
    pageSize: int


class UsageRollup(TypedDict):
    """
    Per-user or per-team consumption rollup row.

    Returned by ``usage_by_user`` / ``usage_by_team`` subcommands.

    Attributes:
        id: User or team ID (or '__none__' for unattributed).
        credits: Consumption per resource type (absolute values).
    """

    id: str
    credits: dict[str, float]
