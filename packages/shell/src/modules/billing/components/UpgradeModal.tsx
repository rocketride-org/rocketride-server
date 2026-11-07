// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * UpgradeModal -- modal dialog for changing a subscription plan.
 *
 * Rendered through the stock {@link Modal} (one
 * stock Modal for every dialog). The Modal owns the backdrop, box, header,
 * and footer chrome -- including the zIndex 2000 overlay layer that stacks
 * above record panels (DetailPanel, zIndex 1500) and the shared
 * Escape-closes-topmost-layer behavior. This file supplies only the body
 * content and the footer actions.
 *
 * Reuses the PlanPicker card grid to display available plans for the
 * current app. The user's current plan is highlighted and disabled.
 * On confirmation, the host applies the plan change or schedules it for renewal.
 */

import React, { useEffect, useLayoutEffect, useState, useMemo, useRef, type CSSProperties } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { commonStyles } from '../../../themes/styles';
import { Modal } from '../../../components/modal/Modal';
import { PlanPicker, planAmount } from '../../checkout/PlanPicker';
import type { CheckoutPlan } from '../../checkout/types';
import { planChangeCompletion } from './planChange';
import type { PlanChangeOutcome, PlanChangePreview } from './planChange';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	/**
	 * Scrollable body region. The hand-rolled dialog capped the whole box at
	 * 80vh and scrolled it; the stock Modal owns the box chrome, so the cap
	 * moves onto the body content instead (header and footer stay in view).
	 */
	body: {
		maxHeight: '60vh',
		overflowY: 'auto' as const,
		scrollbarWidth: 'thin' as const,
		// The REAL token is --rr-bg-scrollbar-thumb (the old --rr-scrollbar-thumb
		// name never existed, so this always fell back to the hardcoded grey).
		scrollbarColor: 'var(--rr-bg-scrollbar-thumb, rgba(121, 121, 121, 0.4)) transparent',
	} as CSSProperties,

	/** Current plan info banner. */
	currentPlan: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		padding: '10px 14px',
		marginBottom: 16,
		background: 'var(--rr-bg-surface-alt)',
		border: '1px solid var(--rr-border)',
		borderRadius: 8,
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
	} as CSSProperties,

	/** Label for the current plan info. */
	currentLabel: {
		fontSize: 10,
		fontWeight: 700,
		letterSpacing: 1,
		textTransform: 'uppercase' as const,
		color: 'var(--rr-text-disabled)',
		flexShrink: 0,
	} as CSSProperties,

	/** Emphasised plan name inside the info banner. */
	planName: {
		color: 'var(--rr-text-primary)',
		fontWeight: 600,
	} as CSSProperties,

	/** Proration explanation note shown under the picker for a valid selection. */
	prorationNote: {
		fontSize: 12,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
		marginTop: 8,
	} as CSSProperties,

	/** Success message. */
	success: {
		padding: 16,
		textAlign: 'center' as const,
		color: 'var(--rr-color-success)',
		fontSize: 14,
		fontWeight: 600,
	} as CSSProperties,

	/** Error message. */
	error: {
		marginTop: 8,
		padding: 10,
		background: 'var(--rr-bg-error, #ffe5e5)',
		color: 'var(--rr-color-error, #c62828)',
		borderRadius: 8,
		fontSize: 13,
	} as CSSProperties,
};

// =============================================================================
// PROPS
// =============================================================================

