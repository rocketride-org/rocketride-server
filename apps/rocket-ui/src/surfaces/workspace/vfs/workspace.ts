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
// WORKSPACE — Rocket Builder's workspace service (composition root)
// =============================================================================

/**
 * Everything HOST-SPECIFIC about Rocket Builder's view of the RocketRide
 * cloud workspace lives here:
 *
 *   - the virtual mount model (apps/ nodes/ pipelines/) and its translation
 *     to the store's physical layout (.projects/.appdev, .projects/.nodes,
 *     loose .pipe files at the .projects root),
 *   - the CachedVfs backend enforcing the structural rules (mount roots are
 *     protected, entities never change kind by renaming) and announcing
 *     every mutation on the shell event bus,
 *   - createWorkspace() — the COMPOSITION ROOT: RocketApp's bootstrap builds
 *     the one Workspace service (staged view + CommitPolicy) with the real
 *     mode and awaits staging rehydration before any consumer renders,
 *   - WORKSPACE_GUIDE — the instructions rocket-ui passes into the shared
 *     FilesystemTools constructor so the LLM knows what the tree contains,
 *   - WorkspaceTools — rocket-ui's own toolkit (the list_workspace entity
 *     inventory). The guide + toolkit are the agent-loop library (consumed
 *     when the in-app agent lands), not dead code.
 *
 * The agent is assembled as:
 *   new FilesystemTools(getWorkspaceVfs(), WORKSPACE_GUIDE)
 *   new WorkspaceTools()
 */

import { CachedVfs, getClient } from 'shell';
import type { IVirtualFileSystem, RocketRideClient } from 'shell';
import { emitFsChange } from 'shared/utils/fsNotify';
import { StagedFileSystem } from 'shared/modules/vfs/stagedFileSystem';
import { StagingStore } from 'shared/modules/vfs/staging';
import { CommitPolicy } from 'shared/modules/vfs/commitPolicy';
import type { IWorkspaceFileSystem } from 'shared/modules/vfs/vfsTypes';


// =============================================================================
// CONSTANTS — physical layout (mirrors appdev/appStore.ts)
// =============================================================================

/** Physical root of the cloud workspace in the user's store tree. */
const PROJECTS_DIR = '.projects';
/** Physical subdirectory holding app projects. */
const APPDEV_DIR = '.appdev';
/** Physical subdirectory holding node packages. */
const NODES_DIR = '.nodes';

/** The three virtual mounts, in display order. */
const MOUNTS = ['apps', 'nodes', 'pipelines'] as const;
type Mount = (typeof MOUNTS)[number];

/** Directories the VFS never walks (platform-owned build trees). */
const SKIP_DIRS = ['node_modules', 'dist', 'build', '.git'];

/** The store's mkdir sentinel — never surfaced to the agent. */
const DIR_MARKER = '.dirmarker';

/**
 * The bus origin stamped when a view caller passes none. Callers that need
 * echo suppression (dev sessions) or attribution (the agent) pass their own
 * identity through the view's origin parameter.
 */
const DEFAULT_WRITE_ORIGIN = 'workspace';

// =============================================================================
// SCOPE — whose store tree the workspace is rooted in
// =============================================================================

/**
 * The storage scope of the workspace tree. 'team' roots every mount in the
 * development team's shared file area (teams/<id>/files/...) so the whole
 * team reads and writes ONE source tree; 'user' is the caller's private
 * store — the pre-team behavior and the fallback when no valid dev team
 * exists (devTeam unset, or orphaned by an org switch).
 */
export type WorkspaceScope = { kind: 'user' } | { kind: 'team'; teamId: string };

/**
 * The active scope. Set ONCE by createWorkspace() before the first path
 * translation; 'user' until then so pre-bootstrap translations (none are
 * expected) fail safe into the caller's own tree rather than a team's.
 */
let activeScope: WorkspaceScope = { kind: 'user' };

/** Team ids ride inside store paths — allow only plain id characters. */
const SAFE_TEAM_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The physical store-path prefix of the active scope: the '@/Team/=<id>/'
 * scope spelling (resolved and authorized server-side by team membership),
 * or '' for the caller's own tree.
 *
 * @returns The prefix every physical path translation applies.
 */
function scopePrefix(): string {
	return activeScope.kind === 'team' ? `@/Team/=${activeScope.teamId}/` : '';
}


/**
 * Maps a scope-relative physical path (e.g. '.projects/.appdev/foo') to the
 * full store path in the ACTIVE scope. The escape hatch for the few raw
 * binary reads that bypass the view (appStore.appPath) — everything else
 * goes through toStorePath.
 *
 * @param rel - The scope-relative physical path.
 * @returns The full store path.
 */
