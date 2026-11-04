// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// The analytics-consent RECORD — the one cross-boundary storage contract.
//
// The shell owns the consent machinery (store, banner, Settings toggle); this
// module owns only the record's SHAPE: the localStorage key, the versioned
// expiring format, and the pure parser. It lives in the SDK because readers
// on the sign-in path (signup attribution, PKCE send boundary) must read the
// record WITHOUT booting any analytics and without importing the shell —
// pure, dependency-free, node-testable. There is deliberately no writer
// here: writing consent is the shell's alone.
// =============================================================================

/** The localStorage key of the record (the version lives INSIDE the record, `v`). */
export const CONSENT_KEY = 'rr:consent';
/** Bump to re-prompt every visitor (a policy change). */
export const CONSENT_VERSION = 1;
/** A stored choice older than this reads as undecided (12 months). */
export const CONSENT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** What a visitor can choose: opt in, or decline. */
export type ConsentChoice = 'accepted' | 'rejected';
/** A choice, or 'undecided' while there is no valid record. */
export type ConsentState = 'undecided' | ConsentChoice;

/** The stored record. */
export type ConsentRecord = {
	/** The consent version it was given under (CONSENT_VERSION). */
	v: number;
	/** The choice. */
	choice: ConsentChoice;
	/** When it was made (ms since the epoch); it expires CONSENT_TTL_MS later. */
	at: number;
};

function isSignalEnabled(value: unknown): boolean {
	return value === true || value === 1 || value === '1' || value === 'yes';
}

/**
 * Read the browser's DNT/GPC signals before any analytics path runs.
 * PostHog's cookieless mode does not enforce respect_dnt itself. One copy,
 * like the record parser: the consent surfaces, the capture gates and the
 * sign-in-path readers all honor the same signals.
 *
 * @returns True for an enabled signal; false outside a browser.
 */
export function privacySignalOn(): boolean {
	try {
		const nav = navigator as Navigator & { msDoNotTrack?: unknown; globalPrivacyControl?: unknown };
		const win = window as Window & { doNotTrack?: unknown };
		return isSignalEnabled(nav.doNotTrack) || isSignalEnabled(nav.msDoNotTrack) || isSignalEnabled(win.doNotTrack) || isSignalEnabled(nav.globalPrivacyControl);
	} catch {
		return false;
	}
}

/**
 * Parse a stored record; anything malformed, of another version or expired reads as undecided.
 *
 * @param raw - The stored text, or null when there is none.
 * @param now - The current time (ms since the epoch).
 * @param version - The consent version a valid record carries.
 * @returns The record, or null when there is no valid one.
 */
export function parseConsent(raw: string | null, now: number, version = CONSENT_VERSION): ConsentRecord | null {
	if (!raw) {
		return null;
	}
	try {
		const r = JSON.parse(raw) as Partial<ConsentRecord> | null;
		if (!isValidRecord(r, now, version)) {
			return null;
		}
		return { v: r.v, choice: r.choice, at: r.at };
	} catch {
		return null;
	}
}

/**
 * Whether a parsed record holds now: our shape, this version, a choice, and a time within the record's life (a
 * minute of clock skew allowed).
 *
 * @param r - The parsed value.
 * @param now - The current time (ms since the epoch).
 * @param version - The consent version a valid record carries.
 * @returns True for a valid record.
 */
function isValidRecord(r: Partial<ConsentRecord> | null, now: number, version: number): r is ConsentRecord {
	if (!r || typeof r !== 'object' || r.v !== version) {
		return false;
	}
	if (r.choice !== 'accepted' && r.choice !== 'rejected') {
		return false;
	}
	if (typeof r.at !== 'number' || !Number.isFinite(r.at)) {
		return false;
	}
	return now - r.at <= CONSENT_TTL_MS && r.at - now <= 60_000;
}
