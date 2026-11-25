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
// AGENT SESSIONS — storage layer over the user's file store (.agents tree)
// =============================================================================

/**
 * Persistence for agent chat sessions. Each controlling app's history lives
 * under `.agents/<appId>/` in the user's server-side file store:
 *
 *   .agents/<appId>/catalog.json        — the session index (id, date, title,
 *                                         group) and, for hosts that group
 *                                         their sessions, the groups
 *   .agents/<appId>/<sessionId>.json    — one full conversation
 *
 * The controlling app id is MODULE state, stamped once by
 * `AgentSession.configure()` — it namespaces history per hosting app and
 * never restricts what a session may operate on. All verbs are thin wrappers
 * over the client's fs store (writes auto-create parent directories), and
 * every mutation announces itself on the shell event bus via emitFsChange.
 *
 * Not host-facing: hosts go through the AgentSession class in agent.ts.
 */

import { getClient } from 'shell';
import type { ChatMessage, RocketRideClient } from 'shell';
import { emitFsChange } from '../../utils/fsNotify';

// =============================================================================
// TYPES
// =============================================================================

/** One catalog row — what the sidebar session list renders. */
export interface AgentSessionMeta {
	/** The session's GUID. */
	sessionId: string;
	/** Epoch-ms creation stamp (list is rendered newest-first). */
	date: number;
	/** Display title — the first user request, truncated. */
	title: string;
	/** The group (a host-defined folder, e.g. one per agent) the session belongs to. */
	group?: string;
}

/**
 * One group row — a host-defined folder of sessions (the Playground keeps
 * one per agent it has opened). Hosts that never group sessions never see one.
 */
export interface AgentSessionGroup {
	/** The group's id, as the host names it (unique within the catalog). */
	id: string;
	/** Display title. */
	title: string;
	/** Optional icon URL. */
	icon?: string;
	/** Epoch-ms stamp of the last time the host touched the group. */
	date: number;
}

/** The catalog file envelope. */
interface CatalogFile {
	version: 1;
	sessions: AgentSessionMeta[];
	/** Host-defined groups; absent in a catalog that has never had one. */
	groups?: AgentSessionGroup[];
}

/** The catalog's two lists, as read. */
interface CatalogLists {
	sessions: AgentSessionMeta[];
	groups: AgentSessionGroup[];
}

/** One stored conversation — the session file envelope. */
export interface AgentSessionFile {
	version: 1;
	sessionId: string;
	title: string;
	date: number;
	/** Workspace-relative paths the conversation references (future context chips). */
	contextRefs: string[];
	/** The shell chat message shape verbatim — restore = initialMessages seed. */
	messages: ChatMessage[];
	/** The group the session belongs to, when the host groups its sessions. */
	group?: string;
}

// =============================================================================
// MODULE STATE — the controlling app id
// =============================================================================

/** Root directory of all agent history in the user's file store. */
export const AGENTS_DIR = '.agents';

/** GUID shape for session ids (crypto.randomUUID output). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Characters forbidden in a controlling app id (store id rules). */
const INVALID_APPID_CHARS = new Set(['/', '\\', '*', '?', '<', '>', '|', '"']);

/**
 * Whether a controlling app id satisfies the store's id rules: no path
 * separators or metacharacters, no control characters, no scope sigils
 * (`@`/`=` prefixes), no traversal. Dots WITHIN the id are fine
 * ('rocketride.pipeBuilder').
 *
 * @param appId - The candidate id.
 * @returns True when the id is storable.
 */
function isValidAppId(appId: string): boolean {
	if (!appId || appId.startsWith('@') || appId.startsWith('=') || appId.includes('..')) return false;
	for (const ch of appId) {
		if (INVALID_APPID_CHARS.has(ch) || ch.charCodeAt(0) < 0x20) return false;
	}
	return true;
}

/** The controlling app id, stamped once via configureSessions(). */
let controllingAppId: string | null = null;

/** Resolves the first time configureSessions() stamps an id — lets early
    callers wait out the host's mount order instead of racing it. */
let notifyConfigured: (() => void) | null = null;
const configuredSignal = new Promise<void>((resolve) => {
	notifyConfigured = resolve;
});

/** How long a session verb waits for the host to configure before failing
    loudly — generous for any mount order, short enough to surface a host
    that genuinely never configures. */
const CONFIGURE_WAIT_MS = 5000;

/**
 * Stamps the controlling app id that namespaces all session storage.
 * Called by AgentSession.configure() — never by hosts directly.
 *
 * @param appId - The hosting app's id (e.g. 'rocketride.pipeBuilder').
 */
