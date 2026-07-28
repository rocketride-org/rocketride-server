// =============================================================================
// CONNECTION ERRORS — typed failures surfaced by connection backends
// =============================================================================

/** A connection failure whose kind determines the UI recovery action. */
export class ConnectionFailure extends Error {
	constructor(
		message: string,
		public readonly kind: 'auth' | 'network' | 'server',
	) {
		super(message);
		this.name = 'ConnectionFailure';
	}
}

/**
 * Bound an operation and cancel its client-side state before reporting timeout.
 * Late completion is deliberately ignored after timeout so it cannot revive a
 * login that the caller has already treated as failed.
 */
export function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	timeoutError: Error,
	cleanup: () => Promise<unknown>,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timedOut = false;

		const timeout = setTimeout(async () => {
			if (settled || timedOut) return;
			timedOut = true;
			clearTimeout(timeout);
			try {
				await cleanup();
			} catch {
				// The timeout error remains the recovery signal even if cleanup fails.
			}
			reject(timeoutError);
		}, timeoutMs);

		const clearTimer = () => {
			clearTimeout(timeout);
		};

		operation.then(
			(value) => {
				if (settled || timedOut) return;
				settled = true;
				clearTimer();
				resolve(value);
			},
			(error) => {
				if (settled || timedOut) return;
				settled = true;
				clearTimer();
				reject(error);
			},
		);
	});
}
