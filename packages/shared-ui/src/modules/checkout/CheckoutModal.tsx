// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CheckoutModal — host-agnostic Stripe Elements checkout.
 *
 * Two-step modal:
 *   1. **Plan picker** — delegates to the shared ``PlanPicker`` component.
 *   2. **Payment form** — Stripe Elements collects and confirms payment.
 *
 * All server communication flows through callback props — no SDK imports.
 */

import React, { useEffect, useState, useCallback, useMemo, useRef, type CSSProperties } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { commonStyles } from '../../themes/styles';
import { PlanPicker, planAmount } from './PlanPicker';
import type { CheckoutModalProps, CheckoutPlan, PromoValidation } from './types';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	// ── Modal shell ──────────────────────────────────────────────────────
	modal: {
		backgroundColor: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 16,
		width: '100%',
		maxWidth: 960,
		overflow: 'hidden',
		boxShadow: '0 24px 64px var(--rr-shadow-widget)',
		position: 'relative' as const,
	} as CSSProperties,

	closeBtn: {
		position: 'absolute' as const,
		top: 14,
		right: 14,
		background: 'none',
		border: 'none',
		fontSize: 22,
		cursor: 'pointer',
		color: 'var(--rr-text-secondary)',
		lineHeight: 1,
		padding: '2px 6px',
		zIndex: 1,
	} as CSSProperties,

	// ── Header banner ────────────────────────────────────────────────────
	header: {
		padding: '28px 32px 20px',
		borderBottom: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-titleBar-inactive)',
	} as CSSProperties,

	appName: {
		fontSize: 20,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		margin: 0,
	} as CSSProperties,

	appDesc: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		margin: '4px 0 0',
		lineHeight: 1.5,
	} as CSSProperties,

	// ── Body ─────────────────────────────────────────────────────────────
	body: {
		padding: '24px 32px 32px',
	} as CSSProperties,

	// ── Buttons ──────────────────────────────────────────────────────────
	continueBtn: (disabled: boolean): CSSProperties => ({
		width: '100%',
		padding: '13px 0',
		borderRadius: 8,
		border: 'none',
		backgroundColor: disabled ? 'var(--rr-border)' : 'var(--rr-brand)',
		color: 'var(--rr-fg-button)',
		fontSize: 15,
		fontWeight: 600,
		cursor: disabled ? 'not-allowed' : 'pointer',
		transition: 'background-color 0.15s',
	}),

	submitBtn: (disabled: boolean): CSSProperties => ({
		width: '100%',
		padding: '13px 0',
		borderRadius: 8,
		border: 'none',
		backgroundColor: disabled ? 'var(--rr-border)' : 'var(--rr-brand)',
		color: 'var(--rr-fg-button)',
		fontSize: 15,
		fontWeight: 600,
		cursor: disabled ? 'not-allowed' : 'pointer',
		marginTop: 20,
		transition: 'background-color 0.15s',
	}),

	backBtn: {
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		color: 'var(--rr-text-secondary)',
		fontSize: 13,
		padding: '0 0 16px',
		display: 'block',
	} as CSSProperties,

	error: {
		color: 'var(--rr-color-error)',
		fontSize: 13,
		marginBottom: 12,
	} as CSSProperties,

	status: {
		textAlign: 'center' as const,
		color: 'var(--rr-text-secondary)',
		fontSize: 14,
		padding: '32px 0',
	} as CSSProperties,

	// ── Plan recap shown above the payment form ──────────────────────────
	planRecap: {
		padding: '12px 14px',
		borderRadius: 10,
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-titleBar-inactive)',
		marginBottom: 16,
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
	} as CSSProperties,

	planRecapName: {
		fontSize: 14,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	planRecapAmount: {
		fontSize: 14,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	planRecapStrike: {
		textDecoration: 'line-through',
		marginRight: 8,
	} as CSSProperties,

	planRecapNow: {
		color: 'var(--rr-text-primary)',
		fontWeight: 700,
	} as CSSProperties,

	renewNote: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		textAlign: 'center' as const,
		marginTop: 10,
	} as CSSProperties,

	// ── Promo code box (step 1, under the plan cards) ────────────────────
	promoRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		margin: '2px 0 14px',
	} as CSSProperties,

	promoLabel: {
		fontSize: 13,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		whiteSpace: 'nowrap' as const,
	} as CSSProperties,

	promoInput: {
		flex: 1,
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		padding: '9px 12px',
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		background: 'var(--rr-bg-paper)',
		outline: 'none',
	} as CSSProperties,

	promoApplyBtn: (disabled: boolean): CSSProperties => ({
		padding: '9px 18px',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		fontSize: 13,
		fontWeight: 600,
		background: 'var(--rr-bg-titleBar-inactive)',
		color: 'var(--rr-text-primary)',
		cursor: disabled ? 'not-allowed' : 'pointer',
		opacity: disabled ? 0.6 : 1,
	}),

	promoApplied: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		margin: '2px 0 14px',
		padding: '9px 12px',
		border: '1px solid var(--rr-color-success)',
		background: 'color-mix(in srgb, var(--rr-color-success) 8%, var(--rr-bg-paper))',
		borderRadius: 8,
		fontSize: 13,
	} as CSSProperties,

	promoAppliedCode: {
		fontWeight: 700,
		letterSpacing: 0.5,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	promoAppliedDesc: {
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

	promoRemoveBtn: {
		marginLeft: 'auto',
		background: 'none',
		border: 'none',
		cursor: 'pointer',
		color: 'var(--rr-text-secondary)',
		fontSize: 12,
		textDecoration: 'underline',
		padding: 0,
	} as CSSProperties,

	promoError: {
		fontSize: 12.5,
		color: 'var(--rr-color-error)',
		margin: '-8px 0 14px',
	} as CSSProperties,

	// ── Grant-code success block (no payment path) ───────────────────────
	successBlock: {
		textAlign: 'center' as const,
		padding: '34px 20px 10px',
	} as CSSProperties,

	successMark: {
		width: 44,
		height: 44,
		borderRadius: '50%',
		background: 'color-mix(in srgb, var(--rr-color-success) 8%, var(--rr-bg-paper))',
		border: '2px solid var(--rr-color-success)',
		color: 'var(--rr-color-success)',
		fontSize: 22,
		fontWeight: 700,
		display: 'inline-flex',
		alignItems: 'center',
		justifyContent: 'center',
		marginBottom: 14,
	} as CSSProperties,

	successTitle: {
		fontSize: 17,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		margin: 0,
	} as CSSProperties,

	successText: {
		fontSize: 13.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 8,
		lineHeight: 1.6,
	} as CSSProperties,

	successCredits: {
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,
};

// =============================================================================
// PROMO HELPERS
// =============================================================================

/**
 * First-invoice cents for a plan after applying a validated discount code.
 *
 * Prefers the server-computed `discountedAmountCents` (returned when the code
 * was validated against this plan's price) so the displayed amount always
 * matches the backend; local math is the fallback when the code was validated
 * without a plan selected.
 */
function discountedCents(plan: CheckoutPlan, promo: PromoValidation): number {
	if (typeof promo.discountedAmountCents === 'number') {
		return Math.max(0, promo.discountedAmountCents);
	}
	const cents = plan.amountCents || 0;
	if (promo.percentOff) return Math.max(0, Math.round(cents * (1 - promo.percentOff / 100)));
	if (promo.amountOffCents) return Math.max(0, cents - promo.amountOffCents);
	return cents;
}

/** Format cents as a display price string (e.g. 2175 → "$21.75"). */
function formatCents(cents: number, currency?: string | null): string {
	const symbol = currency?.toUpperCase() === 'EUR' ? '€' : '$';
	const amount = cents / 100;
	return amount === Math.floor(amount) ? `${symbol}${amount}` : `${symbol}${amount.toFixed(2)}`;
}

/** Short interval suffix for a plan ("/mo", "/yr", or ""). */
function intervalSuffix(plan: CheckoutPlan): string {
	return plan.interval === 'month' ? '/mo' : plan.interval === 'year' ? '/yr' : '';
}

/** Format a credits grant for display (e.g. {tokens: 10000} → "10,000 tokens"). */
function formatCredits(credits: Record<string, number>): string {
	return Object.entries(credits)
		.map(([resource, amount]) => `${amount.toLocaleString()} ${resource}`)
		.join(', ');
}

// =============================================================================
// PAYMENT FORM (inner — needs Stripe context from <Elements>)
// =============================================================================

/** @internal */
interface PaymentFormProps {
	plan: CheckoutPlan;
	subscriptionId: string;
	/** Validated discount code applied to this checkout, if any. */
	promo?: PromoValidation | null;
	onConfirmPending: (subscriptionId: string, priceId: string) => Promise<void>;
	onSuccess: () => void;
	onError: (msg: string) => void;
	onBack: () => void;
}

/**
 * Stripe Elements payment form shown after the user has selected a plan.
 * Must be rendered inside an ``<Elements>`` provider with a valid ``clientSecret``.
 */
const PaymentForm: React.FC<PaymentFormProps> = ({ plan, subscriptionId, promo, onConfirmPending, onSuccess, onError, onBack }) => {
	const stripe = useStripe();
	const elements = useElements();
	const [submitting, setSubmitting] = useState(false);

	/** Confirms the Stripe payment, then notifies the server. */
	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (!stripe || !elements) return;

			setSubmitting(true);
			try {
				// Step 1: Confirm the Stripe payment
				const { error } = await stripe.confirmPayment({
					elements,
					confirmParams: { return_url: window.location.origin },
					redirect: 'if_required',
				});

				if (error) {
					onError(error.message ?? 'Payment failed. Please try again.');
					return;
				}

				// Step 2: Notify server — writes 'incomplete', webhook flips to 'active'
				try {
					await onConfirmPending(subscriptionId, plan.stripePriceId);
				} catch {
					// Non-fatal — the webhook will still update the DB
				}

				// Step 3: Close the modal
				onSuccess();
			} catch (err: any) {
				onError(err.message ?? 'An unexpected error occurred.');
			} finally {
				setSubmitting(false);
			}
		},
		[stripe, elements, subscriptionId, plan, onConfirmPending, onSuccess, onError]
	);

	// Discounted first-payment display when a discount code is applied
	const discounted = promo ? discountedCents(plan, promo) : null;
	const payLabel = discounted !== null ? formatCents(discounted, plan.currency) : planAmount(plan);

	return (
		<>
			<button style={S.backBtn} onClick={onBack}>&#8592; Change plan</button>

			{/* Plan recap bar (struck-through list price when discounted) */}
			<div style={S.planRecap}>
				<span style={S.planRecapName}>
					{plan.nickname}
					{promo?.code && <span style={{ fontWeight: 400, color: 'var(--rr-text-secondary)' }}> &middot; {promo.code} applied</span>}
				</span>
				<span style={S.planRecapAmount}>
					{discounted !== null ? (
						<>
							<span style={S.planRecapStrike}>{planAmount(plan)}</span>
							<span style={S.planRecapNow}>{payLabel}{intervalSuffix(plan)}</span>
						</>
					) : (
						planAmount(plan)
					)}
				</span>
			</div>

			<form onSubmit={handleSubmit}>
				<PaymentElement options={{ wallets: { link: 'never' } }} />
				<button type="submit" disabled={!stripe || submitting} style={S.submitBtn(!stripe || submitting)}>
					{submitting ? 'Processing\u2026' : `Subscribe \u2014 ${payLabel}`}
				</button>
			</form>

			{/* One-off discounts revert to the list price on renewal */}
			{promo?.duration === 'once' && (
				<p style={S.renewNote}>Renews at {planAmount(plan)}{intervalSuffix(plan)}.</p>
			)}
		</>
	);
};

