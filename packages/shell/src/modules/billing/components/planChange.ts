// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * What the server's `upgrade` billing subcommand reports. `upgraded` applies
 * the new plan now; `downgrade_scheduled` keeps the current plan until the
 * renewal on `effectiveDate`.
 */
export type PlanChangeOutcome =
	| { status: 'upgraded' }
	| { status: 'downgrade_scheduled'; effectiveDate?: string };

/**
 * Read the server's `upgrade` response. Returns null for a shape it does not
 * recognize: the request succeeded, so the change may already be applied, and
 * the caller should still refresh billing and confirm neutrally.
 */
export function parsePlanChangeOutcome(value: unknown): PlanChangeOutcome | null {
	if (!value || typeof value !== 'object' || !('status' in value)) return null;
	if (value.status === 'upgraded') return { status: 'upgraded' };
	if (value.status === 'downgrade_scheduled') {
		const effectiveDate = 'effectiveDate' in value && typeof value.effectiveDate === 'string' && value.effectiveDate
			? value.effectiveDate
			: undefined;
		return effectiveDate ? { status: 'downgrade_scheduled', effectiveDate } : { status: 'downgrade_scheduled' };
	}
	return null;
}

/**
 * Format a server date for the downgrade confirmation, or null if it is
 * unreadable. In UTC, so it shows the same day as Stripe's period end.
 */
function renewalDate(value: string): string | null {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? null
		: date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** Describe what the server actually did after confirmation. */
export function planChangeCompletion(result: void | PlanChangeOutcome | null): string {
	switch (result?.status) {
		case 'upgraded':
			return 'Plan upgraded. Your new plan is active now.';
		case 'downgrade_scheduled': {
			const date = result.effectiveDate ? renewalDate(result.effectiveDate) : null;
			return date
				? `Downgrade scheduled. Your current plan stays active until ${date}.`
				: 'Downgrade scheduled. Your current plan stays active until the end of this billing period.';
		}
		default:
			return 'Plan change requested. Your subscription shows its current status.';
	}
}
