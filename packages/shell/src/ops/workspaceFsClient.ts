// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// WORKSPACE-FS CLIENT — the ONE consumer-side WorkspaceFs, over host.fs.* ops
// =============================================================================
//
// STATELESS: every verb is one request to the authority (the framework
// root's registered implementation). In a root realm the calls resolve
// locally — rocket-ui's tools hit the staged class with zero serialization;
// in a webview realm they cross the bridge. Consumers cannot tell, which is
// the point: caching lives at the authority and is therefore shared by every
// realm automatically.
//
// Promoted from the vscode-private svcFsClient — the client belongs to the
// contract, not to one host.
// =============================================================================

import type { WorkspaceFs, CommitResult, LayerMeta, PendingState } from '../workspace/workspaceFs';

/** The bus surface the client needs (realm or root ConnectionManager). */
export interface IWorkspaceFsBus {
	request(op: string, params: unknown): Promise<unknown>;
	emitOp(op: string, params: unknown): void;
	/** Registers THIS realm's handler for a pushed op (registration-is-routing). */
	handle(op: string, handler: (params: unknown) => void): () => void;
}

// ONE client per bus: the client is stateless (every verb is one request),
// so all consumers in a realm can share one instance — and MUST: the
// `host.fs.event` handler registration below is exclusive on the bus, so a
// second construction against the same bus would throw. React StrictMode's
// double-invoked memo factories found this the hard way.
const instances = new WeakMap<IWorkspaceFsBus, WorkspaceFs>();

/**
 * The realm-side WorkspaceFs over the `host.fs.*` op family — one shared
 * instance per bus (repeat calls return it).
 *
 * @param bus - The realm's connection manager.
 * @returns The capability handed to tools (`ToolHostServices.workspaceFs`)
 *          or used directly by any component.
 */
export function createWorkspaceFs(bus: IWorkspaceFsBus): WorkspaceFs {
	const existing = instances.get(bus);
	if (existing) return existing;
	const created = buildWorkspaceFs(bus);
	instances.set(bus, created);
	return created;
}

/** Builds the one client instance for a bus (see createWorkspaceFs). */
function buildWorkspaceFs(bus: IWorkspaceFsBus): WorkspaceFs {
	// Realm-unique watch keys: a ROUTING key, not a correlation id. The
	// random prefix keeps a rebooted page's keys from colliding with its
	// predecessor's (whose host-side watchers are dropped on page boot).
	const prefix = `fs-${Math.random().toString(36).slice(2, 10)}`;
	let seq = 0;
	const watchers = new Map<string, (path: string) => void>();

	// One registration for the realm's lifetime — events for subs this realm
	// does not own (another realm's watches riding the same broadcast) are
	// simply not in the map.
	bus.handle('host.fs.event', (params) => {
		const p = params as { sub?: string; path?: string };
		if (typeof p?.sub === 'string' && typeof p?.path === 'string') watchers.get(p.sub)?.(p.path);
	});

	return {
		// ── Discovery / read ─────────────────────────────────────────────────
		findFiles: (include, exclude) => bus.request('host.fs.findFiles', { include, ...(exclude !== undefined ? { exclude } : {}) }) as Promise<string[]>,
		workspaceRoots: () => bus.request('host.fs.workspaceRoots', {}) as Promise<string[]>,
		list: (dir) => bus.request('host.fs.list', { dir }) as Promise<{ name: string; type: 'file' | 'dir' }[]>,
		stat: (path) => bus.request('host.fs.stat', { path }) as Promise<'file' | 'dir' | null>,
		read: (path) => bus.request('host.fs.read', { path }),
		readMany: (paths) => bus.request('host.fs.readMany', { paths }) as Promise<Record<string, unknown>>,
		readTextFile: (path) => bus.request('host.fs.readText', { path }) as Promise<string>,
		readFileBase64: (path, maxBytes) => bus.request('host.fs.readBase64', { path, maxBytes }) as Promise<string | null>,

		// ── Write ────────────────────────────────────────────────────────────
		write: (path, content) => bus.request('host.fs.write', { path, content }) as Promise<void>,
		writeTextFile: (path, text) => bus.request('host.fs.writeText', { path, text }) as Promise<void>,
		writeFileBase64: (path, dataB64) => bus.request('host.fs.writeBase64', { path, dataB64 }) as Promise<void>,
		rename: (from, to) => bus.request('host.fs.rename', { from, to }) as Promise<void>,
		delete: (path, recursive) => bus.request('host.fs.delete', { path, ...(recursive !== undefined ? { recursive } : {}) }) as Promise<void>,
		mkdir: (path) => bus.request('host.fs.mkdir', { path }) as Promise<void>,
		refresh: () => bus.request('host.fs.refresh', {}) as Promise<void>,

		// ── Watch ────────────────────────────────────────────────────────────
		watch: (globs, onEvent) => {
			const sub = `${prefix}-${++seq}`;
			watchers.set(sub, onEvent);
			bus.emitOp('host.fs.watch', { sub, globs });
			return () => {
				watchers.delete(sub);
				bus.emitOp('host.fs.unwatch', { sub });
			};
		},

		// ── Change management ────────────────────────────────────────────────
		pending: () => bus.request('host.fs.pending', {}) as Promise<PendingState>,
		diff: (path) => bus.request('host.fs.diff', { path }) as Promise<{ before: string | null; after: string | null }>,
		commit: (options) => bus.request('host.fs.commit', { ...(options?.retain !== undefined ? { retain: options.retain } : {}) }) as Promise<CommitResult>,
		checkpoint: (label, sessionId) => bus.request('host.fs.checkpoint', { label, ...(sessionId !== undefined ? { sessionId } : {}) }) as Promise<string | null>,
		rollback: (layerId) => bus.request('host.fs.rollback', { layerId }) as Promise<void>,
		undoTurn: (layerId) => bus.request('host.fs.undoTurn', { layerId }) as Promise<CommitResult>,
		discard: (path) => bus.request('host.fs.discard', { ...(path !== undefined ? { path } : {}) }) as Promise<void>,
		layers: () => bus.request('host.fs.layers', {}) as Promise<LayerMeta[]>,
		setWriteThrough: (on) => bus.request('host.fs.writeThrough', { on }) as Promise<void>,
		// Rehydration is the AUTHORITY's concern; by the time any op answers,
		// it has already awaited its own readiness.
		whenReady: () => Promise.resolve(),
	};
}