// =============================================================================
// CHECKOUT MODAL
// =============================================================================

/**
 * Two-step checkout modal: PlanPicker (step 1) then Stripe Elements (step 2).
 *
 * All server communication is via callback props — no SDK imports.
 */
export const CheckoutModal: React.FC<CheckoutModalProps> = ({
	appName,
	appDescription,
	stripePublishableKey,
	preselectedPlan,
	onFetchPlans,
	onCreateCheckout,
	onConfirmPending,
	onValidatePromoCode,
	onRedeemPromoCode,
	onSuccess,
	onClose,
	onActionClick,
}) => {
	// Initialise Stripe lazily
	const [stripePromise] = useState(() => loadStripe(stripePublishableKey));

	// ── State ────────────────────────────────────────────────────────────
	const [plans, setPlans] = useState<CheckoutPlan[]>([]);
	const [plansLoading, setPlansLoading] = useState(true);
	// Seed the selection from a preselected plan so the payment step can render
	// its recap immediately (and the picker is skipped — see the auto-advance
	// effect below).
	const [selectedPlan, setSelectedPlan] = useState<CheckoutPlan | null>(preselectedPlan ?? null);

	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [subscriptionId, setSubscriptionId] = useState<string>('');
	const [loadingSecret, setLoadingSecret] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// ── Promo code state ─────────────────────────────────────────────────
	const promoEnabled = Boolean(onValidatePromoCode);
	const [promoInput, setPromoInput] = useState('');
	const [appliedPromo, setAppliedPromo] = useState<PromoValidation | null>(null);
	const [promoBusy, setPromoBusy] = useState(false);
	const [promoError, setPromoError] = useState<string | null>(null);
	// Set after a grant/hackathon code redeems — renders the success block
	const [grantResult, setGrantResult] = useState<{
		code: string;
		credits: Record<string, number>;
		mode: 'subscribed' | 'credits_only';
	} | null>(null);

	// ── Fetch plans on mount ─────────────────────────────────────────────
	useEffect(() => {
		onFetchPlans()
			.then((fetched) => {
				// Filter out top-up packs (handled by the TopUpModal) and hidden
				// promo-base plans (only reachable via promo-code redemption)
				const subscriptionPlans = fetched.filter(
					(p) => p.metadata?.kind !== 'topup' && p.metadata?.kind !== 'promo_base' && p.isActive !== false,
				);
				setPlans(subscriptionPlans);
				// Default selection (lowest-order billable plan at the visible
				// interval -- i.e. Starter) is driven by PlanPicker via
				// ``autoSelectDefault`` so the selection always matches the
				// interval that is actually shown.
			})
			.catch((err) => setError(err.message ?? 'Failed to load subscription plans.'))
			.finally(() => setPlansLoading(false));
	}, [onFetchPlans]);

	/** Creates a Stripe subscription and advances to payment. */
	const handleContinue = useCallback(async () => {
		// promoBusy guard: never start checkout while a just-entered code is
		// still validating/redeeming — it would silently drop the promo.
		if (!selectedPlan || selectedPlan.metadata?.action || promoBusy) return;

		setLoadingSecret(true);
		setError(null);
		try {
			const res = await onCreateCheckout(selectedPlan.stripePriceId, appliedPromo?.code);
			if (res.clientSecret === null) {
				// $0 first invoice (100%-off code) — the subscription is already
				// active; never mount Elements. Best-effort pending write, then done.
				try {
					await onConfirmPending(res.subscriptionId, selectedPlan.stripePriceId);
				} catch {
					// Non-fatal — the webhook will still update the DB
				}
				onSuccess();
				return;
			}
			setClientSecret(res.clientSecret);
			setSubscriptionId(res.subscriptionId);
		} catch (err: any) {
			setError(err.message ?? 'Failed to start checkout. Please try again.');
		} finally {
			setLoadingSecret(false);
		}
	}, [selectedPlan, appliedPromo, promoBusy, onCreateCheckout, onConfirmPending, onSuccess]);

	/** Resets back to the plan picker. */
	const handleBack = useCallback(() => {
		setClientSecret(null);
		setError(null);
	}, []);

	/**
	 * Validates the entered promo code. Grant/hackathon codes redeem
	 * immediately (no plan or payment involved); discount codes stay
	 * applied and flow into checkout via handleContinue.
	 */
	const handleApplyPromo = useCallback(async () => {
		if (!onValidatePromoCode) return;
		const code = promoInput.trim();
		if (!code) return;

		setPromoBusy(true);
		setPromoError(null);
		try {
			const validation = await onValidatePromoCode(code, selectedPlan?.stripePriceId);
			if (!validation.valid) {
				setPromoError(validation.reason ?? 'This code is not valid or has expired.');
				return;
			}
			if (validation.appId && onRedeemPromoCode) {
				// Grant/hackathon code (identified by its target app) — redeem
				// right away, skip plan + payment. Credits are optional: a
				// 0-token code just activates the plan.
				const redemption = await onRedeemPromoCode(code);
				setGrantResult({
					code: validation.code ?? code.toUpperCase(),
					credits: redemption.credits ?? {},
					mode: redemption.mode,
				});
				return;
			}
			// Preserve the entered code if validation omits the canonical one —
			// handleContinue sends appliedPromo.code to the server.
			setAppliedPromo({ ...validation, code: validation.code ?? code.toUpperCase() });
		} catch (err: any) {
			setPromoError(err?.message ?? 'Could not apply this code. Please try again.');
		} finally {
			setPromoBusy(false);
		}
	}, [promoInput, selectedPlan, onValidatePromoCode, onRedeemPromoCode]);

	/** Clears the applied discount code. */
	const handleRemovePromo = useCallback(() => {
		setAppliedPromo(null);
		setPromoInput('');
		setPromoError(null);
	}, []);

	/**
	 * Plan selection wrapper: an applied discount was validated against the
	 * previously selected plan's price, so switching plans clears it — the
	 * user re-applies the code and gets amounts for the new plan.
	 */
	const handleSelectPlan = useCallback((plan: CheckoutPlan | null) => {
		setSelectedPlan(plan);
		if (appliedPromo) {
			setAppliedPromo(null);
			setPromoError(null);
		}
	}, [appliedPromo]);

	// When a plan is preselected (web pricing page), skip the picker entirely:
	// create the subscription immediately so the user lands on the payment step.
	// At mount ``plans`` is still empty, so the PlanPicker cannot re-select a
	// default over our seeded selection before this fires. Runs once.
	const autoStartedRef = useRef(false);
	useEffect(() => {
		if (!preselectedPlan || autoStartedRef.current) return;
		if (!clientSecret && !loadingSecret) {
			autoStartedRef.current = true;
			void handleContinue();
		}
	}, [preselectedPlan, clientSecret, loadingSecret, handleContinue]);

	// Stripe Elements appearance
	const appearance = useMemo(() => {
		const root = getComputedStyle(document.documentElement);
		const resolve = (v: string, fb: string) => root.getPropertyValue(v).trim() || fb;
		return {
			theme: 'stripe' as const,
			variables: {
				colorPrimary: '#f7901f',
				colorBackground: resolve('--rr-bg-paper', '#ffffff'),
				colorText: resolve('--rr-text-primary', '#111'),
				colorDanger: '#dc2626',
				fontFamily: 'var(--rr-font-family, system-ui, sans-serif)',
				borderRadius: '8px',
			},
		};
	}, []);

	// ── Render ───────────────────────────────────────────────────────────
	return (
		<div
			style={{ ...commonStyles.modalOverlay, fontFamily: 'var(--rr-font-family)' }}
			onClick={(e) => e.target === e.currentTarget && onClose()}
		>
			<div style={S.modal}>
				<button style={S.closeBtn} onClick={onClose} aria-label="Close">&times;</button>

				{/* Header banner */}
				<div style={S.header}>
					<h2 style={S.appName}>{appName}</h2>
					{appDescription && <p style={S.appDesc}>{appDescription}</p>}
				</div>

				{/* Body */}
				<div style={S.body}>
					{error && <p style={S.error}>{error}</p>}

					{grantResult ? (
						/* Grant/hackathon code redeemed — no plan, no payment */
						<div style={S.successBlock}>
							<div style={S.successMark}>{'✓'}</div>
							<h3 style={S.successTitle}>
								{grantResult.mode === 'subscribed'
									? 'No payment required — your plan is active.'
									: 'Code redeemed.'}
							</h3>
							<p style={S.successText}>
								{Object.keys(grantResult.credits).length > 0 && (
									<>
										<span style={S.successCredits}>{formatCredits(grantResult.credits)}</span> added to your organization.
										<br />
									</>
								)}
								Code <b>{grantResult.code}</b>
							</p>
							<button style={S.submitBtn(false)} onClick={onSuccess}>Start building</button>
						</div>

					) : clientSecret && selectedPlan ? (
						/* Step 2: payment form */
						<Elements stripe={stripePromise} options={{ clientSecret, appearance }}>
							<PaymentForm
								plan={selectedPlan}
								subscriptionId={subscriptionId}
								promo={appliedPromo}
								onConfirmPending={onConfirmPending}
								onSuccess={onSuccess}
								onError={setError}
								onBack={handleBack}
							/>
						</Elements>

					) : loadingSecret ? (
						<p style={S.status}>Preparing checkout&hellip;</p>

					) : (
						/* Step 1: plan picker (+ promo code box when the host wires it) */
						<PlanPicker
							plans={plans}
							loading={plansLoading}
							selectedPlan={selectedPlan}
							onSelectPlan={handleSelectPlan}
							onActionClick={onActionClick}
							autoSelectDefault
							footer={
								<>
									{promoEnabled && (appliedPromo ? (
										<div style={S.promoApplied}>
											<span style={S.promoAppliedCode}>{appliedPromo.code}</span>
											<span style={S.promoAppliedDesc}>
												{appliedPromo.description}
												{selectedPlan && (
													<>
														{' — '}
														<b style={{ color: 'var(--rr-text-primary)' }}>
															{formatCents(discountedCents(selectedPlan, appliedPromo), selectedPlan.currency)}{intervalSuffix(selectedPlan)}
														</b>
														{appliedPromo.duration !== 'forever' && `, then ${planAmount(selectedPlan)}${intervalSuffix(selectedPlan)}`}
													</>
												)}
											</span>
											<button style={S.promoRemoveBtn} onClick={handleRemovePromo}>Remove</button>
										</div>
									) : (
										<>
											<div style={S.promoRow}>
												<span style={S.promoLabel}>Promo Code</span>
												<input
													style={S.promoInput}
													value={promoInput}
													placeholder="Enter code"
													onChange={(e) => { setPromoInput(e.target.value); setPromoError(null); }}
													onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleApplyPromo(); } }}
													disabled={promoBusy}
													aria-label="Promo code"
												/>
												<button
													style={S.promoApplyBtn(promoBusy || !promoInput.trim())}
													disabled={promoBusy || !promoInput.trim()}
													onClick={() => void handleApplyPromo()}
												>
													{promoBusy ? 'Applying…' : 'Apply'}
												</button>
											</div>
											{promoError && <p style={S.promoError}>{promoError}</p>}
										</>
									))}
									<button
										style={S.continueBtn(!selectedPlan || !!selectedPlan.metadata?.action || promoBusy)}
										disabled={!selectedPlan || !!selectedPlan.metadata?.action || promoBusy}
										onClick={handleContinue}
									>
										Continue
									</button>
								</>
							}
						/>
					)}
				</div>
			</div>
		</div>
	);
};
