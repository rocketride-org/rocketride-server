// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CATALOG LOGIC — the picker's pure parts (paging, marker reconciliation)
// =============================================================================
//
// Kept free of React and of the connection so node:test can drive them
// directly (catalogLogic.test.ts); CatalogPicker.tsx wires them to the
// client and the identity.

/** The largest page `rrext_public_catalog` serves (the handler clamps `limit` to 100). */
export const CATALOG_PAGE_LIMIT = 100;

/** One `rrext_public_catalog` response page. */
export interface CatalogPage<T> {
	apps?: T[];
	total?: number;
	offset?: number;
	limit?: number;
}

/** Issues one catalog request with the given arguments. */
export type CatalogCall<T> = (args: Record<string, unknown>) => Promise<CatalogPage<T> | null | undefined>;

/**
 * Fetch the whole catalog, page by page.
 *
 * The verb pages with `offset`/`limit` and answers `total`; a small catalog
 * is ONE request (the first page already holds everything). Fetching stops
 * when the accumulated count reaches the server's total, when a page comes
 * back empty, or when a page is shorter than the limit (the server has no
 * more) — so a `total` that disagrees with the pages can never loop.
 *
 * @param call - Issues one request (`client.call('rrext_public_catalog', args)`).
 * @param baseArgs - Arguments every page carries (`action`, `shell`, ...).
 * @param limit - Page size (default the verb's maximum).
 * @returns Every entry, in server order, and the server's total.
 */
export async function fetchCatalogPages<T>(
	call: CatalogCall<T>,
	baseArgs: Record<string, unknown>,
	limit: number = CATALOG_PAGE_LIMIT,
): Promise<{ apps: T[]; total: number }> {
	const apps: T[] = [];
	let total = 0;
	let offset = 0;
	for (;;) {
		const body = await call({ ...baseArgs, offset, limit });
		const page = Array.isArray(body?.apps) ? body!.apps! : [];
		apps.push(...page);
		total = typeof body?.total === 'number' ? body.total : apps.length;
		if (page.length === 0 || page.length < limit || apps.length >= total) break;
		offset += page.length;
	}
	return { apps, total: Math.max(total, apps.length) };
}

/**
 * Drop the local "added" markers the identity has confirmed.
 *
 * The picker marks an app right after `desktop_add` resolves so the tile
 * reads Open before the identity push lands; once `isOnDesktop` reports the
 * app, the marker is redundant and must go, or a later remove (from the
 * desktop grid) would leave the tile on Open.
 *
 * @param prev - The current markers.
 * @param isOnDesktop - The identity's answer per app id.
 * @returns `prev` itself when nothing changed (so React skips the render),
 *   else the reduced set.
 */
export function reconcileAdded(prev: ReadonlySet<string>, isOnDesktop: (appId: string) => boolean): ReadonlySet<string> {
	const next = new Set([...prev].filter((id) => !isOnDesktop(id)));
	return next.size === prev.size ? prev : next;
}