/** Props for the UpgradeModal component. */
export interface UpgradeModalProps {
	/** All plans from app_prices for the subscribed app. */
	plans: CheckoutPlan[];
	/** Stripe price_* ID of the user's current subscription plan. */
	currentPriceId: string;
	/** Human-readable name of the current plan (e.g. "Pro Monthly"). */
	currentPlanName: string | null;
	/**
	 * Optional Stripe price_* to preselect on open (e.g. the plan a user clicked
	 * on the pricing page), so they land on the proration summary ready to
	 * confirm. Ignored if it equals the current plan. Defaults to no selection.
	 */
	preselectedPriceId?: string;
	/** Preview from the server. Return null if the connected server has no preview. */
	onPreview?: (newPriceId: string, expectedPriceId: string) => Promise<PlanChangePreview | null>;
	/** Keep the dialog and its attempt open if the host is temporarily unavailable. */
	available?: boolean;
	/** Confirm a plan change. Retries for the same selection reuse the attempt ID. */
	onUpgrade: (newPriceId: string, attemptId?: string, expectedPriceId?: string) => Promise<void | PlanChangeOutcome>;
	/** Called when the modal is dismissed. */
	onClose: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Whether a plan may appear in the upgrade picker: not a top-up pack, not a
 * hidden promo-base plan, not action-only, and not deactivated. Applied to
 * both the picker grid and preselected plans so a hidden plan can never be
 * reached via `preselectedPriceId`.
 */
const isVisibleSubscriptionPlan = (p: CheckoutPlan): boolean =>
	(p.interval === 'month' || p.interval === 'year') &&
	p.metadata?.kind !== 'topup' &&
	p.metadata?.kind !== 'promo_base' &&
	!p.metadata?.action &&
	p.isActive !== false;

/**
 * Modal dialog for upgrading or downgrading a subscription plan.
 *
 * Displays the PlanPicker grid with the current plan disabled. The user
 * selects a new plan and confirms the timing reported by the server.
 */
export const UpgradeModal: React.FC<UpgradeModalProps> = ({
	plans,
	currentPriceId,
	currentPlanName,
	preselectedPriceId,
	onPreview,
	available = true,
	onUpgrade,
	onClose,
}) => {
	const [selectedPlan, setSelectedPlan] = useState<CheckoutPlan | null>(
		() => (preselectedPriceId && preselectedPriceId !== currentPriceId
			? plans.find((p) => p.stripePriceId === preselectedPriceId && isVisibleSubscriptionPlan(p)) ?? null
			: null),
	);
	const [upgrading, setUpgrading] = useState(false);
	const [completion, setCompletion] = useState<{ message: string; pending: boolean } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [previewState, setPreviewState] = useState<{
		priceId: string;
		expectedPriceId: string;
		source: NonNullable<UpgradeModalProps['onPreview']>;
		preview: PlanChangePreview | null;
		error?: string;
	} | null>(null);
	const [previewRetry, setPreviewRetry] = useState(0);
	const attempt = useRef<{ priceId: string; expectedPriceId: string; id: string } | null>(null);
	const inFlight = useRef(false);
	const mounted = useRef(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			if (closeTimer.current) clearTimeout(closeTimer.current);
		};
	}, []);

	// Filter out top-up packs, hidden promo-base plans, and action-only plans
	const subscriptionPlans = useMemo(
		() => plans.filter(isVisibleSubscriptionPlan),
		[plans],
	);

	/** Whether the selected plan differs from the current plan. */
	const isValidSelection = selectedPlan && selectedPlan.stripePriceId !== currentPriceId &&
		subscriptionPlans.some((plan) => plan.stripePriceId === selectedPlan.stripePriceId);

	/**
	 * When opened with a preselected plan (e.g. from the pricing page), show a
	 * focused confirmation of that plan instead of the full plan picker.
	 */
	const compact = !!preselectedPriceId && isValidSelection;

	const selectedPriceId = isValidSelection ? selectedPlan?.stripePriceId : undefined;
	const paymentSelection = useRef({ available, currentPriceId, selectedPriceId });
	useLayoutEffect(() => {
		paymentSelection.current = { available, currentPriceId, selectedPriceId };
	}, [available, currentPriceId, selectedPriceId]);

	useEffect(() => {
		setPreviewState(null);
		if (!available || !onPreview || !selectedPriceId) return;
		let active = true;
		const selection = { priceId: selectedPriceId, expectedPriceId: currentPriceId, source: onPreview };
		void onPreview(selectedPriceId, currentPriceId).then(
			(preview) => { if (active) setPreviewState({ ...selection, preview }); },
			(err) => {
				if (active) setPreviewState({ ...selection, preview: null, error: err?.message ?? 'Could not preview the plan change.' });
			},
		);
		return () => { active = false; };
	}, [available, onPreview, selectedPriceId, currentPriceId, previewRetry]);

	const currentPreview = available && onPreview && previewState?.priceId === selectedPriceId &&
		previewState?.expectedPriceId === currentPriceId && previewState.source === onPreview ? previewState : null;
	const previewLoading = Boolean(available && onPreview && selectedPriceId && !currentPreview);
	const preview = currentPreview?.preview;
	const canConfirm = Boolean(available && isValidSelection && !previewLoading && !currentPreview?.error && preview?.timing !== 'unchanged');

	const handleSelect = (plan: CheckoutPlan) => {
		if (!available || plan.stripePriceId === currentPriceId || inFlight.current) return;
		if (selectedPlan?.stripePriceId !== plan.stripePriceId) attempt.current = null;
		setSelectedPlan(plan);
		setError(null);
	};

	const handleConfirm = async () => {
		if (!selectedPriceId || !canConfirm || inFlight.current) return;
		inFlight.current = true;
		setUpgrading(true);
		setError(null);
		try {
			if (attempt.current?.priceId !== selectedPriceId || attempt.current.expectedPriceId !== currentPriceId) {
				const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
				attempt.current = { priceId: selectedPriceId, expectedPriceId: currentPriceId, id };
			}
			const { id, expectedPriceId } = attempt.current;
			let result = await onUpgrade(selectedPriceId, id, expectedPriceId);
			if (!mounted.current) return;
			if (result?.status === 'requires_action' && result.clientSecret && result.stripePublishableKey) {
				const stripe = await loadStripe(result.stripePublishableKey);
				if (!mounted.current) return;
				if (!stripe) throw new Error('Payment authentication could not be loaded. Try again.');
				const live = paymentSelection.current;
				if (!live.available || live.currentPriceId !== expectedPriceId || live.selectedPriceId !== selectedPriceId) {
					throw new Error('The subscription changed. Review the plan change before trying again.');
				}
				result.assertPaymentScope?.();
				const confirmation = await stripe.confirmCardPayment(result.clientSecret);
				if (!mounted.current) return;
				if (confirmation.error) throw new Error(confirmation.error.message ?? 'Payment authentication failed.');
				if (confirmation.paymentIntent?.status === 'succeeded') result = await onUpgrade(selectedPriceId, id, expectedPriceId);
			}
			if (!mounted.current) return;
			const outcome = planChangeCompletion(result);
			setCompletion(outcome);
			if (!outcome.pending) closeTimer.current = setTimeout(onClose, 1500);
		} catch (e: any) {
			if (mounted.current) setError(e?.message ?? 'Plan change failed. Please try again.');
		} finally {
			inFlight.current = false;
			if (mounted.current) setUpgrading(false);
		}
	};

	const buttonLabel = () => {
		if (upgrading) return 'Processing...';
		if (!available) return 'Plan changes unavailable';
		if (previewLoading) return 'Checking plan change...';
		if (currentPreview?.error) return 'Retry preview';
		if (!selectedPlan) return 'Select a plan';
		if (!isValidSelection || preview?.timing === 'unchanged') return 'Current plan';
		const verb = preview?.direction === 'upgrade' ? 'Upgrade' : preview?.direction === 'downgrade' ? 'Downgrade' : 'Switch';
		return `${verb} to ${selectedPlan.nickname} (${planAmount(selectedPlan)})`;
	};

	// Confirm button style: primary, dimmed and non-interactive unless a valid
	// selection exists and no plan change is in flight.
	const confirmStyle: CSSProperties = {
		...commonStyles.buttonPrimary,
		...((canConfirm || currentPreview?.error) && !upgrading ? null : { opacity: 0.5, cursor: 'default' }),
	};

	return (
		/* Stock Modal: inert backdrop (clicking outside never closes), Escape
		   closes only the topmost overlay layer. No corner ✕ (showClose false):
		   dismissal is the footer Cancel, Escape, or the success auto-close timer
		   (refined popup policy 2026-07-08 — no redundant ✕ when an explicit
		   close or auto-dismiss exists). Escape is suppressed while the plan
		   change is in flight, mirroring the disabled Cancel button. */
		<Modal
			title="Change Plan"
			onClose={onClose}
			width={600}
			showClose={false}
			closeOnEscape={!upgrading}
			footer={completion?.pending ? (
				<button type="button" style={commonStyles.buttonSecondary} onClick={onClose}>Close</button>
			) : completion ? undefined : (
				<>
					{/* Cancel — the dialog's explicit dismiss control. */}
					<button
						type="button"
						style={commonStyles.buttonSecondary}
						onClick={onClose}
						disabled={upgrading}
					>
						Cancel
					</button>
					{/* Confirm — label reflects selection and in-flight state. */}
					<button
						type="button"
						style={confirmStyle}
						onClick={currentPreview?.error ? () => setPreviewRetry((value) => value + 1) : handleConfirm}
						disabled={(!canConfirm && !currentPreview?.error) || upgrading}
					>
						{buttonLabel()}
					</button>
				</>
			)}
		>
			{completion ? (
				<div style={completion.pending ? S.prorationNote : S.success} role="status">{completion.message}</div>
			) : (
				<div style={S.body}>
					{compact && selectedPlan ? (
						/* Focused confirmation: caller preselected the plan, so summarise
						   it instead of re-showing the picker. */
						<div style={S.currentPlan}>
							<span style={S.currentLabel}>Switch to</span>
							<span style={S.planName}>
								{selectedPlan.nickname} &middot; {planAmount(selectedPlan)}
							</span>
						</div>
					) : (
						<>
							{/* Current plan info */}
							<div style={S.currentPlan}>
								<span style={S.currentLabel}>Current</span>
								<span style={S.planName}>
									{currentPlanName ?? 'Unknown plan'}
								</span>
							</div>

							{/* Plan picker -- reuses the same card grid */}
							<PlanPicker
								plans={subscriptionPlans}
								selectedPlan={selectedPlan}
								onSelectPlan={handleSelect}
								currentPriceId={currentPriceId}
								intervalDisabled={upgrading || !available}
								onIntervalChange={(interval) => {
									if (inFlight.current || selectedPlan?.interval === interval) return;
									attempt.current = null;
									setSelectedPlan(null);
									setError(null);
								}}
							/>
						</>
					)}

					{preview?.timing === 'immediate' && (
						<div style={S.prorationNote}>
							{preview.billingIntervalChanges
								? 'Your new billing period begins after payment. Stripe applies any unused-time credit to the first charge.'
								: 'This change takes effect after payment. Any applicable proration is included in the charge.'}
						</div>
					)}
					{preview?.timing === 'next_renewal' && (
						<div style={S.prorationNote}>
							Your current plan stays active until the new plan takes effect at your next renewal.
						</div>
					)}
					{currentPreview?.error && <div style={S.error} role="alert">{currentPreview.error}</div>}

					{/* Error banner */}
					{error && <div style={S.error}>{error}</div>}
				</div>
			)}
		</Modal>
	);
};
