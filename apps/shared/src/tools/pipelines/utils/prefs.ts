// =============================================================================
// ProjectView preference updates.
// =============================================================================

export function updateProjectPreference(prefs: Record<string, unknown>, key: string, value: unknown): { localPrefs: Record<string, unknown>; hostPatch: Record<string, unknown> } {
	return {
		localPrefs: { ...prefs, [key]: value },
		hostPatch: { [key]: value },
	};
}

/**
 * Schedule a local preference update and notify the host exactly once.
 *
 * React may evaluate a functional state updater more than once, so the host
 * notification happens once after scheduling that updater rather than within it.
 */
export function writeProjectPreference(
	setPrefs: (updater: (prefs: Record<string, unknown>) => Record<string, unknown>) => void,
	onPrefsChange: ((prefs: Record<string, unknown>) => void) | undefined,
	key: string,
	value: unknown,
): void {
	const hostPatch = { [key]: value };
	setPrefs((prefs) => updateProjectPreference(prefs, key, value).localPrefs);
	onPrefsChange?.(hostPatch);
}

export function mergeProjectPreferences(prefs: Record<string, unknown> | undefined, patch: Record<string, unknown>): Record<string, unknown> {
	return { ...prefs, ...patch };
}
