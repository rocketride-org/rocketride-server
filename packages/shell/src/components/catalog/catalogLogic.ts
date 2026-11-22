// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CATALOG LOGIC — the picker's pure parts (paging, marker reconciliation,
// README paths and their fetch)
// =============================================================================
//
// Kept free of React and of the connection so node:test can drive them
// directly (catalogLogic.test.ts); CatalogPicker.tsx wires them to the
// client, the identity and the browser's fetch.

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

/**
 * Whether a catalog entry's `readme` names a README the picker can fetch.
 *
 * The catalog sends a URL path on the serving origin
 * (`/pipelines/<id>/v<N>/README.md`, `/apps/<id>/v<N>/README.md`), and the
 * browser's cookie authorizes the fetch. Only such a path qualifies: an
 * absent value, a non-string, a relative path, an absolute URL and a
 * `//host` network-path reference (another origin) are all "no README".
 *
 * @param readme - The entry's `readme` as the catalog sent it.
 * @returns True for a path on this origin.
 */
export function isReadmePath(readme: unknown): readme is string {
	return typeof readme === 'string' && /^\/(?![/\\])/.test(readme);
}

/**
 * The base URL of a README path: its folder, up to and including the last
 * `/` of the path (a query or fragment is not part of the path). Relative
 * images and links in the README resolve against it.
 *
 * @param readmePath - A README path ({@link isReadmePath}).
 * @returns The folder, ending in `/`.
 */
export function readmeBaseUrl(readmePath: string): string {
	const path = readmePath.split(/[?#]/, 1)[0];
	return path.slice(0, path.lastIndexOf('/') + 1);
}

/** Issues one README request: the browser's `fetch`, narrowed to what the load reads. */
export type ReadmeFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>;

/**
 * Fetch a README's markdown.
 *
 * A response that is not OK (the entry ships no README, or the caller may
 * not read it) and a request that fails or is aborted are all "no README".
 *
 * @param get - Issues the request (`fetch`).
 * @param readmePath - The README path ({@link isReadmePath}).
 * @param signal - Aborts the request once its answer is no longer wanted.
 * @returns The markdown, or '' when there is no README.
 */
export async function fetchReadme(get: ReadmeFetch, readmePath: string, signal: AbortSignal): Promise<string> {
	try {
		const response = await get(readmePath, { signal });
		return response.ok ? await response.text() : '';
	} catch {
		return '';
	}
}
