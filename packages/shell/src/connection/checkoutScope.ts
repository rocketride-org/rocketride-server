import { RocketRideClient } from 'rocketride';
import type { DAPMessage } from 'rocketride';

export interface CheckoutScope {
	orgId: string;
	userId: string;
	server: string;
	replaySupported: boolean;
}

export function getCheckoutScope(client: RocketRideClient | null | undefined): CheckoutScope | null {
	if (!client?.isAuthenticated()) return null;
	const account = client.getAccountInfo();
	const orgId = account?.organization?.id;
	const userId = account?.userId;
	const uri = client.getConnectionInfo().uri;
	if (!orgId || !userId || !uri) return null;
	// The server may advertise this only when an earlier accepted attempt
	// can be resolved or refused safely on a repeat request.
	const replaySupported = Array.isArray(account?.capabilities) && account.capabilities.includes('billing_checkout_replay');
	return { orgId, userId, server: RocketRideClient.normalizeUri(uri), replaySupported };
}

export function matchesCheckoutScope(current: CheckoutScope | null, expected: CheckoutScope): boolean {
	return current !== null && current.orgId === expected.orgId && current.userId === expected.userId && current.server === expected.server &&
		(expected.replaySupported === false || (expected.replaySupported === true && current.replaySupported));
}

export function isCheckoutMutation(message: DAPMessage): boolean {
	const subcommand = message.arguments?.subcommand;
	return message.command === 'rrext_account_billing' &&
		(subcommand === 'subscribe' || subcommand === 'promo_redeem' || subcommand === 'confirm_pending');
}
