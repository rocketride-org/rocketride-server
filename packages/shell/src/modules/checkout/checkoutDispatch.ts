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
 * The server answered the billing request with an explicit failure. The SDK's
 * `call()` raises `CommandException` only for a `success: false` response, so
 * the request reached the server and was refused: retrying is safe. A timeout or
 * a dropped connection raises something else and stays ambiguous.
 */
export function isServerRejection(error: unknown): error is Error {
	return error instanceof Error && error.name === 'CommandException';
}
