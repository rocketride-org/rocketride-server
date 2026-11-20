// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// KEY EXPIRY — what the "Create key" reveal shows as the new key's expiry
// =============================================================================

/** The expiry shown when a new key is revealed. */
export interface RevealedKeyExpiry {
	/** ISO timestamp, or null when the key does not expire. */
	expiresAt: string | null;
	/** True when the server granted an EARLIER expiry than requested (or one where none was asked for). */
	bounded: boolean;
}

/**
 * Milliseconds of a server timestamp. The server sends naive UTC (no offset),
 * which `Date.parse` would read as local time; the same rule as
 * `parseWireDate` in ./components/shared.
 */
function wireMillis(iso: string): number {
	const trimmed = iso.trim();
	if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return Date.parse(trimmed);
	return Date.parse(`${trimmed.replace(' ', 'T')}Z`);
}

/**
 * The expiry to show for a key just created: the one the server GRANTED, not
 * the one requested. A SaaS server caps a key created over a sign-in session
 * at that session's bound, so "never expires" (or a far date) can come back
 * as a nearer date; the UI must not show "No expiry" for such a key.
 *
 * @param requested - The expiry the form asked for (ISO), or undefined for none.
 * @param granted - `createKey()`'s `expiresAt`: the granted ISO timestamp,
 *   null when the key does not expire, or undefined when the server did not
 *   report it (an older server: the requested value is shown, as before).
 * @returns The expiry to show, and whether it is earlier than requested.
 */
export function revealedKeyExpiry(requested: string | undefined, granted: string | null | undefined): RevealedKeyExpiry {
	if (granted === undefined) return { expiresAt: requested ?? null, bounded: false };
	if (granted === null) return { expiresAt: null, bounded: false };
	// The server stores the requested timestamp as sent, so an uncapped key comes
	// back equal to it. A second of slack only absorbs storage rounding; a session
	// cap even 30 seconds earlier (a sign-in just before a 90-day request) is marked.
	const bounded = requested === undefined || wireMillis(granted) < wireMillis(requested) - 1_000;
	return { expiresAt: granted, bounded };
}

/** Parameters of a create-key request. */
type CreateKeyParams = { name: string; permissions: string[]; expiresAt?: string; teamId?: string };

/**
 * Pick the create-key callback the panel calls. An expiry-aware host callback
 * is used as-is. A legacy key-only callback is narrowed to `{ key }` so a
 * stray extra field (an older host returned a numeric `expiresAt`) is never
 * read as a granted expiry: the reveal then shows the requested one, as before.
 */
export function resolveCreateKey(withExpiry: ((params: CreateKeyParams) => Promise<{ key: string; expiresAt?: string | null }>) | undefined, legacy: (params: CreateKeyParams) => Promise<{ key: string }>): (params: CreateKeyParams) => Promise<{ key: string; expiresAt?: string | null }> {
	if (withExpiry) return withExpiry;
	return async (params) => ({ key: (await legacy(params)).key });
}
