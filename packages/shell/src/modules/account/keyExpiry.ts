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
 * which `Date.parse` would read as local time, so a zone-less datetime is read
 * as UTC. This is a deliberate copy of the rule in `parseWireDate`
 * (./components/shared): this file stays import-free so `node:test` can load it
 * without the shell's React/TSX graph. Keep the two in step.
 */
function wireMillis(iso: string): number {
	const trimmed = iso.trim();
	// Already zoned (Z or an offset): parse verbatim.
	if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return Date.parse(trimmed);
	// Zone-less datetime: normalize the separator and stamp UTC.
	if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)) return Date.parse(`${trimmed.replace(' ', 'T')}Z`);
	return Date.parse(trimmed);
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
	// The wire value is untyped: anything but a non-blank string (or null) is read as
	// "not reported" rather than thrown on, since the key is already minted.
	if (granted === undefined || (granted !== null && (typeof granted !== 'string' || granted.trim() === ''))) return { expiresAt: requested ?? null, bounded: false };
	if (granted === null) return { expiresAt: null, bounded: false };
	// The server stores the requested timestamp as sent, so an uncapped key comes
	// back equal to it. A second of slack only absorbs storage rounding; a session
	// cap even 30 seconds earlier (a sign-in just before a 90-day request) is marked.
	const bounded = requested === undefined || wireMillis(granted) < wireMillis(requested) - 1_000;
	return { expiresAt: granted, bounded };
}

/**
 * The UTC calendar day ('YYYY-MM-DD') of a server timestamp, the same day both
 * CLIs print, so every surface agrees whatever the viewer's time zone. An
 * unreadable value is returned as it came.
 *
 * @param iso - A server timestamp (zoned, or zone-less UTC).
 * @returns The UTC day, or `iso` when it does not parse.
 */
export function utcDay(iso: string): string {
	const ms = wireMillis(iso);
	return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(0, 10);
}