export function configureSessions(appId: string): void {
	// step: enforce store id rules locally so the refusal is explicit
	if (!isValidAppId(appId)) {
		throw new Error(`Invalid controlling app id for agent sessions: '${appId}'`);
	}
	controllingAppId = appId;
	notifyConfigured?.();
}

/**
 * The configured `.agents/<appId>` directory.
 *
 * The host stamps the id from a mount effect while session consumers (e.g.
 * a restored agent conversation tab) load from their own mount effects —
 * the two race within one React commit. All verbs are async anyway, so an
 * early caller WAITS (bounded) for the stamp instead of failing on order.
 *
 * @returns The namespace directory store path.
 */
async function agentsDir(): Promise<string> {
	if (!controllingAppId) {
		await Promise.race([
			configuredSignal,
			new Promise<never>((_, reject) => setTimeout(
				() => reject(new Error('Agent sessions are not configured — call AgentSession.configure(appId) first.')),
				CONFIGURE_WAIT_MS,
			)),
		]);
	}
	return `${AGENTS_DIR}/${controllingAppId}`;
}

/**
 * The store path of one session file.
 *
 * @param sessionId - The session GUID.
 * @returns The session file store path.
 */
async function sessionPath(sessionId: string): Promise<string> {
	// step: ids are GUIDs by construction — anything else is a caller bug
	if (!UUID_RE.test(sessionId)) throw new Error(`Invalid agent session id: '${sessionId}'`);
	return `${await agentsDir()}/${sessionId}.json`;
}

/**
 * The connected client, or a loud failure — session verbs are only reachable
 * from connected UI, so a missing client is a wiring bug, not a state.
 *
 * @returns The shared RocketRideClient.
 */
function requireClient(): RocketRideClient {
	const client = getClient();
	if (!client) throw new Error('No connected client — agent sessions need the shell connection.');
	return client;
}

// =============================================================================
// CATALOG — serialized writer
// =============================================================================

// catalog.json is the single contended file (the server takes a per-path
// write lock), so every rewrite queues behind the previous one.
let catalogChain: Promise<void> = Promise.resolve();

/**
 * Whether a store read failed because the file does not exist — the store
 * raises StorageError('File not found: …'), which reaches this side as the
 * error message. Only that case may be treated as "nothing stored yet";
 * transport drops and parse failures must surface instead.
 *
 * @param err - The error a store read rejected with.
 * @returns True when the path simply has no file.
 */
export function isNotFound(err: unknown): boolean {
	return err instanceof Error && /file not found/i.test(err.message);
}

/**
 * Reads the catalog; a missing file is an empty catalog. The PATH is the
 * caller's capture — updateCatalog queues its callback, and the controlling
 * app (the namespace) may switch before it runs; read and write must name
 * the same file.
 *
 * @param path - The catalog file's full store path.
 * @returns The catalog rows (unsorted, as stored).
 */
async function readCatalog(path: string): Promise<AgentSessionMeta[]> {
	return (await readCatalogLists(path)).sessions;
}

/**
 * Reads both catalog lists; a missing file is two empty lists. Same failure
 * rule as {@link readCatalog}: only a genuinely absent catalog is empty.
 *
 * @param path - The catalog file's full store path.
 * @returns The session rows and the group rows (unsorted, as stored).
 */
async function readCatalogLists(path: string): Promise<CatalogLists> {
	try {
		const file = await requireClient().fsReadJson<CatalogFile>(path);
		return {
			sessions: Array.isArray(file?.sessions) ? file.sessions : [],
			groups: Array.isArray(file?.groups) ? file.groups : [],
		};
	} catch (err) {
		// step: ONLY a genuinely absent catalog is empty — a transient read
		// failure must not feed updateCatalog a bare list to rewrite with
		if (isNotFound(err)) return { sessions: [], groups: [] };
		throw err;
	}
}

/**
 * Queues one read-modify-write of the catalog behind all previous ones.
 * The queue survives failures: each update waits for the previous one to
 * SETTLE (a rejected link would otherwise dam the chain for the whole page
 * session), while the caller still receives its own operation's outcome.
 *
 * @param mutate - Pure transform of the current rows to the new rows.
 */
async function updateCatalog(mutate: (rows: AgentSessionMeta[]) => AgentSessionMeta[]): Promise<void> {
	return updateCatalogLists((lists) => ({ ...lists, sessions: mutate(lists.sessions) }));
}

/**
 * Queues one read-modify-write of BOTH catalog lists (the one writer behind
 * {@link updateCatalog}). Groups ride every rewrite, so a host that never
 * groups sessions never drops another host's groups; an empty group list is
 * not written at all, leaving an ungrouped catalog byte-identical.
 *
 * @param mutate - Pure transform of the current lists to the new lists.
 */
