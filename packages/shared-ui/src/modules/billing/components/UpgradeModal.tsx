// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * UpgradeModal -- modal dialog for changing a subscription plan.
 *
 * Reuses the PlanPicker card grid to display available plans for the
 * current app. The user's current plan is highlighted and disabled.
 * On confirmation, calls the host's upgrade callback which swaps the
 * Stripe subscription item server-side with proration.
 */

import React, { useState, useMemo, type CSSProperties } from 'react';
import { commonStyles } from '../../../themes/styles';
import { PlanPicker, planAmount } from '../../checkout/PlanPicker';
import type { CheckoutPlan } from '../../checkout/types';

// =============================================================================
// STYLES
// =============================================================================

const S = {
	/** Modal overlay -- full-screen backdrop. */
	overlay: {
		position: 'fixed' as const,
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		background: 'rgba(0, 0, 0, 0.5)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		zIndex: 1000,
	} as CSSProperties,

	/** Modal dialog container. */
	dialog: {
		background: 'var(--rr-bg-paper)',
		borderRadius: 12,
		padding: 24,
		width: '90%',
		maxWidth: 600,
		maxHeight: '80vh',
		overflow: 'auto',
		boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
		scrollbarWidth: 'thin' as const,
		scrollbarColor: 'var(--rr-scrollbar-thumb, rgba(128,128,128,0.3)) transparent',
	} as CSSProperties,

	/** Dialog header row. */
	header: {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		marginBottom: 16,
	} as CSSProperties,

	/** Dialog title. */
	title: {
		fontSize: 18,
		fontWeight: 700,
		color: 'var(--rr-text-primary)',
	} as CSSProperties,

	/** Close button. */
	close: {
		background: 'none',
		border: 'none',
		fontSize: 20,
		cursor: 'pointer',
		color: 'var(--rr-text-secondary)',
		padding: '4px 8px',
		font: 'inherit',
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

	/** Footer row with confirm button. */
	footer: {
		display: 'flex',
		justifyContent: 'flex-end',
		gap: 10,
		marginTop: 16,
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
	/** Called when the user confirms the plan change. */
	onUpgrade: (newPriceId: string) => Promise<void>;
	/** Called when the modal is dismissed. */
	onClose: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Modal dialog for upgrading or downgrading a subscription plan.
 *
 * Displays the PlanPicker grid with the current plan disabled. The user
 * selects a new plan and clicks Confirm to trigger the server-side
 * Stripe subscription modification with proration.
 */
/**
 * Whether a plan may appear in the upgrade picker: not a top-up pack, not a
 * hidden promo-base plan, not action-only, and not deactivated. Applied to
 * both the picker grid and preselected plans so a hidden plan can never be
 * reached via `preselectedPriceId`.
 */
const isVisibleSubscriptionPlan = (p: CheckoutPlan): boolean =>
	p.metadata?.kind !== 'topup' &&
	p.metadata?.kind !== 'promo_base' &&
	!p.metadata?.action &&
	p.isActive !== false;

export const UpgradeModal: React.FC<UpgradeModalProps> = ({
	plans,
	currentPriceId,
	currentPlanName,
	preselectedPriceId,
	onUpgrade,
	onClose,
}) => {
	const [selectedPlan, setSelectedPlan] = useState<CheckoutPlan | null>(
		() => (preselectedPriceId && preselectedPriceId !== currentPriceId
			? plans.find((p) => p.stripePriceId === preselectedPriceId && isVisibleSubscriptionPlan(p)) ?? null
			: null),
	);
	const [upgrading, setUpgrading] = useState(false);
	const [success, setSuccess] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Filter out top-up packs, hidden promo-base plans, and action-only plans
	const subscriptionPlans = useMemo(
		() => plans.filter(isVisibleSubscriptionPlan),
		[plans],
	);

	/** Whether the selected plan differs from the current plan. */
	const isValidSelection = selectedPlan && selectedPlan.stripePriceId !== currentPriceId;

	/**
	 * When opened with a preselected plan (e.g. from the pricing page), show a
	 * focused confirmation of that plan instead of the full plan picker.
	 */
	const compact = !!preselectedPriceId && isValidSelection;

	/**
	 * Determine if the selected plan is an upgrade or downgrade. Matches the
	 * server (change_subscription_plan), which compares RAW price amounts: a
	 * higher amount is an immediate prorated upgrade, a lower one is scheduled
	 * for the next renewal. (Comparing normalized monthly cost mislabels
	 * cross-interval switches, e.g. monthly→annual.)
	 */
	const changeDirection = useMemo(() => {
		if (!selectedPlan) return null;
		const currentPlan = subscriptionPlans.find((p) => p.stripePriceId === currentPriceId);
		if (!currentPlan) return 'change';
		if (selectedPlan.amountCents > currentPlan.amountCents) return 'upgrade';
		if (selectedPlan.amountCents < currentPlan.amountCents) return 'downgrade';
		return 'change';
	}, [selectedPlan, currentPriceId, subscriptionPlans]);

	/** Handle plan selection -- skip if it's the current plan. */
	const handleSelect = (plan: CheckoutPlan) => {
		if (plan.stripePriceId === currentPriceId) return;
		setSelectedPlan(plan);
		setError(null);
	};

	/** Handle upgrade confirmation. */
	const handleConfirm = async () => {
		if (!selectedPlan || upgrading || !isValidSelection) return;
		setUpgrading(true);
		setError(null);
		try {
			await onUpgrade(selectedPlan.stripePriceId);
			setSuccess(true);
			// Auto-close after a brief success display
			setTimeout(() => onClose(), 1500);
		} catch (e: any) {
			setError(e?.message ?? 'Plan change failed. Please try again.');
		} finally {
			setUpgrading(false);
		}
	};

	/** Build the confirm button label based on selection state. */
	const buttonLabel = () => {
		if (upgrading) return 'Processing...';
		if (!selectedPlan) return 'Select a plan';
		if (!isValidSelection) return 'Current plan';
		const verb = changeDirection === 'downgrade' ? 'Downgrade' : 'Upgrade';
		return `${verb} to ${selectedPlan.nickname} (${planAmount(selectedPlan)})`;
	};

	return (
		<div style={S.overlay} onClick={onClose}>
			<div style={S.dialog} onClick={(e) => e.stopPropagation()}>
				{/* Header */}
				<div style={S.header}>
					<div style={S.title}>Change Plan</div>
					<button style={S.close} onClick={onClose}>&#10005;</button>
				</div>

				{success ? (
					<div style={S.success}>
						{changeDirection === 'downgrade'
							? 'Downgrade scheduled! Your current plan stays active until the end of this billing period.'
							: 'Plan upgraded! Your new features and prorated token credits are available now.'}
					</div>
				) : (
					<>
						{compact && selectedPlan ? (
							/* Focused confirmation: caller preselected the plan, so summarise
							   it instead of re-showing the picker. */
							<div style={S.currentPlan}>
								<span style={S.currentLabel}>Switch to</span>
								<span style={{ color: 'var(--rr-text-primary)', fontWeight: 600 }}>
									{selectedPlan.nickname} &middot; {planAmount(selectedPlan)}
								</span>
							</div>
						) : (
							<>
								{/* Current plan info */}
								<div style={S.currentPlan}>
									<span style={S.currentLabel}>Current</span>
									<span style={{ color: 'var(--rr-text-primary)', fontWeight: 600 }}>
										{currentPlanName ?? 'Unknown plan'}
									</span>
								</div>

								{/* Plan picker -- reuses the same card grid */}
								<PlanPicker
									plans={subscriptionPlans}
									selectedPlan={selectedPlan}
									onSelectPlan={handleSelect}
									currentPriceId={currentPriceId}
								/>
							</>
						)}

						{/* Proration info -- explains what happens on upgrade vs downgrade */}
						{isValidSelection && changeDirection === 'upgrade' && (
							<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', lineHeight: 1.5, marginTop: 8 }}>
								You will be charged the prorated difference for the remainder of your current billing period. Token credits will be adjusted accordingly.
							</div>
						)}
						{isValidSelection && changeDirection === 'downgrade' && (
							<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)', lineHeight: 1.5, marginTop: 8 }}>
								Your current plan will remain active until the end of your billing period. The new plan takes effect at your next renewal.
							</div>
						)}

						{/* Error banner */}
						{error && <div style={S.error}>{error}</div>}

						{/* Footer with confirm button */}
						<div style={S.footer}>
							<button
								style={commonStyles.buttonSecondary as CSSProperties}
								onClick={onClose}
								disabled={upgrading}
							>
								Cancel
							</button>
							<button
								style={{
									...(isValidSelection && !upgrading
										? commonStyles.buttonPrimary
										: { ...commonStyles.buttonPrimary, opacity: 0.5, cursor: 'default' }),
								} as CSSProperties}
								onClick={handleConfirm}
								disabled={!isValidSelection || upgrading}
							>
								{buttonLabel()}
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
};
