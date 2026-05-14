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
// SETTINGS UTILITIES — common/override detection and resolution
// =============================================================================
//
// Detects "common" settings (keys declared by 2+ apps) and provides helpers
// for per-app overrides.  All storage uses the existing flat settings.json
// with key-pattern conventions:
//
//   <key>                        — common value
//   <appId>:<key>                — per-app override value
//   <appId>:useCommon:<key>      — override flag ('false' = using override)
//
// =============================================================================

import type { AppManifestEntry, AppSettingDefinition } from '../../workspace/types';

// =============================================================================
// TYPES
// =============================================================================

/** Result of analyzing all app manifests for common vs app-only settings. */
export interface SettingsAnalysis {
	/** Setting definitions that appear in 2+ apps (deduplicated, first wins). */
	commonDefs: AppSettingDefinition[];
	/** Per-app breakdown: which common keys the app uses, plus app-only settings. */
	perAppGroups: PerAppGroup[];
}

/** Settings breakdown for a single app. */
export interface PerAppGroup {
	/** The app manifest entry. */
	app: AppManifestEntry;
	/** Setting keys from this app that are also common (for checkbox rows). */
	commonKeys: string[];
	/** Setting definitions unique to this app (rendered normally). */
	appOnlyDefs: AppSettingDefinition[];
}

// =============================================================================
// KEY BUILDERS
// =============================================================================

/**
 * Builds the settings key for a per-app override value.
 *
 * @param appId - The app's unique identifier.
 * @param key   - The base setting key.
 * @returns The override key in the format `<appId>:<key>`.
 */
export function overrideKey(appId: string, key: string): string {
	return `${appId}:${key}`;
}

/**
 * Builds the settings key for the "use common" checkbox flag.
 *
 * @param appId - The app's unique identifier.
 * @param key   - The base setting key.
 * @returns The flag key in the format `<appId>:useCommon:<key>`.
 */
export function useCommonFlagKey(appId: string, key: string): string {
	return `${appId}:useCommon:${key}`;
}

/**
 * Returns true if a settings key is an internal override or flag key
 * (contains `:`) and should be excluded from normal display.
 *
 * @param key - The settings key to check.
 */
export function isInternalKey(key: string): boolean {
	return key.includes(':');
}

// =============================================================================
// ANALYSIS
// =============================================================================

/**
 * Scans all app manifests and partitions settings into common (2+ apps)
 * and app-only groups.
 *
 * @param appManifest - Array of all loaded app manifest entries.
 * @returns Analysis with common definitions and per-app breakdowns.
 */
export function analyzeSettings(appManifest: AppManifestEntry[]): SettingsAnalysis {
	// Step 1: count how many apps declare each key
	const keyInfo = new Map<string, { count: number; def: AppSettingDefinition }>();

	for (const app of appManifest) {
		for (const def of app.settings ?? []) {
			const existing = keyInfo.get(def.key);
			if (existing) {
				existing.count++;
			} else {
				keyInfo.set(def.key, { count: 1, def });
			}
		}
	}

	// Step 2: extract common keys (count >= 2)
	const commonKeySet = new Set<string>();
	const commonDefs: AppSettingDefinition[] = [];

	for (const [key, info] of keyInfo) {
		if (info.count >= 2) {
			commonKeySet.add(key);
			commonDefs.push(info.def);
		}
	}

	// Step 3: build per-app groups
	const perAppGroups: PerAppGroup[] = [];

	for (const app of appManifest) {
		const appSettings = app.settings ?? [];
		if (appSettings.length === 0) continue;

		const commonKeys: string[] = [];
		const appOnlyDefs: AppSettingDefinition[] = [];

		for (const def of appSettings) {
			if (commonKeySet.has(def.key)) {
				commonKeys.push(def.key);
			} else {
				appOnlyDefs.push(def);
			}
		}

		// Only include apps that have at least one setting to show
		if (commonKeys.length > 0 || appOnlyDefs.length > 0) {
			perAppGroups.push({ app, commonKeys, appOnlyDefs });
		}
	}

	return { commonDefs, perAppGroups };
}

/**
 * Returns the set of setting keys that are common (declared by 2+ apps).
 *
 * @param appManifest - Array of all loaded app manifest entries.
 */
export function getCommonKeys(appManifest: AppManifestEntry[]): Set<string> {
	const counts = new Map<string, number>();
	for (const app of appManifest) {
		for (const def of app.settings ?? []) {
			counts.set(def.key, (counts.get(def.key) ?? 0) + 1);
		}
	}
	const result = new Set<string>();
	for (const [key, count] of counts) {
		if (count >= 2) result.add(key);
	}
	return result;
}

// =============================================================================
// RESOLUTION
// =============================================================================

/**
 * Resolves the effective settings for a specific app, handling common
 * value vs per-app override based on the checkbox flag.
 *
 * For each common key:
 * - If `<appId>:useCommon:<key>` is not `'false'` → use the bare key value
 * - Otherwise → use the `<appId>:<key>` override value (falling back to bare)
 *
 * Non-common keys and internal keys (containing `:`) pass through unchanged.
 *
 * @param allSettings - The full flat settings map.
 * @param appId       - The active app's identifier.
 * @param commonKeys  - Set of keys that are common across apps.
 * @returns A resolved settings map with only bare keys (no internal keys).
 */
export function resolveSettingsForApp(
	allSettings: Record<string, string | undefined>,
	appId: string,
	commonKeys: Set<string>,
): Record<string, string | undefined> {
	const result: Record<string, string | undefined> = {};

	for (const [key, value] of Object.entries(allSettings)) {
		// Skip internal override/flag keys — they're not consumed by apps
		if (isInternalKey(key)) continue;

		if (commonKeys.has(key)) {
			// Check if this app overrides the common value
			const usesCommon = allSettings[useCommonFlagKey(appId, key)] !== 'false';
			if (usesCommon) {
				result[key] = value;
			} else {
				result[key] = allSettings[overrideKey(appId, key)] ?? value;
			}
		} else {
			result[key] = value;
		}
	}

	return result;
}