export function toScopedStorePath(rel: string): string {
	return `${scopePrefix()}${rel}`;
}

/**
 * The staging namespace segment of a scope: staged-but-uncommitted state is
 * a property of (user, host app, SCOPE) — the layers staged against one
 * team's tree must never rehydrate into another team's (or the user's own)
 * workspace. '' keeps the user tree's staging at its pre-team path, so
 * existing staged state survives this change.
 *
 * @param scope - The workspace scope.
 * @returns The extra path segment for the StagingStore ('' for user scope).
 */
export function stagingScopeKey(scope: WorkspaceScope): string {
	return scope.kind === 'team' ? `team-${scope.teamId}` : '';
}

/**
 * Resolves the workspace scope from the connected identity: the account's
 * development team, honored ONLY while it names a team of the active org
 * (after an org switch devTeam can point into the previous org — the same
 * staleness EnvironmentProvider guards against). Anything else falls back
 * to the user's private tree, never to an arbitrary team.
 *
 * @param auth - The ConnectResult identity (null while unauthenticated).
 * @returns The scope the workspace should be rooted in.
 */
export function resolveWorkspaceScope(auth: { devTeam?: string; organization?: { teams?: Array<{ id: string }> } | null } | null): WorkspaceScope {
	const devTeam = auth?.devTeam;
	if (!devTeam || !SAFE_TEAM_ID.test(devTeam)) return { kind: 'user' };
	const teams = auth?.organization?.teams ?? [];
	if (!teams.some((t) => t.id === devTeam)) return { kind: 'user' };
	return { kind: 'team', teamId: devTeam };
}

// =============================================================================
// MOUNT TRANSLATION — virtual tree <-> physical store paths
// =============================================================================

/** A parsed virtual path: which mount, and the path relative to it. */
interface VirtualPath {
	mount: Mount;
	/** Mount-relative remainder ('' at the mount root). */
	rest: string;
}

/**
 * Parses a virtual path against the mount rules. The generic tool layer has
 * already normalized separators and refused traversal; this enforces what
 * is specific to THIS tree.
 *
 * @param raw - A normalized workspace path.
 * @param allowRoot - Whether '' (the workspace root) is acceptable.
 * @returns The parsed virtual path, or null for the root.
 */
function parseVirtualPath(raw: string, allowRoot = false): VirtualPath | null {
	const cleaned = String(raw ?? '').replace(/^\/+|\/+$/g, '');
	if (!cleaned) {
		if (allowRoot) return null;
		throw new Error('A path inside apps/, nodes/, or pipelines/ is required.');
	}
	const segments = cleaned.split('/').filter((s) => s.length > 0);
	// step: the first segment must be one of the three mounts
	const mount = segments[0] as Mount;
	if (!MOUNTS.includes(mount)) {
		throw new Error(`Unknown root '${segments[0]}' — the workspace has exactly apps/, nodes/, and pipelines/.`);
	}
	// step: entries directly under a mount may not be dot-named (they would
	// collide with the physical dot-directories the mapping hides)
	const rest = segments.slice(1);
	if (rest.length > 0 && rest[0].startsWith('.')) {
		throw new Error(`Names directly under ${mount}/ may not start with '.': '${rest[0]}'`);
	}
	return { mount, rest: rest.join('/') };
}

/**
 * Maps a parsed virtual path to its physical store path.
 *
 * @param vp - The parsed virtual path.
 * @returns The store-relative physical path.
 */
function toStorePath(vp: VirtualPath): string {
	const rel = (() => {
		switch (vp.mount) {
			case 'apps':
				return vp.rest ? `${PROJECTS_DIR}/${APPDEV_DIR}/${vp.rest}` : `${PROJECTS_DIR}/${APPDEV_DIR}`;
			case 'nodes':
				return vp.rest ? `${PROJECTS_DIR}/${NODES_DIR}/${vp.rest}` : `${PROJECTS_DIR}/${NODES_DIR}`;
			case 'pipelines':
				return vp.rest ? `${PROJECTS_DIR}/${vp.rest}` : PROJECTS_DIR;
		}
	})();
	return `${scopePrefix()}${rel}`;
}

/**
 * Translates a PHYSICAL store path (as announced on the shell notification
 * bus) into its virtual workspace path — THE one physical→virtual
 * translation point. Bus consumers (cross-page change adoption) call this
 * instead of comparing store prefixes themselves; everything else in the
 * app speaks virtual paths only.
 *
 * @param storePath - The store-relative path from an onFsChange event.
 * @returns The virtual path ('apps/...', 'nodes/...', 'pipelines/...'),
 *          or null when the path lies outside the three mounts (other
 *          dot-trees like .agents, unrelated store areas).
 */
