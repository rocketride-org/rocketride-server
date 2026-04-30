// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CheckoutModal — host-agnostic plan picker + Stripe Elements checkout.
 *
 * Flow:
 *   1. Mount     → fetch plans via onFetchPlans callback
 *   2. Select    → user picks a plan (monthly / annual / etc.)
 *   3. Continue  → onCreateCheckout returns { clientSecret, subscriptionId }
 *   4. Payment   → Stripe Elements <PaymentElement> collects card details
 *   5. Submit    → stripe.confirmPayment() (redirect: 'if_required')
 *   6. Confirm   → onConfirmPending notifies server
 *   7. Success   → onSuccess — host closes modal, server pushes updated subscribedApps
 *
 * All server communication flows through callback props — no SDK imports.
 */

import React, { useEffect, useState, useCallback, useMemo, type CSSProperties } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { commonStyles } from '../../themes/styles';
import type { CheckoutModalProps, CheckoutPlan } from './types';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	// Outer modal shell — two-column flex row; overflow:hidden clips the left
	// column's background to the modal's border-radius.
	modal: {
		backgroundColor: 'var(--rr-bg-paper)',
		border: '1px solid var(--rr-border)',
		borderRadius: 16,
		width: '100%',
		maxWidth: 800,
		display: 'flex',
		overflow: 'hidden',
		boxShadow: '0 24px 64px var(--rr-shadow-widget)',
		position: 'relative' as const,
	} as CSSProperties,

	// Left summary column — app name, description, and selected plan recap.
	leftCol: {
		width: 260,
		flexShrink: 0,
		padding: '40px 28px 36px',
		background: 'var(--rr-bg-titleBar-inactive)',
		borderRight: '1px solid var(--rr-border)',
		display: 'flex',
		flexDirection: 'column' as const,
		gap: 12,
	} as CSSProperties,

	// Right form column — plan picker (step 1) or Stripe PaymentElement (step 2).
	rightCol: {
		flex: 1,
		minWidth: 0,
		padding: '40px 32px 36px',
	} as CSSProperties,

	closeBtn: {
		position: 'absolute' as const,
		top: 16,
		right: 16,
		background: 'none',
		border: 'none',
		fontSize: 22,
		cursor: 'pointer',
		color: 'var(--rr-text-secondary)',
		lineHeight: 1,
		padding: '2px 6px',
	} as CSSProperties,

	heading: {
		fontSize: 20,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
		margin: 0,
	} as CSSProperties,

	subtitle: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		margin: 0,
		lineHeight: 1.5,
	} as CSSProperties,

	// Compact plan recap shown in the left column on step 2.
	planRecap: {
		marginTop: 'auto',
		padding: '12px 14px',
		borderRadius: 10,
		border: '1px solid var(--rr-border)',
		background: 'var(--rr-bg-paper)',
	} as CSSProperties,

	planRecapLabel: {
		fontSize: 11,
		fontWeight: 600,
		textTransform: 'uppercase' as const,
		letterSpacing: '0.5px',
		color: 'var(--rr-text-secondary)',
		marginBottom: 4,
	} as CSSProperties,

	planRecapName: {
		fontSize: 14,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	planRecapAmount: {
		fontSize: 13,
		color: 'var(--rr-text-secondary)',
		marginTop: 2,
	} as CSSProperties,

	// Step 1: plan option rows.
	stepHeading: {
		fontSize: 15,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
		margin: '0 0 14px',
	} as CSSProperties,

	planList: {
		display: 'flex',
		flexDirection: 'column' as const,
		gap: 10,
		marginBottom: 24,
	} as CSSProperties,

	planOption: (selected: boolean): CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		padding: '14px 16px',
		borderRadius: 10,
		border: `2px solid ${selected ? 'var(--rr-brand)' : 'var(--rr-border)'}`,
		background: selected ? 'var(--rr-bg-list-active)' : 'transparent',
		cursor: 'pointer',
		transition: 'border-color 0.15s, background 0.15s',
	}),

	planLabel: {
		fontSize: 15,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	planAmount: {
		fontSize: 14,
		color: 'var(--rr-text-secondary)',
	} as CSSProperties,

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
};

