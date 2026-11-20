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

/**
 * The embedded sign-in popup role ('rrauth') across the OAuth round trip.
 *
 * The embedded shell opens `/?rrauth=1` in a popup named 'rrauth'; the popup
 * runs the top-level OAuth redirect and hands the session back. Shell
 * documents send `Cross-Origin-Opener-Policy: same-origin-allow-popups`
 * (#1022), so a popup whose opener sits in a cross-origin top-level page
 * starts in a new browsing context group, which clears `window.name`; the
 * IdP's redirect back drops `?rrauth=1`. The role is therefore remembered in
 * this tab's sessionStorage before the redirect, which survives both.
 *
 * The marker is narrow on purpose: it is set and read only in a top-level
 * window (a framed shell never redirects to the IdP), honoured only on the
 * IdP return leg (`code`, `error` or `state` in the URL), removed whenever it
 * is read, and ignored when older than thirty minutes (long enough for a
 * slow sign-up with email verification or MFA). Refreshing the callback URL
 * after the marker was read drops the role: sign in again.
 */

/** sessionStorage key marking this tab as the auth popup; the value is the epoch-ms time it was set. */
export const AUTH_POPUP_KEY = 'rr:auth:popup';

/** How long a remembered popup role stays valid. */
const AUTH_POPUP_TTL_MS = 30 * 60 * 1000;

/** URL parameters the IdP puts on the return leg. */
const RETURN_LEG_PARAMS = ['code', 'error', 'state'];

/** The Storage calls these helpers use (sessionStorage in the browser). */
type RoleStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Where the helpers run; each field defaults to the live browser value. */
export interface AuthPopupEnv {
	/** Where the role is remembered (sessionStorage). */
	storage?: RoleStorage | null;
	/** Whether this window is top-level (`window.self === window.top`). */
	topLevel?: boolean;
	/** The current time in epoch ms (`Date.now()`). */
	now?: number;
}

/**
 * The tab's sessionStorage, or null where it is unavailable.
 *
 * @returns sessionStorage, or null when reading it throws or it is absent.
 */
function sessionStore(): RoleStorage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}

/**
 * Whether this window is top-level.
 *
 * @returns True when `window.self === window.top`; false when framed or when the check throws.
 */
function isTopLevel(): boolean {
	try {
		return typeof window !== 'undefined' && window.self === window.top;
	} catch {
		return false;
	}
}

/**
 * Fill in the live browser values for any field the caller left out.
 *
 * @param env - The caller's overrides.
 * @returns A complete environment.
 */
function resolveEnv(env: AuthPopupEnv): Required<AuthPopupEnv> {
	return {
		storage: env.storage === undefined ? sessionStore() : env.storage,
		topLevel: env.topLevel ?? isTopLevel(),
		now: env.now ?? Date.now(),
	};
}

/**
 * Whether this window is the auth popup.
 *
 * A remembered role is read (and removed) only in a top-level window on the
 * IdP return leg, and honoured only when it is at most thirty minutes old.
 *
 * @param windowName - `window.name` (cleared by a browsing context group switch).
 * @param params - The page's query parameters (`?rrauth=1` on a fresh popup).
 * @param env - Storage, top-level flag and clock; defaults to the browser's.
 * @returns True for a fresh popup or one returning from the IdP.
 */
export function isAuthPopupWindow(windowName: string, params: URLSearchParams, env: AuthPopupEnv = {}): boolean {
	if (windowName === 'rrauth' || params.get('rrauth') === '1') return true;
	const { storage, topLevel, now } = resolveEnv(env);
	if (!storage || !topLevel || !RETURN_LEG_PARAMS.some((name) => params.has(name))) return false;
	try {
		const value = storage.getItem(AUTH_POPUP_KEY);
		storage.removeItem(AUTH_POPUP_KEY);
		if (value === null || !/^\d+$/.test(value)) return false;
		const age = now - Number(value);
		return age >= 0 && age <= AUTH_POPUP_TTL_MS;
	} catch {
		return false;
	}
}

