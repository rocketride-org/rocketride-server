// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Subscription gate — the ONE account-derived predicate both hosts apply.
 *
 * Pipeline execution and deployment are gated behind an active subscription
 * on SaaS servers. PURE LEAF: takes the account snapshot (the SDK's cached
 * ConnectResult, or a realm's mirrored shell:account copy) — no client, no
 * shell import.
 */

/** The account facts the gate reads — structural on purpose. */
export interface SubscriptionAccountLike {
	capabilities?: string[];
	apps?: Array<{ id: string; appStatus?: string }>;
}

/**
 * Returns true if pipeline execution is allowed for the given app.
 *
 * Ungated when there is no account (caller handles connection errors
 * separately) or the server is not SaaS. Gated when connected to a SaaS
 * server and the app has no active/trialing subscription (past_due means
 * payment failed — lock until resolved).
 *
 * @param info - The account snapshot (undefined/null when disconnected).
 * @param appId - App identifier to check (e.g. the pipe builder's id).
 * @returns True if the user may execute pipelines.
 */
export function isAppSubscribed(info: SubscriptionAccountLike | null | undefined, appId: string): boolean {
	if (!info) return true;
	// OSS / on-prem servers don't enforce subscriptions.
	if (!(info.capabilities ?? []).includes('saas')) return true;
	const entry = (info.apps ?? []).find((a) => a.id === appId);
	if (!entry) return false;
	return entry.appStatus === 'subscribed' || entry.appStatus === 'trialing';
}
