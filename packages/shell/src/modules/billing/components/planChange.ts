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
		const validIntervalChange = billingIntervalChanges === undefined || (
			typeof billingIntervalChanges === 'boolean' &&
			(direction !== 'interval_change' || billingIntervalChanges) &&
			(direction !== 'unchanged' || !billingIntervalChanges)
		);
		if (validTransition && validIntervalChange) {
			return { direction, timing, billingIntervalChanges };
		}
	}
	throw new Error('The server returned an invalid plan change preview. Try again.');
}

const planChangeTimings = new Map<string, PlanChangePreview['timing'] | null>([
	['payment_failed', null],
	['failed', null],
	['requires_payment_method', null],
	['payment_pending', null],
	['requires_action', null],
	['downgrade_scheduled', 'next_renewal'],
	['scheduled', 'next_renewal'],
	['unchanged', 'unchanged'],
	['upgraded', 'immediate'],
	['applied', 'immediate'],
]);

/** Validate a server outcome before discarding the recovery attempt. */
export function parsePlanChangeOutcome(value: unknown): PlanChangeOutcome {
	if (value && typeof value === 'object' && 'status' in value && typeof value.status === 'string') {
		const result = value as PlanChangeOutcome;
		const expectedTiming = planChangeTimings.get(result.status);
		const { timing, clientSecret, stripePublishableKey } = result;
		const validTiming = timing === undefined ||
			((timing === 'immediate' || timing === 'next_renewal' || timing === 'unchanged') &&
				(expectedTiming === null || timing === expectedTiming));
		const validCredentials = (clientSecret == null || typeof clientSecret === 'string') &&
			(stripePublishableKey === undefined || typeof stripePublishableKey === 'string');
		const canAuthenticate = result.status !== 'requires_action' ||
			(typeof clientSecret === 'string' && clientSecret.trim() &&
				typeof stripePublishableKey === 'string' && stripePublishableKey.trim());
		if (expectedTiming !== undefined && validTiming && validCredentials && canAuthenticate) return result;
	}
	throw new Error('The server returned an invalid plan change result. Try again.');
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