/**
 * Remember the popup role for the rest of this tab's OAuth round trip.
 *
 * Does nothing in a framed window.
 *
 * @param env - Storage, top-level flag and clock; defaults to the browser's.
 */
export function rememberAuthPopup(env: AuthPopupEnv = {}): void {
	const { storage, topLevel, now } = resolveEnv(env);
	if (!topLevel) return;
	try {
		storage?.setItem(AUTH_POPUP_KEY, String(now));
	} catch {
		/* storage unavailable: window.name still works without COOP */
	}
}

/**
 * Forget the popup role once the popup has handed the session back.
 *
 * @param storage - Where it was remembered; defaults to sessionStorage.
 */
export function forgetAuthPopup(storage: RoleStorage | null = sessionStore()): void {
	try {
		storage?.removeItem(AUTH_POPUP_KEY);
	} catch {
		/* storage unavailable: nothing was remembered */
	}
}

/**
 * Whether a fresh popup should head to the IdP now: not when the URL already
 * carries an IdP return (`code`, or an `error` alone, which must not restart
 * sign-in and loop the user back to the IdP), and not when a session exists.
 *
 * @param params - The page's query parameters.
 * @param hasToken - Whether a session token is already stored.
 * @returns True when the popup should start the OAuth redirect.
 */
export function shouldStartPopupSignIn(params: URLSearchParams, hasToken: boolean): boolean {
	return !params.get('code') && !params.get('error') && !hasToken;
}

/** The slice of BroadcastChannel the session handoff uses. */
export interface IAuthChannel {
	postMessage(message: unknown): void;
	close(): void;
	onmessage: ((event: { data: unknown }) => void) | null;
}

/**
 * The popup side of the handoff: post the session until the embedded preview
 * ACKs it (a BroadcastChannel post has no delivery guarantee, and a preview
 * that is still loading misses it), then report success so the popup may close.
 *
 * @param token - The session token to hand over.
 * @param channel - The `rr:auth` channel (closed when done).
 * @param options - Retry interval and overall wait, in ms.
 * @returns True once acknowledged; false when no ACK arrived in time (the popup must stay open).
 */
export function deliverSession(token: string, channel: IAuthChannel, options: { intervalMs?: number; timeoutMs?: number } = {}): Promise<boolean> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setInterval> | undefined;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		const finish = (ok: boolean): void => {
			clearInterval(timer);
			clearTimeout(deadline);
			channel.onmessage = null;
			try {
				channel.close();
			} catch {
				/* already closed */
			}
			resolve(ok);
		};
		channel.onmessage = (event) => {
			if ((event.data as { type?: unknown } | null | undefined)?.type === 'ack') finish(true);
		};
		const send = (): void => {
			try {
				channel.postMessage({ type: 'login', token });
			} catch {
				finish(false);
			}
		};
		send();
		timer = setInterval(send, options.intervalMs ?? 500);
		deadline = setTimeout(() => finish(false), options.timeoutMs ?? 15_000);
	});
}

/**
 * The embedded-preview side of the handoff: adopt a delivered session, ACK it
 * on the channel, and reload only when the token actually changed (the popup
 * re-posts until it hears the ACK, so a repeat must not reload again).
 *
 * @param data - The channel message.
 * @param deps - Token storage, the ACK post and the reload.
 */
export function receiveSession(data: unknown, deps: { loadToken(): string; saveToken(token: string): void; ack(): void; reload(): void }): void {
	const message = data as { type?: unknown; token?: unknown } | null | undefined;
	if (message?.type !== 'login' || typeof message.token !== 'string' || message.token === '') return;
	const fresh = deps.loadToken() !== message.token;
	if (fresh) deps.saveToken(message.token);
	deps.ack();
	if (fresh) deps.reload();
}