// =============================================================================
// PAYMENT FORM (inner — needs Stripe context from <Elements>)
// =============================================================================

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
 * Must be rendered inside an `<Elements>` provider with a valid `clientSecret`.
 *
 * @param plan          - The selected plan (used for the submit button label).
 * @param subscriptionId - Server-side subscription ID for confirm_pending.
 * @param onConfirmPending - Callback to notify server that payment was confirmed.
 * @param onSuccess     - Called after successful payment.
 * @param onError       - Called with an error message string on failure.
 * @param onBack        - Called when the user clicks "Change plan".
 */
const PaymentForm: React.FC<PaymentFormProps> = ({ plan, subscriptionId, onConfirmPending, onSuccess, onError, onBack }) => {
	const stripe = useStripe();
	const elements = useElements();
	const [submitting, setSubmitting] = useState(false);

	/**
	 * Confirms the Stripe payment, then notifies the server.
	 * The server push (from confirm_pending and the webhook) will update
	 * subscribedApps automatically.
	 */
	const handleSubmit = useCallback(
		async (e: React.FormEvent) => {
			e.preventDefault();
			if (!stripe || !elements) return;

			setSubmitting(true);
			try {
				// Step 1: Confirm the Stripe payment.
				// redirect:'if_required' avoids a full-page redirect for most card types;
				// 3D Secure may still redirect and return to return_url.
				const { error } = await stripe.confirmPayment({
					elements,
					confirmParams: { return_url: window.location.origin },
					redirect: 'if_required',
				});

				if (error) {
					onError(error.message ?? 'Payment failed. Please try again.');
					return;
				}

				// Step 2: Tell the server payment was confirmed — writes 'incomplete'
				// to the DB so the app shows as "Pending" immediately. The webhook
				// will flip it to 'active' once Stripe settles the charge.
				try {
					await onConfirmPending(subscriptionId, plan.priceId);
				} catch {
					// Non-fatal — the webhook will still update the DB
				}

				// Step 3: Close the modal. The server push will update subscribedApps.
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
			{/* Back link to plan picker */}
			<button style={S.backBtn} onClick={onBack}>
				&#8592; Change plan
			</button>

			<form onSubmit={handleSubmit}>
				{/* Stripe renders card fields; Link opt-in suppressed via wallets option. */}
				<PaymentElement options={{ wallets: { link: 'never' } }} />

				<button type="submit" disabled={!stripe || submitting} style={S.submitBtn(!stripe || submitting)}>
					{submitting ? 'Processing\u2026' : `Subscribe \u2014 ${plan.amount}`}
				</button>
			</form>
		</>
	);
};

// =============================================================================
// CHECKOUT MODAL
// =============================================================================

/**
 * Two-step checkout modal: plan picker then Stripe Elements payment form.
 *
 * Step 1 (plan picker): the user selects from available plans fetched on mount.
 * Step 2 (payment):     the chosen plan's priceId is sent to the server to
 *                       create a Stripe subscription; Stripe Elements then
 *                       collects and confirms the payment.
 *
 * All server communication is via callback props — no SDK imports.
 */
export const CheckoutModal: React.FC<CheckoutModalProps> = ({ appName, appDescription, stripePublishableKey, onFetchPlans, onCreateCheckout, onConfirmPending, onSuccess, onClose }) => {
	// Initialise Stripe lazily — loadStripe must not be called inside render
	const [stripePromise] = useState(() => loadStripe(stripePublishableKey));

	// ── Step 1: plan selection ─────────────────────────────────────────────────
	// Plans are fetched from the server on mount.
	const [plans, setPlans] = useState<CheckoutPlan[]>([]);
	const [plansLoading, setPlansLoading] = useState(true);
	const [selectedPlan, setSelectedPlan] = useState<CheckoutPlan | null>(null);

	// ── Step 2: payment ────────────────────────────────────────────────────────
	// clientSecret is null until the user clicks "Continue" and the server responds.
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [subscriptionId, setSubscriptionId] = useState<string>('');
	// Loading flag while the checkout request is in flight
	const [loadingSecret, setLoadingSecret] = useState(false);
	// Error message to display in the modal
	const [error, setError] = useState<string | null>(null);

	// Fetch available plans on mount
	useEffect(() => {
		onFetchPlans()
			.then((fetched) => {
				setPlans(fetched);
				// Pre-select the first plan (monthly comes first, sorted by server)
				if (fetched.length > 0) setSelectedPlan(fetched[0]!);
			})
			.catch((err) => setError(err.message ?? 'Failed to load subscription plans.'))
			.finally(() => setPlansLoading(false));
	}, [onFetchPlans]);

	/**
	 * Called when the user confirms their selected plan.
	 * Creates a Stripe subscription on the server and advances to the payment step.
	 */
	const handleContinue = useCallback(async () => {
		if (!selectedPlan) return;

		setLoadingSecret(true);
		setError(null);
		try {
			const res = await onCreateCheckout(selectedPlan.priceId);
			setClientSecret(res.clientSecret);
			setSubscriptionId(res.subscriptionId);
		} catch (err: any) {
			setError(err.message ?? 'Failed to start checkout. Please try again.');
		} finally {
			setLoadingSecret(false);
		}
	}, [selectedPlan, onCreateCheckout]);

	/** Resets back to the plan picker without closing the modal. */
	const handleBack = useCallback(() => {
		setClientSecret(null);
		setError(null);
	}, []);

	// Stripe Elements appearance — matches the shell's design tokens.
	// Stripe rejects CSS variables, so resolve them to computed values.
	const appearance = useMemo(() => {
		const root = getComputedStyle(document.documentElement);
		const resolve = (varName: string, fallback: string) => root.getPropertyValue(varName).trim() || fallback;
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

	return (
		<div style={{ ...commonStyles.modalOverlay, fontFamily: 'var(--rr-font-family)' }} onClick={(e) => e.target === e.currentTarget && onClose()}>
			<div style={S.modal}>
				{/* Close button — absolute, floats over the right column */}
				<button style={S.closeBtn} onClick={onClose} aria-label="Close">
					&times;
				</button>

				{/* ── Left column: app summary ──────────────────────────────────── */}
				<div style={S.leftCol}>
					<h2 style={S.heading}>{appName}</h2>
					<p style={S.subtitle}>{appDescription ?? 'Choose a plan to get started.'}</p>

					{/* On step 2 show the selected plan as a recap card */}
					{clientSecret && selectedPlan && (
						<div style={S.planRecap}>
							<div style={S.planRecapLabel}>Selected plan</div>
							<div style={S.planRecapName}>{selectedPlan.label}</div>
							<div style={S.planRecapAmount}>{selectedPlan.amount}</div>
						</div>
					)}
				</div>

				{/* ── Right column: plan picker (step 1) or payment form (step 2) ── */}
				<div style={S.rightCol}>
					{error && <p style={S.error}>{error}</p>}

					{plansLoading ? (
						<p style={S.status}>Loading plans&hellip;</p>
					) : clientSecret && selectedPlan ? (
						<Elements stripe={stripePromise} options={{ clientSecret, appearance }}>
							<PaymentForm plan={selectedPlan} subscriptionId={subscriptionId} onConfirmPending={onConfirmPending} onSuccess={onSuccess} onError={setError} onBack={handleBack} />
						</Elements>
					) : loadingSecret ? (
						<p style={S.status}>Preparing checkout&hellip;</p>
					) : (
						/* ── Step 1: plan picker ──────────────────────────────── */
						<>
							<p style={S.stepHeading}>Choose a plan</p>
							<div style={S.planList}>
								{plans.map((plan) => (
									<div key={plan.priceId} style={S.planOption(selectedPlan?.priceId === plan.priceId)} onClick={() => setSelectedPlan(plan)} role="radio" aria-checked={selectedPlan?.priceId === plan.priceId}>
										<span style={S.planLabel}>{plan.label}</span>
										<span style={S.planAmount}>{plan.amount}</span>
									</div>
								))}
							</div>

							<button style={S.continueBtn(!selectedPlan)} disabled={!selectedPlan} onClick={handleContinue}>
								Continue
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
};