async function updateCatalogLists(mutate: (lists: CatalogLists) => CatalogLists): Promise<void> {
	const path = `${await agentsDir()}/catalog.json`;
	const op = catalogChain.then(async () => {
		const next = mutate(await readCatalogLists(path));
		const file: CatalogFile = { version: 1, sessions: next.sessions, ...(next.groups.length > 0 ? { groups: next.groups } : {}) };
		await requireClient().fsWriteJson(path, file);
		emitFsChange(path, 'agent');
	});
	catalogChain = op.catch(() => undefined);
	return op;
}

// =============================================================================
// SESSION VERBS
// =============================================================================

/**
 * Lists the available sessions, newest first.
 *
 * @param offset - Rows to skip.
 * @param count - Maximum rows to return.
 * @returns The requested catalog page.
 */
export async function getAgentSessions(offset: number, count: number, group?: string): Promise<AgentSessionMeta[]> {
	const rows = await readCatalog(`${await agentsDir()}/catalog.json`);
	// step: a group narrows the list to that group's sessions; none = every row
	const kept = group === undefined ? rows : rows.filter((r) => r.group === group);
	return kept.sort((a, b) => b.date - a.date).slice(offset, offset + count);
}

/**
 * Reads one stored conversation as its raw JSON string.
 *
 * @param sessionId - The session GUID.
 * @returns The session file content.
 */
export async function getContext(sessionId: string): Promise<string> {
	return requireClient().fsReadString(await sessionPath(sessionId));
}

/**
 * Deletes one session: its file and its catalog row.
 *
 * @param sessionId - The session GUID.
 */
export async function deleteSession(sessionId: string): Promise<void> {
	const path = await sessionPath(sessionId);
	await requireClient().fsDelete(path);
	emitFsChange(path, 'agent');
	await updateCatalog((rows) => rows.filter((r) => r.sessionId !== sessionId));
}

/**
 * Writes one full conversation and, unless told not to, upserts its catalog
 * row. A host whose catalog has one writer elsewhere (a dev tool's
 * controller mount) writes the file here with `catalog: false` and sends the
 * row to that writer, which commits it with {@link saveSessionMeta}.
 *
 * @param session - The complete session file content to persist.
 * @param options - `catalog: false` writes the file only (default true).
 */
export async function saveSession(session: AgentSessionFile, options?: { catalog?: boolean }): Promise<void> {
	const path = await sessionPath(session.sessionId);
	await requireClient().fsWriteJson(path, session);
	emitFsChange(path, 'agent');
	if (options?.catalog === false) return;
	await saveSessionMeta({ sessionId: session.sessionId, date: session.date, title: session.title, ...(session.group !== undefined ? { group: session.group } : {}) });
}

/**
 * Upserts one session's catalog row (newest first).
 *
 * @param meta - The row to store.
 */
export async function saveSessionMeta(meta: AgentSessionMeta): Promise<void> {
	await updateCatalog((rows) => [meta, ...rows.filter((r) => r.sessionId !== meta.sessionId)]);
}

// =============================================================================
// GROUP VERBS
// =============================================================================

/**
 * Lists the groups, most recently touched first.
 *
 * @returns Every group row.
 */
export async function getAgentGroups(): Promise<AgentSessionGroup[]> {
	const { groups } = await readCatalogLists(`${await agentsDir()}/catalog.json`);
	return groups.sort((a, b) => b.date - a.date);
}

/**
 * Upserts one group row.
 *
 * @param group - The group to store (its id keys the upsert).
 */
export async function saveAgentGroup(group: AgentSessionGroup): Promise<void> {
	await updateCatalogLists((lists) => ({ ...lists, groups: [group, ...lists.groups.filter((g) => g.id !== group.id)] }));
}

/**
 * Deletes one group: every session file in it, their rows, and the group row.
 *
 * @param groupId - The group's id.
 */
export async function deleteAgentGroup(groupId: string): Promise<void> {
	// step: the group's sessions, as the catalog lists them now
	const { sessions } = await readCatalogLists(`${await agentsDir()}/catalog.json`);
	const members = sessions.filter((r) => r.group === groupId);

	// step: each session's file first; a file that is already gone is not a failure
	for (const member of members) {
		const path = await sessionPath(member.sessionId);
		try {
			await requireClient().fsDelete(path);
		} catch (err) {
			if (!isNotFound(err)) throw err;
		}
		emitFsChange(path, 'agent');
	}

	// step: then the rows and the group row, in one rewrite
	const gone = new Set(members.map((m) => m.sessionId));
	await updateCatalogLists((lists) => ({
		sessions: lists.sessions.filter((r) => !gone.has(r.sessionId) && r.group !== groupId),
		groups: lists.groups.filter((g) => g.id !== groupId),
	}));
}
