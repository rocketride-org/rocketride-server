// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// PIPE PICKER LOGIC — the picker's pure parts (plan 3.6, C.16c)
// =============================================================================
//
// The pipe picker binds a pipe-bound front end (chat, dropper, sql) to ONE
// node of ONE pipe. Its data path is two server reads, nothing else:
//
//   rrext_public_catalog {kind: 'pipe'}           the caller's OWN-ORG
//       publications (@me, then @team in team order, each pipe at the rung
//       that answers it), or with `search` the store's @public rung: a
//       search, paged, never a listing (the verb refuses a blank term)
//   client.interfaces(address)                    the picked pipe's nodes by
//       catalog classType, answered from the pinned artifact, no engine
//
// Discovery never reads running tasks. The `pipe=` / `node=` deep-link
// parameters live here too, so every front end reads and writes them the
// same way. Kept free of React and of the connection so node:test drives
// it directly (pipePickerLogic.test.ts); PipePicker.tsx wires it up.
// =============================================================================

// =============================================================================
// CONSTANTS
// =============================================================================

/** The catalog verb's largest page (the handler clamps `limit` to 100). */
export const PIPE_PAGE_LIMIT = 100;

/** One page of store search results. */
export const STORE_PAGE_LIMIT = 20;

/** The deep-link parameter naming the pipe address. */
export const PIPE_PARAM = 'pipe';

/** The deep-link parameter naming the node (sql). */
export const NODE_PARAM = 'node';

/** An address: two or three dot-free segments of `[A-Za-z0-9_-]`. */
const ADDRESS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?$/;

// =============================================================================
// TYPES
// =============================================================================

/** The rung a publication answers the caller on. */
export type PipeRung = 'me' | 'team' | 'public';

/** One pipe publication, as the catalog verb lists it. */
export interface IPipeEntry {
	/** Always 'pipe'. */
	kind: 'pipe';
	/** The registry name `developerId.pipeId`. */
	id: string;
	/** The address to bind (the registry name; the default source answers). */
	pipe: string;
	/** Display name (the registry name when the publication has none). */
	name: string;
	/** The publisher's developer id. */
	publisher?: string;
	/** One-line description, possibly empty. */
	description?: string;
	/** The rung that answers the caller for this pipe. */
	rung: PipeRung;
	/** The version that rung points at. */
	version?: number;
	/** The answering team (`team` rung). */
	teamId?: string;
	/** The answering team's display name (`team` rung). */
	teamName?: string;
}

/** One catalog response page. */
export interface IPipePage {
	apps?: IPipeEntry[];
	total?: number;
	offset?: number;
	limit?: number;
}

/** Issues one `rrext_public_catalog` request with the given arguments. */
export type PipeCatalogCall = (args: Record<string, unknown>) => Promise<IPipePage | null | undefined>;

/** The `interfaces()` answer, as far as the picker reads it. */
export interface IInterfacesAnswer {
	/** address -> classType -> nodes */
	interfaces?: Record<string, Record<string, ReadonlyArray<{ nodeId?: string; name?: string } | null | undefined>>>;
}

/** One node of the requested interface. */
export interface IInterfaceNode {
	/** The address the node answers under (a source's own, else the pipe's). */
	address: string;
	/** The node's component id. */
	nodeId: string;
	/** The node's display name (the author's, else the id). */
	name: string;
}

/** What the person chose: one node of one pipe. */
export interface IPipeChoice {
	/** The address to bind: the key the node answered under. */
	address: string;
	/** The chosen node's component id. */
	nodeId: string;
	/** The node's display name. */
	nodeName: string;
	/** The picked pipe's display name. */
	pipeName: string;
}

/** The deep-link parameters a page was opened with. */
export interface IPipeLink {
	/** The `pipe=` address. */
	pipe: string;
	/** The `node=` component id, when given. */
	node?: string;
}

// =============================================================================
// THE CATALOG READS
// =============================================================================

/**
 * The entries of one page, keeping only well-formed pipe rows.
 *
 * @param body - The page as returned.
 * @returns The page's pipe entries.
 */
function entriesOf(body: IPipePage | null | undefined): IPipeEntry[] {
	const rows = Array.isArray(body?.apps) ? body!.apps! : [];
	return rows.filter((row) => row && row.kind === 'pipe' && typeof row.pipe === 'string' && row.pipe.length > 0);
}

/**
 * Every pipe publication of the caller's own org, page by page, in the
 * server's order (@me, then each team in team order).
 *
 * Stops when the accumulated count reaches the server's total, on an empty
 * page, or on a short one, so a `total` that disagrees with the pages can
 * never loop.
 *
 * @param call - Issues one request.
 * @returns The entries, in server order.
 */
export async function fetchOwnPipes(call: PipeCatalogCall): Promise<IPipeEntry[]> {
	const out: IPipeEntry[] = [];
	let offset = 0;
	for (;;) {
		const body = await call({ kind: 'pipe', offset, limit: PIPE_PAGE_LIMIT });
		const raw = Array.isArray(body?.apps) ? body!.apps!.length : 0;
		out.push(...entriesOf(body));
		const total = typeof body?.total === 'number' ? body.total : offset + raw;
		offset += raw;
		if (raw === 0 || raw < PIPE_PAGE_LIMIT || offset >= total) break;
	}
	return out;
}