export function storePathToVirtual(storePath: string): string | null {
	let p = String(storePath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	// step: paths from another scope are NOT this workspace's content — a
	// user-tree event while the workspace is team-rooted (or vice versa)
	// must not be adopted into the virtual tree.
	const prefix = scopePrefix();
	if (prefix) {
		if (!p.startsWith(prefix)) return null;
		p = p.slice(prefix.length);
	} else if (p.startsWith('@/')) {
		return null;
	}
	const appsRoot = `${PROJECTS_DIR}/${APPDEV_DIR}`;
	const nodesRoot = `${PROJECTS_DIR}/${NODES_DIR}`;
	if (p === appsRoot) return 'apps';
	if (p.startsWith(`${appsRoot}/`)) return `apps/${p.slice(appsRoot.length + 1)}`;
	if (p === nodesRoot) return 'nodes';
	if (p.startsWith(`${nodesRoot}/`)) return `nodes/${p.slice(nodesRoot.length + 1)}`;
	if (p === PROJECTS_DIR) return 'pipelines';
	if (p.startsWith(`${PROJECTS_DIR}/`)) {
		const rest = p.slice(PROJECTS_DIR.length + 1);
		// step: other dot-trees at the store root (.agents, .staging) are
		// NOT workspace content
		if (rest.startsWith('.')) return null;
		return `pipelines/${rest}`;
	}
	return null;
}

/**
 * The connected client, or a loud failure — the workspace tree is only
 * reachable from connected UI, so a missing client is a wiring bug.
 *
 * @returns The shared RocketRideClient.
 */
function requireClient(): RocketRideClient {
	const client = getClient();
	if (!client) throw new Error('No connected client — the agent workspace needs the shell connection.');
	return client;
}

/**
 * Lists one physical directory as agent-visible entries: the mkdir sentinel
 * vanishes, and at the pipelines root the physical dot-directories (which
 * ARE the other mounts) vanish too.
 *
 * @param client - The connected client.
 * @param vp - The virtual directory being listed.
 * @returns Entries with name and type.
 */
async function listPhysicalDir(client: RocketRideClient, vp: VirtualPath): Promise<Array<{ name: string; type: 'file' | 'dir' }>> {
	const { entries } = await client.fsListDir(toStorePath(vp));
	return entries
		.filter((e) => {
			if (e.name === DIR_MARKER) return false;
			// step: the pipelines mount is the .projects root — hide its dot-dirs
			if (vp.mount === 'pipelines' && vp.rest === '' && e.name.startsWith('.')) return false;
			return true;
		})
		.map((e) => ({ name: e.name, type: e.type }));
}

// =============================================================================
// BACKEND + VFS — the workspace tree all builders and the agent share
// =============================================================================

/**
 * The CachedVfs backend: an IVirtualFileSystem keyed by VIRTUAL paths that
 * performs the mount translation per call, enforces the structural rules
 * (protected mount roots, no cross-mount moves), and announces every
 * mutation on the shell event bus.
 *
 * @returns The workspace backend for a CachedVfs.
 */
function createWorkspaceBackend(): IVirtualFileSystem {
	return {
		/** Lists one virtual directory ('' = the three mounts). */
		async list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
			const vp = parseVirtualPath(dir, true);
			if (vp === null) return MOUNTS.map((name) => ({ name, type: 'dir' as const }));
			return listPhysicalDir(requireClient(), vp);
		},
		/** Reads one file as UTF-8 text. */
		async read(path: string): Promise<unknown> {
			const vp = parseVirtualPath(path);
			return requireClient().fsReadString(toStorePath(vp as VirtualPath));
		},
		/**
		 * Batch text read via the store's native fsReadMany (one round trip
		 * per 256 paths instead of one per file). Same text contract as
		 * read(); unreadable entries are omitted.
		 */
		async readMany(paths: string[]): Promise<Record<string, unknown>> {
			const client = requireClient();
			const out: Record<string, unknown> = {};
			const decoder = new TextDecoder();
			for (let i = 0; i < paths.length; i += 256) {
				const chunk = paths.slice(i, i + 256);
				const results = await client.fsReadMany(chunk.map((p) => toStorePath(parseVirtualPath(p) as VirtualPath)));
				results.forEach((entry, idx) => {
					if (entry.ok && entry.data) out[chunk[idx]] = decoder.decode(entry.data);
				});
			}
			return out;
		},
		/** Writes one file as UTF-8 text and announces the change. */
		async write(path: string, content: unknown, origin?: string): Promise<void> {
			const vp = parseVirtualPath(path) as VirtualPath;
			if (!vp.rest) throw new Error(`Cannot write to the ${vp.mount}/ root.`);
			const storePath = toStorePath(vp);
			await requireClient().fsWriteString(storePath, String(content));
			emitFsChange(storePath, origin ?? DEFAULT_WRITE_ORIGIN);
		},
		/** Renames within one mount and announces both ends. */
		async rename(oldPath: string, newPath: string, origin?: string): Promise<void> {
			const from = parseVirtualPath(oldPath) as VirtualPath;
			const to = parseVirtualPath(newPath) as VirtualPath;
			if (!from.rest || !to.rest) throw new Error('Mount roots cannot be renamed.');
			// step: an app does not become a node by renaming
			if (from.mount !== to.mount) {
				throw new Error(`Cannot move between ${from.mount}/ and ${to.mount}/ — entities do not change kind by renaming.`);
			}
			const fromStore = toStorePath(from);
			const toStore = toStorePath(to);
			await requireClient().fsRename(fromStore, toStore);
			emitFsChange(fromStore, origin ?? DEFAULT_WRITE_ORIGIN);
			emitFsChange(toStore, origin ?? DEFAULT_WRITE_ORIGIN);
		},
		/** Deletes a file (or a directory recursively) and announces it. */
		async delete(path: string, origin?: string): Promise<void> {
			const vp = parseVirtualPath(path) as VirtualPath;
			if (!vp.rest) throw new Error(`Refusing to delete the ${vp.mount}/ root.`);
			const client = requireClient();
			const storePath = toStorePath(vp);
			// step: route by actual kind — the tool layer has already enforced
			// the explicit-recursive policy for directories
			const stat = await client.fsStat(storePath);
			if (stat.type === 'dir') await client.fsRmdir(storePath, true);
			else await client.fsDelete(storePath);
			emitFsChange(storePath, origin ?? DEFAULT_WRITE_ORIGIN);
		},
		/** Creates a directory and announces it. */
		async mkdir(path: string, origin?: string): Promise<void> {
			const vp = parseVirtualPath(path) as VirtualPath;
			if (!vp.rest) throw new Error(`The ${vp.mount}/ root already exists.`);
			const storePath = toStorePath(vp);
			await requireClient().fsMkdir(storePath);
			emitFsChange(storePath, origin ?? DEFAULT_WRITE_ORIGIN);
		},
	};
}

