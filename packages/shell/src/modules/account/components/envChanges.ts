// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * The changes a saved draft makes to a scope's environment.
 *
 * Each named row is sent as typed (an untouched row still holds the mask, which
 * keeps the stored value); a stored name the draft no longer has is sent as
 * null, which deletes it. Rows with an empty name are skipped.
 *
 * @param draft  - The editor's rows, as [name, value] pairs.
 * @param stored - The names the server listed, each mapped to the mask.
 * @returns Names to set, keep (mask) or delete (null).
 */
export function envChanges(draft: [string, string][], stored: Record<string, string> | undefined): Record<string, string | null> {
	const changes: Record<string, string | null> = {};
	for (const [k, v] of draft) {
		const key = k.trim();
		if (key) changes[key] = v;
	}
	for (const key of Object.keys(stored ?? {})) {
		if (!(key in changes)) changes[key] = null;
	}
	return changes;
}
