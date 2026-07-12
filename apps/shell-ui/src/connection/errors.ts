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
