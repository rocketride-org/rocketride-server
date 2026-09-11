// =============================================================================
// ProjectView preference updates.
// =============================================================================

export function updateProjectPreference(prefs: Record<string, unknown>, key: string, value: unknown): { localPrefs: Record<string, unknown>; hostPatch: Record<string, unknown> } {
	return {
		localPrefs: { ...prefs, [key]: value },
		hostPatch: { [key]: value },
	};
}

export function mergeProjectPreferences(prefs: Record<string, unknown> | undefined, patch: Record<string, unknown>): Record<string, unknown> {
	return { ...prefs, ...patch };
}
