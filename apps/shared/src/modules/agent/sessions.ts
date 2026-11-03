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
 *   .agents/<appId>/catalog.json        — the session index (id, date, title)
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
}

/** The catalog file envelope. */
interface CatalogFile {
	version: 1;
	sessions: AgentSessionMeta[];
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
	try {
		const file = await requireClient().fsReadJson<CatalogFile>(path);
		return Array.isArray(file?.sessions) ? file.sessions : [];
	} catch (err) {
		// step: ONLY a genuinely absent catalog is empty — a transient read
		// failure must not feed updateCatalog a bare list to rewrite with
		if (isNotFound(err)) return [];
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
	const path = `${await agentsDir()}/catalog.json`;
	const op = catalogChain.then(async () => {
		const rows = mutate(await readCatalog(path));
		await requireClient().fsWriteJson(path, { version: 1, sessions: rows } satisfies CatalogFile);
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
export async function getAgentSessions(offset: number, count: number): Promise<AgentSessionMeta[]> {
	const rows = await readCatalog(`${await agentsDir()}/catalog.json`);
	return rows.sort((a, b) => b.date - a.date).slice(offset, offset + count);
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
 * Writes one full conversation and upserts its catalog row.
 *
 * @param session - The complete session file content to persist.
 */
export async function saveSession(session: AgentSessionFile): Promise<void> {
	const path = await sessionPath(session.sessionId);
	await requireClient().fsWriteJson(path, session);
	emitFsChange(path, 'agent');
	const meta: AgentSessionMeta = { sessionId: session.sessionId, date: session.date, title: session.title };
	await updateCatalog((rows) => [meta, ...rows.filter((r) => r.sessionId !== session.sessionId)]);
}
