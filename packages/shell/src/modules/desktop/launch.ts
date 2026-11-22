// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DESKTOP LAUNCH — how a tile opens: an app by its id, an agent through its host
// =============================================================================
//
// An AGENT (a published pipeline, plan 9.1) is no app of its own: its entry
// names the host app that opens it and the address that app binds with
// `?pipe=<address>`. Pure (types only), so node:test drives it directly;
// adapter.ts emits what this decides, and the catalog picker and the desktop
// both launch through it.

import type { ShellConnectionEventMap } from '../../types/shell';

// =============================================================================
// CONSTANTS
// =============================================================================

/** What the UI calls a published pipeline (the external naming rule): the tile's sublabel. */
export const AGENT_LABEL = 'Agent';

/** The query parameter a host app reads its pipe from. */
export const PIPE_PARAM = 'pipe';

// =============================================================================
// TYPES
// =============================================================================

/** The entry facts a launch reads (an app entry, a catalog entry, a desktop tile). */
export interface LaunchableEntry {
	/** The app id, or the agent's address. */
	id: string;
	/** `'pipe'` on an agent. */
	kind?: string;
	/** An agent's address. */
	pipe?: string;
	/** The app an agent opens. */
	hostAppId?: string;
}

// =============================================================================
// FUNCTIONS
// =============================================================================

/**
 * Whether an entry is an agent (a published pipeline) rather than an app.
 *
 * @param entry - The entry.
 * @returns True for `kind: 'pipe'`.
 */
export function isAgent(entry: Pick<LaunchableEntry, 'kind'>): boolean {
	return entry.kind === 'pipe';
}

/**
 * The `shell:switchApp` request that opens an entry.
 *
 * An app opens by its id. An agent opens its host app with `params.pipe`
 * set to its address, which the shell writes into the location before the
 * host mounts. An agent entry missing either fact opens nothing better than
 * its id (the shell warns about an unknown app), never a host bound to
 * nothing.
 *
 * @param entry - The entry to open.
 * @returns The event payload.
 */
export function switchAppRequestOf(entry: LaunchableEntry): ShellConnectionEventMap['shell:switchApp'] {
	if (isAgent(entry) && entry.pipe && entry.hostAppId) {
		return { appId: entry.hostAppId, params: { [PIPE_PARAM]: entry.pipe } };
	}
	return { appId: entry.id };
}
