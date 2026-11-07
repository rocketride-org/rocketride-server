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
