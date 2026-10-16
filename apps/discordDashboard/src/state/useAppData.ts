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
// useUiPrefs — the only thing left in the workspace slice
// =============================================================================
//
// The app's DATA lives in Postgres (`src/db/`). What is left here is one
// viewer's preferences: the screen they were on, the tab, and the filter
// chips they had turned on. Nothing shared, nothing anybody else can see,
// nothing that matters if it is lost.
//
// WHY THIS IS NOT THE OLD HOOK WITH FEWER FIELDS. The old one existed to
// RECONCILE two sessions writing the same blob — a merge by settings
// sub-page, by message id, by OR, by union — because the workspace file was
// the store and two tabs really could overwrite each other's data. None of
// that is needed for a preference. Two tabs disagreeing about which chip is
// on is not a conflict; it is two tabs.
//
// THE VERSION-1 SLICE IS IGNORED, NOT DELETED. `mithilesh_clock.discordDashboard`
// still holds whatever the last version wrote, and the one-off import script
// reads exactly that key. Deleting another tool's input is not this hook's
// call, so the preferences live under a key of their own.
// =============================================================================

import { useCallback, useMemo } from 'react';
import { useWorkspace } from 'shell';
import { DEFAULT_UI_PREFS, UI_STATE_KEY, type QualityTabId, type ScreenId, type SettingsTabId, type UiPrefs, type UpdateUiPrefs } from './types';

/** What {@link useUiPrefs} returns. */
export interface UseUiPrefs {
	/** The preferences, defaults filled in. */
	ui: UiPrefs;
	/** True once the persisted workspace has been read from disk. */
	loaded: boolean;
	/** Merge a patch into them. */
	patchUi: UpdateUiPrefs;
}

// =============================================================================
// NORMALISATION
// =============================================================================

/** One value as a member of a known set, or the default. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** The screens, for the stored value's test. */
const SCREENS: ScreenId[] = ['bot', 'conversations', 'quality', 'knowledge', 'settings'];

/** The Settings sub-pages. */
const SETTINGS_TABS: SettingsTabId[] = ['discord', 'behavior', 'pipeline', 'advanced', 'eval'];

/** The Quality tabs. */
const QUALITY_TABS: QualityTabId[] = ['scorecard', 'review', 'replay'];

/**
 * Normalise whatever the workspace holds into complete preferences.
 *
 * Every field is validated rather than trusted: a preference read back as a
 * screen id that no longer exists would render nothing at all, which is a
 * blank app over a value that costs one click to re-set.
 *
 * @param raw - The value stored under {@link UI_STATE_KEY}.
 * @returns Complete preferences.
 */
export function normalizeUiPrefs(raw: unknown): UiPrefs {
	const stored = (raw ?? {}) as Partial<UiPrefs>;
	const filters = stored.conversationFilters;
	return {
		version: 2,
		screen: oneOf(stored.screen, SCREENS, DEFAULT_UI_PREFS.screen),
		settingsTab: oneOf(stored.settingsTab, SETTINGS_TABS, DEFAULT_UI_PREFS.settingsTab),
		qualityTab: oneOf(stored.qualityTab, QUALITY_TABS, DEFAULT_UI_PREFS.qualityTab),
		conversationFilters: filters !== null && typeof filters === 'object' && !Array.isArray(filters) ? (filters as Record<string, string | string[]>) : {},
		reviewFilters: Array.isArray(stored.reviewFilters) ? stored.reviewFilters.filter((entry): entry is string => typeof entry === 'string') : DEFAULT_UI_PREFS.reviewFilters,
	};
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Read and write this viewer's UI preferences.
 *
 * @returns The preferences plus their updater — see {@link UseUiPrefs}.
 */
export function useUiPrefs(): UseUiPrefs {
	const { loaded, appState, updateAppState } = useWorkspace();

	const ui = useMemo(() => normalizeUiPrefs(appState[UI_STATE_KEY]), [appState]);

	const patchUi = useCallback<UpdateUiPrefs>(
		(patch) => {
			updateAppState((prev) => {
				// `prev` is the freshest slice this session holds, so two patches in
				// one tick do not lose the first.
				const latest = normalizeUiPrefs(prev[UI_STATE_KEY]);
				return { ...prev, [UI_STATE_KEY]: { ...latest, ...patch, version: 2 } };
			});
		},
		[updateAppState]
	);

	return { ui, loaded, patchUi };
}
