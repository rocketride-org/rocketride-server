// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WORKSPACE-FS OPS — the browser host's implementations (the staged view)
// =============================================================================
//
// rocket-ui's half of the `WorkspaceFs` capability: every `host.fs.*` op
// delegates to the STAGED workspace view (`getStagedWorkspace()`), so every
// consumer — in this root page or any bridged realm — sees uncommitted
// files, dirty state, diffs, and the commit/rollback/checkpoint surface.
// The D1 rule ("reads see the workspace VIEW, not the server copy") is
// structural here: the staged class IS the authority.
//
// First time this host serves the fs family at all — the gap that used to
// force prop-fed data feeds (pipelineEntries/appdevApps) into the sidebar.
//
// Registered at module scope beside registerRocketHostOps (the singletons
// are module-importable; each handler resolves them lazily so registration
// order never races workspace construction).
// =============================================================================

import { ConnectionManager, registerOpHandlers } from 'shell';
import type { OpImplTable } from 'shell';
import type { HostFsOpMap } from 'shared/ops/fsOps';
import { getStagedWorkspace } from '../surfaces/workspace/vfs/workspace';

/**
 * Registers the browser host's `host.fs.*` implementations on the root bus.
 * Idempotent by the bus's own rule (already-registered ops are kept) — call
 * once from the host app's module scope.
 */
export function registerRocketFsOps(): () => void {
	const cm = ConnectionManager.getInstance();
	/** The staged view, resolved per call (never captured at registration). */
	const fs = () => getStagedWorkspace();

	// Watch subscriptions: sub -> unsubscribe. The staged change stream is
	// tick-only, so every event is the synthetic '' ("re-evaluate").
	const watches = new Map<string, () => void>();

	const impls: OpImplTable<HostFsOpMap> = {
		'host.fs.findFiles': (p) => fs().findFiles(p.include, p.exclude),
		'host.fs.workspaceRoots': () => fs().workspaceRoots(),
		'host.fs.list': (p) => fs().list(p.dir),
		'host.fs.stat': (p) => fs().stat(p.path),
		'host.fs.read': (p) => fs().read(p.path),
		'host.fs.readMany': (p) => fs().readMany(p.paths),
		'host.fs.readText': (p) => fs().readTextFile(p.path),
		'host.fs.readBase64': (p) => fs().readFileBase64(p.path, p.maxBytes),
		'host.fs.write': (p) => fs().write(p.path, p.content),
		'host.fs.writeText': (p) => fs().writeTextFile(p.path, p.text),
		'host.fs.writeBase64': (p) => fs().writeFileBase64(p.path, p.dataB64),
		'host.fs.rename': (p) => fs().rename(p.from, p.to),
		'host.fs.delete': (p) => fs().delete(p.path, p.recursive),
		'host.fs.mkdir': (p) => fs().mkdir(p.path),
		'host.fs.refresh': () => fs().refresh(),
		'host.fs.watch': (p) => {
			watches.get(p.sub)?.();
			watches.set(p.sub, fs().watch(p.globs, (path) => cm.emitOp('host.fs.event', { sub: p.sub, path })));
		},
		'host.fs.unwatch': (p) => {
			watches.get(p.sub)?.();
			watches.delete(p.sub);
		},
		'host.fs.pending': () => fs().pending(),
		'host.fs.diff': (p) => fs().diff(p.path),
		'host.fs.commit': (p) => fs().commit({ ...(p.retain !== undefined ? { retain: p.retain } : {}) }),
		'host.fs.checkpoint': (p) => fs().checkpoint(p.label, p.sessionId),
		'host.fs.rollback': (p) => fs().rollback(p.layerId),
		'host.fs.undoTurn': (p) => fs().undoTurn(p.layerId),
		'host.fs.discard': (p) => fs().discard(p.path),
		'host.fs.layers': () => fs().layers(),
		'host.fs.writeThrough': (p) => fs().setWriteThrough(p.on),
	};
	return registerOpHandlers<HostFsOpMap>(ConnectionManager.getInstance().ops(), impls);
}
