// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TopUpModal -- modal dialog for purchasing token top-up packs.
 *
 * Reuses the PlanPicker card grid to display top-up plans (filtered by
 * metadata.kind === 'topup'). On selection and confirmation, calls the
 * host's purchase callback which charges the customer's card on file
 * via a server-side PaymentIntent.
 *
 * No Stripe Elements or payment form -- the customer's existing payment
 * method is charged directly. If 3D Secure is required (rare), the host
 * handles the confirmation separately.
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

/** Props for the TopUpModal component. */
export interface TopUpModalProps {
	/** All plans from app_prices -- the modal filters to kind='topup'. */
	plans: CheckoutPlan[];
	/** Called when the user confirms a purchase. Returns status from the server. */
	onPurchase: (plan: CheckoutPlan) => Promise<{ status: string; clientSecret?: string }>;
	/** Called when the modal is dismissed. */
	onClose: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

/** Modal dialog for purchasing token top-up packs. */
export const TopUpModal: React.FC<TopUpModalProps> = ({ plans, onPurchase, onClose }) => {
	const [selectedPlan, setSelectedPlan] = useState<CheckoutPlan | null>(null);
	const [purchasing, setPurchasing] = useState(false);
	const [success, setSuccess] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Filter to top-up plans only
	const topupPlans = useMemo(
		() => plans.filter((p) => p.metadata?.kind === 'topup' && p.isActive !== false),
		[plans],
	);

	/** Handle purchase confirmation. */
	const handleConfirm = async () => {
		if (!selectedPlan || purchasing) return;
		setPurchasing(true);
		setError(null);
		try {
			const result = await onPurchase(selectedPlan);
			if (result.status === 'succeeded') {
				setSuccess(true);
				// Auto-close after a brief success display
				setTimeout(() => onClose(), 1500);
			} else if (result.status === 'requires_action') {
				// 3DS required -- for now show a message; full inline handling is future work
				setError('Your card requires additional verification. Please try using the Stripe billing portal.');
			}
		} catch (e: any) {
			setError(e?.message ?? 'Purchase failed. Please try again.');
		} finally {
			setPurchasing(false);
		}
	};

	return (
		<div style={S.overlay} onClick={purchasing ? undefined : onClose}>
			<div style={S.dialog} onClick={(e) => e.stopPropagation()}>
				{/* Header */}
				<div style={S.header}>
					<div style={S.title}>Add More Capacity</div>
					<button style={S.close} onClick={purchasing ? undefined : onClose} disabled={purchasing}>&#10005;</button>
				</div>

				{success ? (
					<div style={S.success}>Purchase successful! Your tokens have been added.</div>
				) : (
					<>
						{/* Plan picker -- reuses the same card grid */}
						<PlanPicker
							plans={topupPlans}
							selectedPlan={selectedPlan}
							onSelectPlan={setSelectedPlan}
						/>

						{/* Error banner */}
						{error && <div style={S.error}>{error}</div>}

						{/* Footer with confirm button */}
						<div style={S.footer}>
							<button
								style={commonStyles.buttonSecondary as CSSProperties}
								onClick={onClose}
								disabled={purchasing}
							>
								Cancel
							</button>
							<button
								style={{
									...(selectedPlan && !purchasing ? commonStyles.buttonPrimary : { ...commonStyles.buttonPrimary, opacity: 0.5, cursor: 'default' }),
								} as CSSProperties}
								onClick={handleConfirm}
								disabled={!selectedPlan || purchasing}
							>
								{purchasing ? 'Processing...' : selectedPlan ? `Purchase ${planAmount(selectedPlan)}` : 'Select a pack'}
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
};
