/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Safe `sessionStorage` accessors.
 *
 * Bare `sessionStorage` access throws a `SecurityError` in strict privacy
 * modes (Safari Private Browsing, Chrome Incognito with third-party storage
 * blocked, or when the UI is embedded in a sandboxed iframe). When that throw
 * happens at module-eval time or during the initial React render, it aborts
 * the whole render cycle and the user gets a blank white screen.
 *
 * These helpers swallow the exception and fall back to a harmless default so
 * the app degrades to in-memory/limited functionality instead of crashing.
 *
 * NOTE: This helper is intentionally duplicated across the UI apps that do not
 * share a common workspace package. Keep the copies in sync — apply any bug fix
 * or new method (e.g. `clear`) to all three:
 *   - apps/chat-ui/src/utils/safeStorage.ts
 *   - apps/dropper-ui/src/utils/safeStorage.ts
 *   - apps/shell-ui/src/util/safeStorage.ts
 */
export const safeSessionStorage = {
	/**
	 * Read a value from `sessionStorage`, returning `null` if storage is
	 * unavailable or the key is missing.
	 */
	getItem(key: string): string | null {
		try {
			return sessionStorage.getItem(key);
		} catch {
			return null;
		}
	},

	/**
	 * Write a value to `sessionStorage`. No-ops if storage is unavailable.
	 */
	setItem(key: string, value: string): void {
		try {
			sessionStorage.setItem(key, value);
		} catch {
			/* storage unavailable — degrade gracefully */
		}
	},

	/**
	 * Remove a value from `sessionStorage`. No-ops if storage is unavailable.
	 */
	removeItem(key: string): void {
		try {
			sessionStorage.removeItem(key);
		} catch {
			/* storage unavailable — degrade gracefully */
		}
	},
};
