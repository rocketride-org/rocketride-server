// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// AGENT ENTRY - how home-ui shows and opens a published pipeline (an "agent",
// the external naming rule) among its apps. The Catalog and the desktop list
// agents beside the apps as `kind: 'pipe'` entries (plan 9.1, Step 6b.4): the
// row reads "Agent" whatever its categories say, and opening one switches to
// its host app bound to its address (`shell:switchApp` with `params.pipe`).
// The launch rule is the shell's (`switchAppRequestOf`, from the shell
// barrel); a host shell that predates it opens every entry by its id. Pure
// apart from the injected emitter and shell surface; unit-tested under
// node:test.
// =============================================================================

import { formatCategory } from './formatCategory';

/** What the UI calls a published pipeline: an agent row's sublabel. */
export const AGENT_LABEL = 'Agent';

/** The entry facts this module reads (a catalog entry or a desktop tile). */
export type CatalogEntry = {
	id: string;
	kind?: string;
	pipe?: string;
	hostAppId?: string;
	categories?: string[];
	/** False on an entry published to the caller's own space, a team or the org (not the store). */
	public?: boolean;
	/** The permissions an app requires of its caller; a caller lacking them is not shown it. */
	requiredPermissions?: string[];
};

/** A `shell:switchApp` payload. */
export type SwitchAppRequest = { appId: string; params?: Record<string, string> };

/** The slice of the shell surface a launch reads (absent on an older host shell). */
export type LaunchSurface = { switchAppRequestOf?: (entry: CatalogEntry) => SwitchAppRequest };

/** The slice of the shell's ConnectionManager a launch needs: its emit for shell:switchApp. */
export type SwitchAppEmitter = { emit(event: 'shell:switchApp', payload: SwitchAppRequest): void };

/**
 * Whether an entry is an agent (a published pipeline) rather than an app.
 *
 * @param entry - The entry.
 * @returns True for `kind: 'pipe'`.
 */
export function isAgentEntry(entry: Pick<CatalogEntry, 'kind'>): boolean {
	return entry.kind === 'pipe';
}

/**
 * The sublabel under an entry's name: "Agent" for an agent, else its first category.
 *
 * @param entry - The entry.
 * @returns The label, or null when an app names no category.
 */
export function entryLabel(entry: CatalogEntry): string | null {
	if (isAgentEntry(entry)) return AGENT_LABEL;
	return entry.categories?.[0] ? formatCategory(entry.categories[0]) : null;
}

/**
 * Whether an anonymous catalog fetch would return an entry.
 *
 * The server lists an anonymous caller the store's public apps that require
 * no permission. A signed-in catalog holds more: agents (signed-in callers
 * only), the caller's own non-public publications (`public: false`), and apps
 * gated by `requiredPermissions` the caller holds.
 *
 * @param entry - A catalog entry.
 * @returns True when a signed-out viewer may keep it.
 */
export function isAnonymousEntry(entry: CatalogEntry): boolean {
	return !isAgentEntry(entry) && entry.public !== false && !entry.requiredPermissions?.length;
}

/**
 * The catalog entries a signed-out viewer keeps: what an anonymous fetch
 * would return ({@link isAnonymousEntry}), without the per-account enrichment
 * (`onDesktop`, `appStatus`).
 *
 * @param entries - The catalog as a signed-in fetch returned it.
 * @returns The anonymous entries, without enrichment.
 */
export function signedOutEntries<T extends CatalogEntry>(entries: readonly T[]): T[] {
	return entries.filter(isAnonymousEntry).map((entry) => ({ ...entry, onDesktop: false, appStatus: undefined }));
}

/**
 * Open an entry: an app by its id, an agent through its host app.
 *
 * @param cm - The shell's ConnectionManager (anything with its emit).
 * @param shell - The shell surface (`getShellApi()`); its `switchAppRequestOf` decides.
 * @param entry - The entry to open.
 */
export function launchEntry(cm: SwitchAppEmitter, shell: LaunchSurface, entry: CatalogEntry): void {
	const request = typeof shell.switchAppRequestOf === 'function' ? shell.switchAppRequestOf(entry) : { appId: entry.id };
	cm.emit('shell:switchApp', request);
}
