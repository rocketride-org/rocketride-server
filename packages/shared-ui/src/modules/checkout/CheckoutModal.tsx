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
import type { CheckoutModalProps, CheckoutPlan } from './types';

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
};

// =============================================================================
// PAYMENT FORM (inner — needs Stripe context from <Elements>)
// =============================================================================

/** @internal */
interface PaymentFormProps {
	plan: CheckoutPlan;
	subscriptionId: string;
	onConfirmPending: (subscriptionId: string, priceId: string) => Promise<void>;
	onSuccess: () => void;
	onError: (msg: string) => void;
	onBack: () => void;
}

/**
 * Stripe Elements payment form shown after the user has selected a plan.
 * Must be rendered inside an ``<Elements>`` provider with a valid ``clientSecret``.
 */
const PaymentForm: React.FC<PaymentFormProps> = ({ plan, subscriptionId, onConfirmPending, onSuccess, onError, onBack }) => {
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

	return (
		<>
			<button style={S.backBtn} onClick={onBack}>&#8592; Change plan</button>

			{/* Plan recap bar */}
			<div style={S.planRecap}>
				<span style={S.planRecapName}>{plan.nickname}</span>
				<span style={S.planRecapAmount}>{planAmount(plan)}</span>
			</div>

			<form onSubmit={handleSubmit}>
				<PaymentElement options={{ wallets: { link: 'never' } }} />
				<button type="submit" disabled={!stripe || submitting} style={S.submitBtn(!stripe || submitting)}>
					{submitting ? 'Processing\u2026' : `Subscribe \u2014 ${planAmount(plan)}`}
				</button>
			</form>
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

	// ── Fetch plans on mount ─────────────────────────────────────────────
	useEffect(() => {
		onFetchPlans()
			.then((fetched) => {
				// Filter out top-up packs — those are handled by the TopUpModal
				const subscriptionPlans = fetched.filter((p) => p.metadata?.kind !== 'topup' && p.isActive !== false);
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
		if (!selectedPlan || selectedPlan.metadata?.action) return;

		setLoadingSecret(true);
		setError(null);
		try {
			const res = await onCreateCheckout(selectedPlan.stripePriceId);
			setClientSecret(res.clientSecret);
			setSubscriptionId(res.subscriptionId);
		} catch (err: any) {
			setError(err.message ?? 'Failed to start checkout. Please try again.');
		} finally {
			setLoadingSecret(false);
		}
	}, [selectedPlan, onCreateCheckout]);

	/** Resets back to the plan picker. */
	const handleBack = useCallback(() => {
		setClientSecret(null);
		setError(null);
	}, []);

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

					{clientSecret && selectedPlan ? (
						/* Step 2: payment form */
						<Elements stripe={stripePromise} options={{ clientSecret, appearance }}>
							<PaymentForm
								plan={selectedPlan}
								subscriptionId={subscriptionId}
								onConfirmPending={onConfirmPending}
								onSuccess={onSuccess}
								onError={setError}
								onBack={handleBack}
							/>
						</Elements>

					) : loadingSecret ? (
						<p style={S.status}>Preparing checkout&hellip;</p>

					) : (
						/* Step 1: plan picker */
						<PlanPicker
							plans={plans}
							loading={plansLoading}
							selectedPlan={selectedPlan}
							onSelectPlan={setSelectedPlan}
							onActionClick={onActionClick}
							autoSelectDefault
							footer={
								<button
									style={S.continueBtn(!selectedPlan || !!selectedPlan.metadata?.action)}
									disabled={!selectedPlan || !!selectedPlan.metadata?.action}
									onClick={handleContinue}
								>
									Continue
								</button>
							}
						/>
					)}
				</div>
			</div>
		</div>
	);
};
