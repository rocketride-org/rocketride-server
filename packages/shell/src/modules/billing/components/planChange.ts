// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/** When a plan change takes effect. */
export type PlanChangeTiming = 'immediate' | 'next_renewal' | 'unchanged';

/**
 * A server preview. Only the direction, timing and interval-change
 * combinations that `parsePlanChangePreview` accepts type-check.
 */
export type PlanChangePreview =
	| { direction: 'upgrade'; timing: 'immediate'; billingIntervalChanges?: boolean }
	| { direction: 'downgrade'; timing: 'next_renewal'; billingIntervalChanges?: boolean }
	| { direction: 'interval_change'; timing: 'immediate' | 'next_renewal'; billingIntervalChanges?: true }
	| { direction: 'unchanged'; timing: 'unchanged'; billingIntervalChanges?: false };

/** A plan-change status that `parsePlanChangeOutcome` recognizes. */
export type PlanChangeStatus =
	| 'payment_failed'
	| 'failed'
	| 'requires_payment_method'
	| 'payment_pending'
	| 'requires_action'
	| 'downgrade_scheduled'
	| 'scheduled'
	| 'unchanged'
	| 'upgraded'
	| 'applied';

interface PlanChangeOutcomeFields {
	timing?: PlanChangeTiming;
	clientSecret?: string | null;
	stripePublishableKey?: string;
	/** Host guard called immediately before Stripe confirmation. */
	assertPaymentScope?: () => void;
}

/**
 * A server outcome. A `requires_action` outcome carries both Stripe fields,
 * since the modal cannot authenticate the payment without them.
 */
export type PlanChangeOutcome =
	| (PlanChangeOutcomeFields & { status: 'requires_action'; clientSecret: string; stripePublishableKey: string })
	| (PlanChangeOutcomeFields & { status: Exclude<PlanChangeStatus, 'requires_action'> });

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
			return { direction, timing, billingIntervalChanges } as PlanChangePreview;
		}
	}
	throw new Error('The server returned an invalid plan change preview. Try again.');
}

const planChangeTimings = new Map<string, PlanChangeTiming | null>([
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
