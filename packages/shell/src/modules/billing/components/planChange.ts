// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

export interface PlanChangePreview {
	direction: 'upgrade' | 'downgrade' | 'interval_change' | 'unchanged';
	timing: 'immediate' | 'next_renewal' | 'unchanged';
	billingIntervalChanges?: boolean;
}

export interface PlanChangeOutcome {
	status: string;
	timing?: PlanChangePreview['timing'];
	clientSecret?: string | null;
	stripePublishableKey?: string;
	/** Host guard called immediately before Stripe confirmation. */
	assertPaymentScope?: () => void;
}

/** Read a preview from a connected server before enabling confirmation. */
export function parsePlanChangePreview(value: unknown): PlanChangePreview {
	if (value && typeof value === 'object' && 'direction' in value && 'timing' in value) {
		const { direction, timing } = value;
		const billingIntervalChanges = 'billingIntervalChanges' in value ? value.billingIntervalChanges : undefined;
		const validTransition =
			(direction === 'upgrade' && timing === 'immediate') ||
			(direction === 'downgrade' && timing === 'next_renewal') ||
			(direction === 'interval_change' && (timing === 'immediate' || timing === 'next_renewal')) ||
			(direction === 'unchanged' && timing === 'unchanged');
		if (validTransition && (billingIntervalChanges === undefined || typeof billingIntervalChanges === 'boolean')) {
			return { direction, timing, billingIntervalChanges };
		}
	}
	throw new Error('The server returned an invalid plan change preview. Try again.');
}

/** Describe what the server actually applied after confirmation. */
export function planChangeCompletion(result: void | PlanChangeOutcome): { message: string; pending: boolean } {
	switch (result?.status) {
		case 'payment_failed':
		case 'failed':
			throw new Error('Payment failed. Your current plan stays active.');
		case 'requires_payment_method':
			return { message: 'Update your payment method to finish the change. Your current plan stays active.', pending: true };
		case 'payment_pending':
		case 'requires_action':
			return { message: 'Payment is still pending. Your current plan stays active until payment completes.', pending: true };
		case 'downgrade_scheduled':
		case 'scheduled':
			return { message: 'Plan change scheduled. Your current plan stays active until renewal.', pending: false };
		case 'unchanged':
			return { message: 'Your current plan stays active.', pending: false };
		case 'upgraded':
		case 'applied':
			return { message: 'Plan change applied.', pending: false };
		default:
			return { message: 'Plan change requested.', pending: false };
	}
}
