// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// APP CATALOG FETCH — the home-ui `useStoreApps` pattern, for the bus
// =============================================================================
//
// Catalog rows ARE manifest entries (`AppManifestEntry` — publisher, readme,
// categories, appStatus, onDesktop, the lot); this module declares NO row
// type of its own. The query shape mirrors home-ui's `useStoreApps`
// (`offset`/`limit`/`search`/`category`/`shell`) and is passed through to
// the wire verbatim, so callers page instead of a library hoarding one list.
//
// The transport is the client's `rrext_app list` call — through the realm
// client in a webview realm, the real client at a root, so every surface
// makes the SAME call. Deliberately `rrext_app list`, not
// `rrext_public_catalog`: the picker needs the caller's @me and
// @team rows, which the public store verb filters off by design. And never
// the ACCOUNT list (the user's desktop — a tool not yet gotten can never
// appear) nor the MF REGISTRATION list (bundle wiring). Both were used as
// catalogs once; five surfaces broke.
// =============================================================================

// Type-only deep import — the ext host compiles this leaf too.
import type { AppManifestEntry } from 'shell/src/components/workspace/types';

/** The minimal client surface the fetch needs — a realm client and the ext
 *  host's real client both satisfy it structurally. */
export interface ICatalogClient {
	call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** Catalog query parameters — the same shape home-ui's useStoreApps sends. */
export interface CatalogQuery {
	/** Pagination offset (default 0). */
	offset?: number;
	/** Page size (server caps at 100). */
	limit?: number;
	/** Substring filter on name/description. */
	search?: string;
	/** Category filter (NOTE: documented on the wire, implemented by no
	 *  edition yet — filter client-side until it lands). */
	category?: string;
	/** Shell compatibility filter ("saas", "oss", "vscode"). */
	shell?: string;
}

/** One catalog page, as the wire returns it. */
export interface CatalogPage {
	apps: AppManifestEntry[];
	total?: number;
	offset?: number;
	limit?: number;
}

/** An entry's dev-tool membership (`categories` contains 'devTool'). */
export function isDevToolEntry(entry: { categories?: unknown[] }): boolean {
	return (entry.categories ?? []).some((c) => String(c).toLowerCase() === 'devtool');
}

/**
 * One page of the app catalog — the caller's reachable @me/@team/@public
 * rows, manifest-shaped.
 *
 * @param client - The realm's client, or null while disconnected (rejects
 *                 with the standard not-connected error).
 * @param query - Pagination/filter parameters, passed through verbatim.
 * @returns The page as returned by the wire.
 */
export async function fetchAppCatalog(client: ICatalogClient | null | undefined, query?: CatalogQuery): Promise<CatalogPage> {
	if (!client) throw new Error('Not connected to server');
	const body = await client.call<CatalogPage | undefined>('rrext_app', { subcommand: 'list', ...(query ?? {}) });
	return { apps: body?.apps ?? [], total: body?.total, offset: body?.offset, limit: body?.limit };
}

/**
 * The dev-tool catalog: reachable apps carrying the devTool category,
 * name-sorted. A convenience over {@link fetchAppCatalog} for the picker
 * surfaces; the category filters client-side (see {@link CatalogQuery}).
 *
 * @param client - See {@link fetchAppCatalog}.
 * @returns Dev-tool entries, sorted by display name.
 */
export async function fetchDevToolCatalog(client: ICatalogClient | null | undefined): Promise<AppManifestEntry[]> {
	const page = await fetchAppCatalog(client);
	return page.apps.filter(isDevToolEntry).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}
