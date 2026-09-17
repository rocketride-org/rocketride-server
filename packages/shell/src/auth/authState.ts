// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// OAuth `state` contributor — one opaque value carried across a sign-in.
//
// The authorization request's `state` parameter round-trips verbatim through
// the identity provider, so it is the one way to carry something across a
// full-page redirect WITHOUT writing to the device. An app that needs that
// (carrying a referral reference through signup, returning to a deep link)
// registers a contributor here and the shell threads the value through.
//
// The shell validates SHAPE, never meaning: it does not know or care what the
// value encodes. Keep it opaque and url-safe — base64url of your own JSON is
// the obvious choice.
//
// ONE slot, not a list. Merging two contributors would put ordering and
// collision semantics into the platform, which is exactly the kind of policy
// this module exists to avoid.

/** Supplies an opaque, url-safe value to ride the OAuth `state` parameter. */
export type AuthStateProvider = () => string | null;

// `state` lands in a URL, so keep it well clear of browser and IdP limits.
const MAX_STATE_LENGTH = 2048;

// base64url plus the padding some encoders leave on.
const STATE_PATTERN = /^[A-Za-z0-9._~\-+/=]+$/;

let contributor: AuthStateProvider | null = null;

/**
 * Register the contributor asked for a `state` value on every sign-in.
 *
 * Registering is safe any time before the visitor signs in — `signIn()` runs
 * from a user gesture, so an app that registers on mount is always in place.
 * A second registration REPLACES the first and warns; the slot is single by
 * design.
 *
 * @param fn - Called at sign-in; return null to carry nothing.
 * @returns An unregister function (only clears if `fn` is still registered).
 */
export function registerAuthStateProvider(fn: AuthStateProvider): () => void {
	if (contributor !== null && contributor !== fn) {
		console.warn('[authState] replacing an already-registered auth-state provider — the slot holds one');
	}
	contributor = fn;
	return () => {
		if (contributor === fn) contributor = null;
	};
}

/**
 * Ask the contributor for this sign-in's `state`.
 *
 * INTERNAL to the shell (CloudAuthProvider). Never throws and never lets a bad
 * value reach the authorize URL: a contributor that throws, returns a
 * non-string, overruns the length cap or uses characters that would need URL
 * escaping is treated as "nothing to carry".
 *
 * @returns The value to send as `state`, or null.
 */
export function collectAuthState(): string | null {
	if (contributor === null) return null;
	try {
		const value = contributor();
		if (typeof value !== 'string' || value.length === 0) return null;
		if (value.length > MAX_STATE_LENGTH) {
			console.warn(`[authState] provider returned ${value.length} chars (cap ${MAX_STATE_LENGTH}) — dropping`);
			return null;
		}
		if (!STATE_PATTERN.test(value)) {
			console.warn('[authState] provider returned characters outside the url-safe set — dropping');
			return null;
		}
		return value;
	} catch (err) {
		console.warn('[authState] provider threw — carrying no state:', err);
		return null;
	}
}

/** Test hook: clear the registered contributor. */
export function resetAuthStateForTests(): void {
	contributor = null;
}
