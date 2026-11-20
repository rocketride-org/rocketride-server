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
// EXPLORER HISTORY — PER-CONNECTION FLAGS (a boolean per connection key)
// =============================================================================
//
// Some per-connection switches live in the workspace preferences as a bag
// `{ [connectionKey]: boolean }` — SQL Explorer's `sql.patternChecks` is one.
// This reads and writes such a bag, and applies the same legacy-key rule as
// the history store: a value saved under the connection's OLD key still counts
// until the connection has a value of its own, so a choice made before the key
// format changed (a pattern check switched off, say) is not silently undone.
//
// The stored shape never changes: a plain object of booleans keyed by
// connection key. Writing touches only the connection's own entry and leaves
// the legacy entry exactly as it was.
// =============================================================================

import { isPlainObject } from '../checks';
import type { IPrefsAccessor } from './types';

/** What distinguishes one flag bag from another. */
export interface IConnectionFlagsOptions {
	/** The preference key holding the bag (for example 'sql.patternChecks'). */
	prefKey: string;
	/** The value of a connection with no stored value. */
	defaultValue: boolean;
	/** Maps a connection key to the key its flag was saved under before the key format changed, or null. */
	legacyKeyOf?: (key: string) => string | null;
}

/** Reads and writes one flag bag. */
export interface IConnectionFlags {
	/**
	 * A connection's flag: its own stored value, else its legacy key's, else the default.
	 *
	 * @param prefs - The preferences accessor.
	 * @param key - The connection's key.
	 * @returns The flag.
	 */
	read(prefs: Pick<IPrefsAccessor, 'getPref'>, key: string): boolean;
	/**
	 * Store a connection's flag under ITS OWN key, leaving every other entry untouched.
	 *
	 * @param prefs - The preferences accessor.
	 * @param key - The connection's key.
	 * @param on - The value.
	 */
	write(prefs: IPrefsAccessor, key: string, on: boolean): void;
}

/**
 * Create a flag accessor over one preference bag.
 *
 * @param options - The preference key, default and legacy mapping.
 * @returns The accessor.
 */
export function createConnectionFlags(options: IConnectionFlagsOptions): IConnectionFlags {
	/**
	 * Read the bag as a plain object ({} when it is absent or damaged).
	 *
	 * @param prefs - The accessor.
	 * @returns The bag.
	 */
	const bagOf = (prefs: Pick<IPrefsAccessor, 'getPref'>): Record<string, unknown> => {
		const bag = prefs.getPref(options.prefKey);
		return isPlainObject(bag) ? bag : {};
	};
	return {
		read(prefs, key) {
			const bag = bagOf(prefs);
			const own = bag[key];
			if (typeof own === 'boolean') return own;
			const legacy = options.legacyKeyOf?.(key) ?? null;
			const old = legacy === null || legacy === key ? undefined : bag[legacy];
			return typeof old === 'boolean' ? old : options.defaultValue;
		},
		write(prefs, key, on) {
			prefs.setPref(options.prefKey, { ...bagOf(prefs), [key]: on });
		},
	};
}
