// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
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

/**
 * Sets a browser cookie with an optional expiration period.
 * Safe to call in SSR environments where `document` may not exist.
 *
 * @param name - The cookie name.
 * @param value - The cookie value.
 * @param days - Optional number of days until the cookie expires. If omitted, the cookie is a session cookie.
 */
export function setCookie(name: string, value: string, days?: number): void {
	let expires = '';
	if (days) {
		// Compute the expiration date by converting days to milliseconds
		const date = new Date();
		date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
		expires = '; expires=' + date.toUTCString();
	}
	// Guard against SSR environments where document is not available
	if (typeof document !== 'undefined') {
		document.cookie = name + '=' + (value || '') + expires + '; path=/';
	}
}

/**
 * Retrieves the value of a browser cookie by name.
 * Returns `null` if the cookie does not exist or if `document` is unavailable (SSR).
 *
 * @param name - The cookie name to look up.
 * @returns The cookie value, or `null` if not found.
 */
export function getCookie(name: string): string | null {
	// Guard against SSR environments where document is not available
	if (typeof document === 'undefined') {
		return null;
	}
	// Build the search prefix: "name=" to locate within the cookie string
	const nameEQ = name + '=';
	// Split the full cookie string into individual cookie entries
	const ca = document.cookie.split(';');
	for (let i = 0; i < ca.length; i++) {
		let c = ca[i];
		// Strip leading whitespace from each cookie entry
		while (c.charAt(0) === ' ') c = c.substring(1, c.length);
		// If this entry starts with the target name, extract and return its value
		if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
	}
	return null;
}

/**
 * Deletes a browser cookie by setting its Max-Age to a negative value.
 * Safe to call in SSR environments.
 *
 * @param name - The name of the cookie to delete.
 */
export function deleteCookie(name: string): void {
	// Guard against SSR; set Max-Age to a negative value to expire the cookie immediately
	if (typeof document !== 'undefined') {
		document.cookie = name + '=; Max-Age=-99999999; path=/';
	}
}