/**
 * One page of a store search.
 *
 * @param call - Issues one request.
 * @param term - The search term; a blank term answers nothing without a
 *               request (the server refuses to list the store).
 * @param offset - Where the page starts.
 * @param limit - Page size.
 * @returns The page's entries and the server's total for the term.
 */
export async function searchStorePipes(call: PipeCatalogCall, term: string, offset = 0, limit: number = STORE_PAGE_LIMIT): Promise<{ entries: IPipeEntry[]; total: number }> {
	const search = term.trim();
	if (!search) return { entries: [], total: 0 };
	const body = await call({ kind: 'pipe', search, offset, limit });
	const entries = entriesOf(body);
	const total = typeof body?.total === 'number' ? body.total : offset + entries.length;
	return { entries, total: Math.max(total, offset + entries.length) };
}

// =============================================================================
// THE INTERFACE
// =============================================================================

/**
 * The nodes of one interface in an `interfaces()` answer.
 *
 * The interface name IS the catalog classType (`chat`, `dropper`,
 * `database`), so this is plain equality. A source sits under its own
 * address, every other node under the pipe address; each node keeps the
 * address it answered under, so a choice binds the right control. A node
 * listed twice is kept once.
 *
 * @param answer - The `interfaces()` answer.
 * @param classType - The interface to keep.
 * @returns The nodes, in the server's order.
 */
export function interfaceNodes(answer: IInterfacesAnswer | null | undefined, classType: string): IInterfaceNode[] {
	const out: IInterfaceNode[] = [];
	const seen = new Set<string>();
	for (const [address, byClass] of Object.entries(answer?.interfaces ?? {})) {
		for (const node of byClass?.[classType] ?? []) {
			const nodeId = node?.nodeId;
			if (!nodeId) continue;
			const key = `${address}/${nodeId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ address, nodeId, name: node?.name || nodeId });
		}
	}
	return out;
}

// =============================================================================
// DISPLAY
// =============================================================================

/**
 * Where a publication comes from, in words: yours, a team's, or the store's.
 *
 * @param entry - The publication.
 * @returns The line under the pipe's name.
 */
export function rungLabel(entry: Pick<IPipeEntry, 'rung' | 'teamName' | 'teamId' | 'publisher'>): string {
	if (entry.rung === 'me') return 'Published to you';
	if (entry.rung === 'team') return `Team ${entry.teamName || entry.teamId || ''}`.trim();
	return entry.publisher ? `Store · ${entry.publisher}` : 'Store';
}

/**
 * Whether an entry matches a filter term (name, address or description).
 *
 * @param entry - The publication.
 * @param term - The term; blank matches everything.
 * @returns True when the entry should show.
 */
export function matchesTerm(entry: Pick<IPipeEntry, 'name' | 'pipe' | 'description'>, term: string): boolean {
	const needle = term.trim().toLowerCase();
	if (!needle) return true;
	return [entry.name, entry.pipe, entry.description ?? ''].some((text) => text.toLowerCase().includes(needle));
}

/**
 * A light grammar check for an address typed by hand. The server is the
 * authority; this only stops an obviously malformed string being sent.
 *
 * @param value - The typed text.
 * @returns True when the text has the shape of an address.
 */
export function looksLikeAddress(value: string): boolean {
	return ADDRESS.test(value.trim());
}

// =============================================================================
// THE DEEP LINK
// =============================================================================

/**
 * The `pipe=` / `node=` parameters of a query string.
 *
 * @param search - A location's `search` (`?pipe=…&node=…`).
 * @returns The link, or null when no non-blank `pipe=` is present.
 */
export function pipeLinkFromSearch(search: string): IPipeLink | null {
	const params = new URLSearchParams(search);
	const pipe = params.get(PIPE_PARAM)?.trim() ?? '';
	if (!pipe) return null;
	const node = params.get(NODE_PARAM)?.trim() ?? '';
	return node ? { pipe, node } : { pipe };
}

/**
 * A URL with the choice written into it: `pipe=` always, `node=` when given
 * (dropped when not, so a stale node never outlives its pipe). Every other
 * parameter is kept.
 *
 * @param href - The current URL.
 * @param pipe - The address to bind.
 * @param node - The node id, for front ends that bind a node (sql).
 * @returns The new URL.
 */
export function hrefWithPipeLink(href: string, pipe: string, node?: string): string {
	const url = new URL(href);
	url.searchParams.set(PIPE_PARAM, pipe);
	if (node) url.searchParams.set(NODE_PARAM, node);
	else url.searchParams.delete(NODE_PARAM);
	return url.toString();
}

/**
 * The link the page was opened with (the shell passes no query to apps, so
 * each reads its own).
 *
 * @returns The link, or null.
 */
export function pipeLinkFromLocation(): IPipeLink | null {
	if (typeof window === 'undefined') return null;
	return pipeLinkFromSearch(window.location.search);
}

/**
 * Record a choice in the URL without a navigation, so the page is shareable
 * and survives a reload.
 *
 * @param pipe - The address to bind.
 * @param node - The node id, for front ends that bind a node.
 */
export function writePipeLinkToLocation(pipe: string, node?: string): void {
	if (typeof window === 'undefined') return;
	window.history.replaceState(window.history.state, '', hrefWithPipeLink(window.location.href, pipe, node));
}
