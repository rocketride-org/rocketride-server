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
// WORKSPACE-BACKED PREFS STORE — this host's PrefsStore implementation
// =============================================================================
//
// The browser host's storage backend for the shell's prefs-store seam: the
// server-side workspace prefs bag (roams with the workspace). Writes merge
// through the workspace provider; reads serve synchronously from the
// provider's current snapshot. The 'global' durability scope is not yet
// distinct in this host — every key roams with the workspace.
// =============================================================================

import { useEffect, useMemo, useRef } from 'react';
import { useWorkspace } from 'shell';
import type { PrefsStore } from 'shell';

/**
 * The realm's workspace-backed PrefsStore. Stable identity across renders;
 * subscribers fire whenever the workspace prefs bag changes.
 *
 * Hydration: the workspace provider loads prefs before the sidebar chrome
 * mounts, so `ready` resolves immediately — tools mounted under this host
 * never observe a pre-hydration snapshot.
 *
 * @returns The store.
 */
export function useWorkspacePrefsStore(): PrefsStore {
	const { prefs, updatePrefs } = useWorkspace();
	const state = useRef<{ values: Record<string, unknown>; subs: Set<() => void> }>({ values: {}, subs: new Set() });
	state.current.values = prefs as unknown as Record<string, unknown>;
	useEffect(() => {
		state.current.subs.forEach((cb) => cb());
	}, [prefs]);
	return useMemo<PrefsStore>(() => ({
		snapshot: () => state.current.values,
		get: (key) => state.current.values[key],
		set: (key, value) => updatePrefs({ [key]: value } as Parameters<typeof updatePrefs>[0]),
		subscribe: (cb) => {
			state.current.subs.add(cb);
			return () => { state.current.subs.delete(cb); };
		},
		ready: Promise.resolve(),
	}), [updatePrefs]);
}
