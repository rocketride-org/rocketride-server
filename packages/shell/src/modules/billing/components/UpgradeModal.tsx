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

import React, { useLayoutEffect, useState, useMemo, useRef, type CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import { Modal } from '../../../components/modal/Modal';
import { PlanPicker, planAmount } from '../../checkout/PlanPicker';
import type { CheckoutPlan } from '../../checkout/types';
import { planChangeCompletion } from './planChange';
import type { PlanChangeOutcome } from './planChange';

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
	/** False while the host cannot apply a plan change (disconnected, not an admin, account changing). */
	available?: boolean;
	/**
	 * Called when the user confirms the plan change. Resolve with the server's
	 * outcome to show what it actually did (applied now, or scheduled for
	 * renewal); resolve with nothing for a neutral confirmation.
	 */
	onUpgrade: (newPriceId: string) => Promise<void | PlanChangeOutcome>;
	/** Called when the modal is dismissed. */
	onClose: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * A recurring subscription plan the change dialog can offer: monthly or
 * yearly, and not a top-up pack, hidden promo-base or action-only card. Gates
 * both the picker grid and preselected plans so a hidden plan can never be
 * reached via `preselectedPriceId`.
 */
export const isVisibleSubscriptionPlan = (p: CheckoutPlan): boolean =>
	(!p.interval || p.interval === 'month' || p.interval === 'year') &&
	p.metadata?.kind !== 'topup' &&
	p.metadata?.kind !== 'promo_base' &&
	!p.metadata?.action &&
	p.isActive !== false;

/**
 * Modal dialog for upgrading or downgrading a subscription plan.
 *
 * Displays the PlanPicker grid with the current plan disabled. The user
 * selects a new plan and confirms; the dialog then reports what the server
 * did with it.
 */
export const UpgradeModal: React.FC<UpgradeModalProps> = ({
	plans,
	currentPriceId,
	currentPlanName,
	preselectedPriceId,
	available = true,
	onUpgrade,
	onClose,
}) => {
	const [selectedPlanId, setSelectedPlanId] = useState<string | null>(() =>
		preselectedPriceId && preselectedPriceId !== currentPriceId &&
		plans.some((p) => p.stripePriceId === preselectedPriceId && isVisibleSubscriptionPlan(p))
			? preselectedPriceId
			: null,
	);
	const [upgrading, setUpgrading] = useState(false);
	const [completion, setCompletion] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const inFlight = useRef(false);
	const mounted = useRef(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useLayoutEffect(() => {
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

	// Resolve the selected card from the latest catalog.
	const selectedPlan = subscriptionPlans.find((plan) => plan.stripePriceId === selectedPlanId) ?? null;
	const isValidSelection = selectedPlan !== null && selectedPlan.stripePriceId !== currentPriceId;

	/**
	 * Compact (focused-confirmation) layout: shown when the caller preselected a
	 * valid target, so the full picker grid is replaced by a one-line summary.
	 */
	const compact = !!preselectedPriceId && isValidSelection;

	/**
	 * Label the change before it is sent, from the plan amounts. The server
	 * decides the real direction (tier, interval and seats as well as price),
	 * and the confirmation afterwards reports what it actually did.
	 */
	const changeDirection = useMemo(() => {
		if (!selectedPlan) return null;
		const currentPlan = subscriptionPlans.find((p) => p.stripePriceId === currentPriceId);
		if (!currentPlan) return 'change';
		if (selectedPlan.amountCents > currentPlan.amountCents) return 'upgrade';
		if (selectedPlan.amountCents < currentPlan.amountCents) return 'downgrade';
		return 'change';
	}, [selectedPlan, currentPriceId, subscriptionPlans]);

	const canConfirm = available && isValidSelection && !upgrading;

	const handleSelect = (plan: CheckoutPlan) => {
		if (!available || plan.stripePriceId === currentPriceId || inFlight.current) return;
		setSelectedPlanId(plan.stripePriceId);
		setError(null);
	};

	const handleConfirm = async () => {
		if (!canConfirm || !selectedPlan || inFlight.current) return;
		inFlight.current = true;
		setUpgrading(true);
		setError(null);
		try {
			const result = await onUpgrade(selectedPlan.stripePriceId);
			if (!mounted.current) return;
			setCompletion(planChangeCompletion(result));
			// Auto-close after a brief confirmation display.
			closeTimer.current = setTimeout(onClose, 1500);
		} catch (error: unknown) {
			if (mounted.current) {
				setError(error instanceof Error && error.message ? error.message : 'Plan change failed. Please try again.');
			}
		} finally {
			inFlight.current = false;
			if (mounted.current) setUpgrading(false);
		}
	};

	/** Build the confirm button label based on selection state. */
	const buttonLabel = () => {
		if (upgrading) return 'Processing...';
		if (!available) return 'Plan changes unavailable';
		if (!selectedPlanId) return 'Select a plan';
		if (selectedPlanId === currentPriceId) return 'Current plan';
		if (!selectedPlan) return 'Plan unavailable';
		const verb = changeDirection === 'upgrade' ? 'Upgrade' : changeDirection === 'downgrade' ? 'Downgrade' : 'Switch';
		return `${verb} to ${selectedPlan.nickname} (${planAmount(selectedPlan)})`;
	};

	// Confirm button style -- dimmed (and non-interactive) unless a valid
	// selection exists and no plan change is in flight.
	const confirmStyle: CSSProperties = {
		...commonStyles.buttonPrimary,
		...(canConfirm ? null : { opacity: 0.5, cursor: 'default' }),
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
			footer={completion ? undefined : (
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
						onClick={handleConfirm}
						disabled={!canConfirm}
					>
						{buttonLabel()}
					</button>
				</>
			)}
		>
			{completion ? (
				/* Confirmation of what the server did — shown briefly until the
				   auto-close timer dismisses the dialog (the footer is dropped). */
				<div style={S.success} role="status">{completion}</div>
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
								keepSelectedPlanVisible
								intervalDisabled={upgrading || !available}
								onIntervalChange={(interval) => {
									if (inFlight.current || selectedPlan?.interval === interval) return;
									setSelectedPlanId(null);
									setError(null);
								}}
							/>
						</>
					)}

					{/* Proration info -- explains what happens on upgrade vs downgrade */}
					{isValidSelection && changeDirection === 'upgrade' && (
						<div style={S.prorationNote}>
							The new plan applies now. Stripe bills the prorated difference for the rest of your current billing period.
						</div>
					)}
					{isValidSelection && changeDirection === 'downgrade' && (
						<div style={S.prorationNote}>
							Your current plan will remain active until the end of your billing period. The new plan takes effect at your next renewal.
						</div>
					)}

					{/* Error banner */}
					{error && <div style={S.error} role="alert">{error}</div>}
				</div>
			)}
		</Modal>
	);
};
