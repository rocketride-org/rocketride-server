// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WORKSPACE-FS CLIENT — ToolWorkspaceFs over the host.fs.* ops
// =============================================================================
//
// The ToolWorkspaceFs the shared tool code runs against in this host
// (frozen shell contract — signatures unchanged, only the transport moved):
// reads ride the brokered `host.fs.*` ops (the bus owns correlation — no
// requestId), watch events arrive on the realm-registered `sidebar.fs.event`
// op (registration-is-routing) keyed by this realm's own `sub` strings.
// =============================================================================

import { ConnectionManager } from 'shell';
import type { ToolWorkspaceFs } from 'shell';

/**
 * Creates the realm-side workspace-FS capability.
 *
 * @returns The ToolWorkspaceFs handed to the tools (ToolHostServices.workspaceFs).
 */
export function createBusWorkspaceFs(): ToolWorkspaceFs {
	const cm = ConnectionManager.getInstance();
	// Realm-unique watch keys: a ROUTING key, not a correlation id. The
	// random prefix keeps a rebooted page's keys from colliding with its
	// predecessor's (whose host-side watchers are dropped on view:ready).
	const prefix = `fs-${Math.random().toString(36).slice(2, 10)}`;
	let seq = 0;
	const watchers = new Map<string, (path: string) => void>();

	// One registration for the realm's lifetime — events for subs this realm
	// does not own (another realm's watches riding the same broadcast) are
	// simply not in the map.
	cm.handle('sidebar.fs.event', (params) => {
		const p = params as { sub?: string; path?: string };
		if (typeof p?.sub === 'string' && typeof p?.path === 'string') watchers.get(p.sub)?.(p.path);
	});

	return {
		findFiles: (include, exclude) => cm.request('host.fs.findFiles', { include, ...(exclude !== undefined ? { exclude } : {}) } as never) as Promise<string[]>,
		workspaceRoots: () => cm.request('host.fs.workspaceRoots', {} as never) as Promise<string[]>,
		readTextFile: (path) => cm.request('host.fs.readText', { path } as never) as Promise<string>,
		readFileBase64: (path, maxBytes) => cm.request('host.fs.readBase64', { path, maxBytes } as never) as Promise<string | null>,
		watch: (globs, onEvent) => {
			const sub = `${prefix}-${++seq}`;
			watchers.set(sub, onEvent);
			cm.emitOp('host.fs.watch', { sub, globs } as never);
			return () => {
				watchers.delete(sub);
				cm.emitOp('host.fs.unwatch', { sub } as never);
			};
		},
	};
}
