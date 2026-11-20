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

// =============================================================================
// DEV TOOL PINS — the ONE toolbar list, for every host and every chrome
// =============================================================================
//
// One ordered array in the APP's prefs partition (its own workspace file,
// so it follows the person across browsers and machines — never
// localStorage, which is per-browser and silently diverges from the file
// everything else is read from, and never global.json, which is for what
// the SHELL is rather than for what an app's toolbar holds).
//
// The list is BOTH facts at once:
//
//   - the ORDER of the toolbar buttons, top to bottom, and
//   - WHICH dev tools exist for this person — so it is also the map of what
//     actually needs loading (the store entries; builtins are in the bundle).
//
// It replaced two keys that disagreed: `devToolPins` held the tool set,
// `sidebarTabOrder` held the strip order, and the workbench rail kept a
// THIRD order of its own in localStorage. Three writers, one concept.
//
//   [ "builtin.toolStore", "rocketride.sql", "builtin.apps", … ]
//
// `builtin.<id>` names something the host bundle already carries (a builtin
// tool, or a chrome container like Explorer); a bare id names a store tool
// by its app id. Builtin ids keep their declared casing — the container id
// round-trips exactly rather than being lowercased and guessed back.
//
// An id no chrome declares is kept, not dropped: a tool the server has not
// listed yet (or a container another app owns) must survive a reorder here
// and reappear where it was.
//
// LEAF MODULE — no imports. The VS Code EXTENSION HOST program compiles this
// too (DevToolStore), and that program has neither the DOM lib nor React, so
// nothing here may reach the shell's barrel. The realm-facing hook lives in
// useDevToolPins.ts beside it.
// =============================================================================

/**
 * The sidebar chrome's slice of an APP's prefs.
 *
 * App state, not shell settings: global.json carries what the shell itself
 * is (theme, chrome style), while which buttons an app's toolbar shows and
 * which one is selected belong to that app's own workspace file. One app's
 * arrangement has no business reordering another's.
 */
export interface SidebarPrefsMap {
	/** The one ordered toolbar list (see this file's header). */
	devToolPins?: string[];
	/**
	 * The selected sidebar container id — which toolbar button is active.
	 *
	 * SELECTION, not geometry: it cannot flash on boot (the chrome that
	 * reads it cannot mount before the app has declared its containers), so
	 * it belongs in the workspace file rather than in a localStorage hint.
	 */
	sidebarActiveView?: string;
}

/** Prefs key: the one ordered toolbar list. */
export const DEV_TOOL_PINS_KEY = 'devToolPins';

/** Marks an entry the host bundle carries (builtin tool or chrome container). */
export const BUILTIN_PIN_PREFIX = 'builtin.';

/**
 * The pin id for a chrome container id.
 *
 * @param containerId - `tool:<appId>` for a store tool, else a builtin id.
 * @returns The pin id.
 */
export function pinIdOf(containerId: string): string {
	return containerId.startsWith('tool:')
		? containerId.slice('tool:'.length)
		: `${BUILTIN_PIN_PREFIX}${containerId}`;
}

/**
 * The chrome container id for a pin id — the inverse of {@link pinIdOf}.
 *
 * @param pinId - A `builtin.<id>` or a store tool's app id.
 * @returns The container id.
 */
export function containerIdOf(pinId: string): string {
	return pinId.startsWith(BUILTIN_PIN_PREFIX)
		? pinId.slice(BUILTIN_PIN_PREFIX.length)
		: `tool:${pinId}`;
}

/**
 * Whether a pin names a STORE tool — the entries that have to be loaded.
 *
 * @param pinId - The pin id.
 * @returns True for a store tool.
 */
export function isStoreToolPin(pinId: string): boolean {
	return !pinId.startsWith(BUILTIN_PIN_PREFIX);
}

/**
 * Reads the list out of a prefs bag, tolerating anything that is not one.
 *
 * @param prefs - A shell-partition prefs snapshot.
 * @returns The pins, or an empty list.
 */
export function readDevToolPins(prefs: Record<string, unknown> | undefined): string[] {
	const raw = prefs?.[DEV_TOOL_PINS_KEY];
	return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * The store-tool app ids in the list, in order — what a host must load.
 *
 * @param pins - The pin list.
 * @returns The store tool app ids.
 */
export function storeToolIds(pins: readonly string[]): string[] {
	return pins.filter(isStoreToolPin);
}

/**
 * Orders declared containers by the pin list.
 *
 * Containers the list names come first, in its order; anything it does not
 * name keeps its declared position after them — a chrome that grows a new
 * container shows it without the person having to re-drag anything.
 *
 * @param items - The declared containers, in their default order.
 * @param pins - The pin list.
 * @returns The items, ordered.
 */
export function orderByPins<T extends { id: string }>(items: readonly T[], pins: readonly string[]): T[] {
	if (pins.length === 0) return [...items];
	const rank = new Map(pins.map((pinId, i) => [containerIdOf(pinId), i]));
	return items
		.map((item, declared) => ({ item, declared, rank: rank.get(item.id) }))
		.sort((a, b) => {
			if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank;
			if (a.rank !== undefined) return -1;
			if (b.rank !== undefined) return 1;
			return a.declared - b.declared;
		})
		.map(({ item }) => item);
}

/**
 * Folds a chrome's new container order back into the full pin list.
 *
 * Only the containers THIS chrome declares were draggable, so every other
 * entry (a store tool the server has not listed, a container belonging to a
 * different app) is preserved at its existing index rather than dropped.
 *
 * @param orderedContainerIds - The chrome's containers, in their new order.
 * @param pins - The current pin list.
 * @returns The list to persist.
 */
export function applyContainerOrder(orderedContainerIds: readonly string[], pins: readonly string[]): string[] {
	const moved = orderedContainerIds.map(pinIdOf);
	const movedSet = new Set(moved);
	const out: string[] = [];
	let next = 0;
	// Walk the existing list, substituting the reordered ids in sequence at
	// the slots they already occupied; untouched entries keep their place.
	for (const pinId of pins) {
		if (movedSet.has(pinId)) {
			const replacement = moved[next++];
			if (replacement !== undefined) out.push(replacement);
			continue;
		}
		out.push(pinId);
	}
	// Anything newly named (a container the list had never seen) appends.
	for (; next < moved.length; next++) {
		const pinId = moved[next]!;
		if (!out.includes(pinId)) out.push(pinId);
	}
	return out;
}