/**
 * The workspace service: the ONE staged view every consumer shares (the
 * builders register their editor overlays on it, the agent's
 * FilesystemTools is constructed with it, the sidebar lists through it)
 * plus the CommitPolicy that owns its mode.
 */
export interface Workspace {
	/** The staged view — all reads/writes go through it. */
	view: StagedFileSystem;
	/** The single mode owner (autoCommit setting → setMode). */
	policy: CommitPolicy;
	/**
	 * True when the autoCommit=true setting could NOT be applied at boot
	 * because rehydration restored pending changes — the workspace runs in
	 * manual mode until the host prompts commit / discard / stay.
	 */
	pendingBlocksAuto: boolean;
}

/** The composition-root singleton — built once at app bootstrap. */
let workspace: Workspace | null = null;
/** In-flight creation, so concurrent bootstrap calls share one build. */
let workspaceBuild: Promise<Workspace> | null = null;
/** The scope key the current build was rooted in ('' = user scope). */
let builtScopeKey: string | null = null;

/**
 * Parks an outgoing workspace before a scope switch: every dirty editor
 * buffer is STAGED (never committed — write-through is disabled first, so
 * auto mode cannot silently flush unsaved edits to the outgoing tree), and
 * the staged layers persist into the OUTGOING scope's namespace. Returning
 * to that scope later rehydrates everything exactly as left; restored
 * pending state then refuses auto mode via the existing boot prompt.
 *
 * Runs while the outgoing scope is still active — the writes must
 * translate against the tree they belong to.
 *
 * @param outgoing - The workspace being torn down.
 */
