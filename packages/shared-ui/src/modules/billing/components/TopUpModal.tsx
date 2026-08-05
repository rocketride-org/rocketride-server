// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TopUpModal -- modal dialog for purchasing token top-up packs.
 *
 * Rendered through the stock {@link Modal} (one
 * stock Modal for every dialog). The Modal owns the backdrop, box, header,
 * and footer chrome -- including the zIndex 2000 overlay layer that stacks
 * above record panels (DetailPanel, zIndex 1500) and the shared
 * Escape-closes-topmost-layer behavior. This file supplies only the body
 * content and the footer actions.
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
import { Modal } from '../../../components/modal/Modal';
import { PlanPicker, planAmount } from '../../checkout/PlanPicker';
import type { CheckoutPlan } from '../../checkout/types';

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

	// Confirm button style: primary, dimmed and non-interactive unless a pack
	// is selected and no purchase is in flight.
	const confirmStyle: CSSProperties = {
		...commonStyles.buttonPrimary,
		...(selectedPlan && !purchasing ? null : { opacity: 0.5, cursor: 'default' }),
	};

	return (
		/* Stock Modal: inert backdrop (clicking outside never closes), Escape
		   closes only the topmost overlay layer. No corner ✕ (showClose false):
		   dismissal is the footer Cancel, Escape, or the success auto-close timer
		   (refined popup policy 2026-07-08 — no redundant ✕ when an explicit
		   close or auto-dismiss exists). Escape is suppressed while the purchase
		   is in flight, mirroring the disabled Cancel button. */
		<Modal
			title="Add More Capacity"
			onClose={onClose}
			width={600}
			showClose={false}
			closeOnEscape={!purchasing}
			footer={success ? undefined : (
				<>
					{/* Cancel — the dialog's explicit dismiss control. */}
					<button
						type="button"
						style={commonStyles.buttonSecondary}
						onClick={onClose}
						disabled={purchasing}
					>
						Cancel
					</button>
					{/* Confirm — label reflects selection and in-flight state. */}
					<button
						type="button"
						style={confirmStyle}
						onClick={handleConfirm}
						disabled={!selectedPlan || purchasing}
					>
						{purchasing ? 'Processing...' : selectedPlan ? `Purchase ${planAmount(selectedPlan)}` : 'Select a pack'}
					</button>
				</>
			)}
		>
			{success ? (
				/* Success confirmation — shown briefly until the auto-close timer
				   dismisses the dialog (the footer is dropped in this state). */
				<div style={S.success}>Purchase successful! Your tokens have been added.</div>
			) : (
				<div style={S.body}>
					{/* Plan picker -- reuses the same card grid */}
					<PlanPicker
						plans={topupPlans}
						selectedPlan={selectedPlan}
						onSelectPlan={setSelectedPlan}
					/>

					{/* Error banner */}
					{error && <div style={S.error}>{error}</div>}
				</div>
			)}
		</Modal>
	);
};
