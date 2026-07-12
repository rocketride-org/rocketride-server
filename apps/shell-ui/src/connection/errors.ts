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

/** Race a promise against a timeout and always release the timer. */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: Error): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(timeoutError), timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}
