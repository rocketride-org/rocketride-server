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