async function stashForScopeSwitch(outgoing: Workspace): Promise<void> {
	const view = outgoing.view;
	try {
		void view.setWriteThrough(false);
		for (const path of view.dirtyPaths()) {
			try {
				// step: read serves the dirty overlay (the live buffer) — the
				// write stages it with its base hash captured for the commit gate
				const content = await view.read(path);
				await view.write(path, content, 'scope-switch');
			} catch (err) {
				// A single unstageable buffer must not strand the switch —
				// but losing an edit has to be LOUD.
				console.error(`[workspace] scope switch: failed to stage dirty buffer '${path}' — its unsaved content is lost:`, err);
			}
		}
	} catch (err) {
		console.error('[workspace] scope switch: failed to park the outgoing workspace:', err);
	}
}

/**
 * Builds the workspace service: backend + CachedVfs + StagedFileSystem +
 * StagingStore + CommitPolicy. Called ONCE from RocketApp's bootstrap,
 * BEFORE any consumer renders; later calls (React remount of the bootstrap
 * effect) return the existing instance — the workspace lives for the
 * document, not the component.
 *
 * The real mode is applied here, not flipped later by consumers: the view
 * rehydrates persisted staged layers first (reads before that resolve
 * would see un-staged base state), and only THEN can autoCommit=true be
 * honored — restored pending changes refuse auto mode (never a silent
 * flush), reported via `pendingBlocksAuto` for the host's prompt.
 *
 * @param options.hostAppId - The hosting app's id (staging namespace).
 * @param options.autoCommit - The host's autoCommit setting value.
 * @returns The workspace service, ready for its first read.
 */
export function createWorkspace(options: { hostAppId: string; autoCommit: boolean; scope?: WorkspaceScope }): Promise<Workspace> {
	const scope = options.scope ?? { kind: 'user' as const };
	const scopeKey = stagingScopeKey(scope);
	// step: same scope — the existing (or in-flight) build IS the workspace;
	// remounts of the bootstrap effect land here.
	if (workspaceBuild && builtScopeKey === scopeKey) return workspaceBuild;

	// A DIFFERENT scope: park the outgoing workspace (stage dirty buffers
	// into ITS namespace while ITS translation is still active), then build
	// fresh against the new tree. Chained through workspaceBuild so a
	// consumer arriving mid-switch awaits the finished switch, never a
	// half-torn-down view.
	const outgoing = workspaceBuild;
	builtScopeKey = scopeKey;
	workspaceBuild = (async () => {
		if (outgoing) {
			const old = await outgoing.catch(() => null);
			if (old) await stashForScopeSwitch(old);
		}
		// step: the scope roots EVERY path translation — set only after the
		// outgoing workspace is parked, before the first read fires.
		activeScope = scope;
		const base = new CachedVfs(createWorkspaceBackend(), { skipDirs: SKIP_DIRS });
		// step: staged until rehydration settles — write-through cannot be
		// decided before the restored pending state is known. Staging is
		// namespaced per scope: each team's (and the user tree's) pending
		// state rehydrates only into its own workspace.
		const view = new StagedFileSystem(base, new StagingStore(options.hostAppId, scopeKey), {
			writeThrough: false,
			// step: staged mutations announce on the SAME bus as physical
			// writes — manual mode's saves reach every onFsChange consumer
			// (dev preview, rescans) exactly like write-through saves do.
			// Write-through delegates to the backend, which announces itself.
			onMutate: (p, origin) => {
				const vp = parseVirtualPath(p);
				if (vp) emitFsChange(toStorePath(vp), origin ?? DEFAULT_WRITE_ORIGIN);
			},
		});
		await view.whenReady();
		const pendingBlocksAuto = options.autoCommit && view.hasPendingChanges();
		const effectiveAuto = options.autoCommit && !pendingBlocksAuto;
		if (effectiveAuto) void view.setWriteThrough(true);
		const policy = new CommitPolicy(view, effectiveAuto);
		workspace = { view, policy, pendingBlocksAuto };
		return workspace;
	})();
	return workspaceBuild;
}

/**
 * The workspace service, or a loud failure — consumers run strictly after
 * RocketApp's bootstrap created it, so a miss is a wiring bug.
 *
 * @returns The workspace service.
 */
export function getWorkspace(): Workspace {
	if (!workspace) throw new Error('Workspace not created — createWorkspace() must run at app bootstrap before any consumer.');
	return workspace;
}

/**
 * The shared workspace view, as the plain view contract.
 *
 * @returns The staged view.
 */
export function getWorkspaceVfs(): IWorkspaceFileSystem {
	return getWorkspace().view;
}

/**
 * The staged view with its staging surface exposed (commit / rollback /
 * changedPaths) — for the pending-changes UI and the commit policy.
 *
 * @returns The staged view.
 */
export function getStagedWorkspace(): StagedFileSystem {
	return getWorkspace().view;
}
