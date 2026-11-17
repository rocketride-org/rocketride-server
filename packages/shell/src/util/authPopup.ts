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
 */

/** sessionStorage key marking this tab as the auth popup. */
export const AUTH_POPUP_KEY = 'rr:auth:popup';

/** The Storage calls these helpers use (sessionStorage in the browser). */
type RoleStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

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
 * Whether this window is the auth popup.
 *
 * @param windowName - `window.name` (cleared by a browsing context group switch).
 * @param params - The page's query parameters (`?rrauth=1` on a fresh popup).
 * @param storage - Where the role is remembered; defaults to sessionStorage.
 * @returns True for a fresh popup or one returning from the IdP.
 */
export function isAuthPopupWindow(windowName: string, params: URLSearchParams, storage: RoleStorage | null = sessionStore()): boolean {
	if (windowName === 'rrauth' || params.get('rrauth') === '1') return true;
	try {
		return storage?.getItem(AUTH_POPUP_KEY) === '1';
	} catch {
		return false;
	}
}

/**
 * Remember the popup role for the rest of this tab's OAuth round trip.
 *
 * @param storage - Where to remember it; defaults to sessionStorage.
 */
export function rememberAuthPopup(storage: RoleStorage | null = sessionStore()): void {
	try {
		storage?.setItem(AUTH_POPUP_KEY, '1');
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
