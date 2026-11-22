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
 * Launch parameters — the query an app switch writes before the app mounts.
 *
 * `shell:switchApp` may carry `params` (plan 9.1, G3): the keys the target
 * app reads from its own location at mount, such as the `?pipe=<address>` an
 * agent tile binds its host app with. The shell writes them into the URL of
 * the history entry the switch pushes, and records which keys it wrote in
 * that entry's state, so the next switch drops them again: one launch's
 * binding never reaches the next app, and Back restores an entry with its
 * own parameters. A key the shell did not write (a deep link's own query)
 * is never touched. Pure, so node:test drives it directly.
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** The `history.state` key that records the parameters a switch wrote. */
export const LAUNCH_PARAMS_STATE_KEY = 'rrLaunchParams';

// =============================================================================
// TYPES
// =============================================================================

/** The query of a switch, and the keys it wrote. */
export interface LaunchSearch {
	/** The new `location.search` ('' when no parameter remains, else '?...'). */
	search: string;
	/** The keys this switch wrote, to be dropped by the next one. */
	keys: string[];
}

// =============================================================================
// FUNCTIONS
// =============================================================================

/**
 * The keys a history entry records as written by its switch.
 *
 * @param state - A `history.state` value (anything; foreign shapes read as none).
 * @returns The recorded keys, strings only.
 */
export function launchKeysOf(state: unknown): string[] {
	const recorded = (state as Record<string, unknown> | null | undefined)?.[LAUNCH_PARAMS_STATE_KEY];
	return Array.isArray(recorded) ? recorded.filter((key): key is string => typeof key === 'string') : [];
}

/**
 * The query a switch lands on: the current one without the keys the previous
 * switch wrote, with this switch's parameters set.
 *
 * @param search - The current `location.search`.
 * @param previousKeys - The keys the previous switch wrote ({@link launchKeysOf}).
 * @param params - This switch's parameters; a blank key or a non-string value is skipped.
 * @returns The new search and the keys this switch wrote.
 */
export function launchSearch(search: string, previousKeys: readonly string[], params?: Record<string, string>): LaunchSearch {
	const query = new URLSearchParams(search);
	for (const key of previousKeys) query.delete(key);
	const keys: string[] = [];
	for (const [key, value] of Object.entries(params ?? {})) {
		if (!key || typeof value !== 'string') continue;
		query.set(key, value);
		keys.push(key);
	}
	const text = query.toString();
	return { search: text ? `?${text}` : '', keys };
}
