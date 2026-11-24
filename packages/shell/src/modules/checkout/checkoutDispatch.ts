const NOT_DISPATCHED = 'CheckoutNotDispatched';

export function checkoutNotDispatched(): Error {
	const error = new Error('The active checkout account changed. Reopen checkout.');
	error.name = NOT_DISPATCHED;
	return error;
}

export function isCheckoutNotDispatched(error: unknown): error is Error {
	// The broker restores the error name after the webview JSON hop.
	return error instanceof Error && error.name === NOT_DISPATCHED;
}

/**
 * The server answered the billing request with `success: false` (the SDK's
 * `call()` raises `CommandException` only for that). The message is the
 * server's own, so it can be shown. It does NOT prove that nothing happened: an
 * uncaught handler exception after Stripe already acted looks the same on the
 * wire. Callers may offer a retry only with the SAME attempt ID, which the
 * server dedupes. A timeout or dropped connection raises something else.
 */
export function isServerRejection(error: unknown): error is Error {
	return error instanceof Error && error.name === 'CommandException';
}
