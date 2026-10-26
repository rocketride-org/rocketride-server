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
 *   - the root table: the three store roots (apps/ nodes/ pipelines/) and
 *     their translation to the store's physical layout (.projects/.appdev,
 *     .projects/.nodes, loose .pipe files at the .projects root), plus the
 *     read-only .rocketride/, served from the server's guide bundle and
 *     never written to the store,
 *   - the CachedVfs backend enforcing the structural rules (roots are
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
import { ROCKETRIDE_ROOT } from 'shared/modules/vfs/referenceTree';
import type { ReferenceTree } from 'shared/modules/vfs/referenceTree';
import { loadRocketRideReference } from './referenceFiles';

// =============================================================================
// CONSTANTS — physical layout (mirrors appdev/appStore.ts)
// =============================================================================

/** Physical root of the cloud workspace in the user's store tree. */
const PROJECTS_DIR = '.projects';
/** Physical subdirectory holding app projects. */
const APPDEV_DIR = '.appdev';
/** Physical subdirectory holding node packages. */
const NODES_DIR = '.nodes';

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
 * The active scope. Set by createWorkspace() before the first path
 * translation; 'user' until then so pre-bootstrap translations (none are
 * expected) fail safe into the caller's own tree rather than a team's. The
 * workspace backend never reads it: each backend, and the announcements of
 * its staged view, keep the scope they were built for, so a call still
 * running when the team changes lands in its own team. Only the raw binary
 * reads (toScopedStorePath without a scope) and bus adoption
 * (storePathToVirtual) follow it.
 */
let activeScope: WorkspaceScope = { kind: 'user' };

/** Team ids ride inside store paths — allow only plain id characters. */
const SAFE_TEAM_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The physical store-path prefix of a scope: the '@/Team/=<id>/' scope
 * spelling (resolved and authorized server-side by team membership), or ''
 * for the caller's own tree.
 *
 * @param scope - The scope to translate into.
 * @returns The prefix every physical path translation applies.
 */
function scopePrefix(scope: WorkspaceScope): string {
	return scope.kind === 'team' ? `@/Team/=${scope.teamId}/` : '';
}


/**
 * Maps a scope-relative physical path (e.g. '.projects/.appdev/foo') to the
 * full store path in a scope, the ACTIVE one unless told. The escape hatch
 * for the few raw binary reads that bypass the view (appStore.appPath) —
 * everything else goes through toStorePath.
 *
 * @param rel - The scope-relative physical path.
 * @param scope - The scope to translate into (default: the active one).
 * @returns The full store path.
 */
export function toScopedStorePath(rel: string, scope: WorkspaceScope = activeScope): string {
	return `${scopePrefix(scope)}${rel}`;
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
// ROOTS — the workspace's top-level folders <-> physical store paths
// =============================================================================

/** How a top-level folder is served: a directory in the user's store, or a read-only reference tree. */
type RootSpec = { readonly kind: 'store'; readonly dir: string } | { readonly kind: 'reference'; readonly load: () => Promise<ReferenceTree> };

/**
 * The workspace's top-level folders, in display order: the three store roots,
 * each a scope-relative physical directory, then the read-only reference
 * root, whose files come from the server and never touch the store. Listing
 * the root, path parsing, store translation, bus-event mapping and every
 * refusal message derive from this table.
 */
const ROOTS = {
	apps: { kind: 'store', dir: `${PROJECTS_DIR}/${APPDEV_DIR}` },
	nodes: { kind: 'store', dir: `${PROJECTS_DIR}/${NODES_DIR}` },
	pipelines: { kind: 'store', dir: PROJECTS_DIR },
	[ROCKETRIDE_ROOT]: { kind: 'reference', load: loadRocketRideReference },
} as const satisfies Record<string, RootSpec>;

/** A top-level folder's name. */
type RootName = keyof typeof ROOTS;
/** A top-level folder backed by the store. */
type StoreRoot = { [K in RootName]: (typeof ROOTS)[K]['kind'] extends 'store' ? K : never }[RootName];

/** A path under a store root: the only input toStorePath takes. */
type WritablePath = { readonly kind: 'store'; readonly root: StoreRoot; readonly rest: string };
/** A path under the read-only reference root. */
type ReferencePath = { readonly kind: 'reference'; readonly root: Exclude<RootName, StoreRoot>; readonly rest: string };

/** Every root name, in display order. */
const ROOT_NAMES = Object.keys(ROOTS) as RootName[];

/**
 * Whether a root is backed by the store.
 *
 * @param name - A root name.
 * @returns True for the store roots.
 */
function isStoreRoot(name: RootName): name is StoreRoot {
	return ROOTS[name].kind === 'store';
}

/** The store roots, in display order. */
const STORE_ROOTS = ROOT_NAMES.filter(isStoreRoot);

/** The store roots, deepest directory first, so a nested root wins over the one that holds it. */
const STORE_ROOTS_DEEPEST_FIRST = [...STORE_ROOTS].sort((a, b) => ROOTS[b].dir.length - ROOTS[a].dir.length);

/**
 * Names folders for a message, e.g. 'apps/, nodes/ or pipelines/'.
 *
 * @param names - The folder names.
 * @param last - The word before the last folder.
 * @returns The joined list.
 */
function folderList(names: readonly string[], last: 'and' | 'or'): string {
	const folders = names.map((name) => `${name}/`);
	return folders.length > 1 ? `${folders.slice(0, -1).join(', ')} ${last} ${folders[folders.length - 1]}` : folders.join('');
}

/** Where changes may go, for refusal messages. */
const WRITABLE_FOLDERS = folderList(STORE_ROOTS, 'or');

/**
 * Parses a workspace path against the root table. The generic tool layer has
 * already normalized separators and refused traversal; this enforces what is
 * specific to THIS tree.
 *
 * @param raw - A normalized workspace path.
 * @param allowRoot - Whether '' (the workspace root) is acceptable.
 * @returns The parsed path, or null for the root.
 */
function parsePath(raw: string): WritablePath | ReferencePath;
function parsePath(raw: string, allowRoot: true): WritablePath | ReferencePath | null;
function parsePath(raw: string, allowRoot = false): WritablePath | ReferencePath | null {
	const cleaned = String(raw ?? '').replace(/^\/+|\/+$/g, '');
	if (!cleaned) {
		if (allowRoot) return null;
		throw new Error(`A path inside ${WRITABLE_FOLDERS} is required.`);
	}
	const segments = cleaned.split('/').filter((s) => s.length > 0);
	// step: the first segment must be one of the roots
	const root = segments[0] as RootName;
	if (!ROOT_NAMES.includes(root)) {
		throw new Error(`Unknown root '${segments[0]}' — the workspace has exactly ${folderList(ROOT_NAMES, 'and')}.`);
	}
	const rest = segments.slice(1);
	if (!isStoreRoot(root)) return { kind: 'reference', root, rest: rest.join('/') };
	// step: entries directly under a store root may not be dot-named (they
	// would collide with the physical dot-directories the mapping hides)
	if (rest.length > 0 && rest[0].startsWith('.')) {
		throw new Error(`Names directly under ${root}/ may not start with '.': '${rest[0]}'`);
	}
	return { kind: 'store', root, rest: rest.join('/') };
}

/**
 * The store-side parse of a path: the one way to a WritablePath, so a
 * reference path can never become a store write. The staged view runs it
 * before every mutation as its read-only rule.
 *
 * @param path - A normalized workspace path.
 * @returns The parsed store path.
 * @throws "<root>/ is read-only reference. Write under apps/, nodes/ or pipelines/." for a reference root, and parsePath's errors.
 */
function writablePath(path: string): WritablePath {
	const parsed = parsePath(path);
	if (parsed.kind === 'reference') throw new Error(`${parsed.root}/ is read-only reference. Write under ${WRITABLE_FOLDERS}.`);
	return parsed;
}

/**
 * Whether the workspace accepts changes to a path: writablePath's rule as a
 * yes or no.
 *
 * @param path - A workspace path.
 * @returns False for the read-only reference root and paths outside the roots.
 */
export function isWritable(path: string): boolean {
	try {
		writablePath(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Maps a store path to its physical store path in a scope.
 *
 * @param wp - The parsed store path.
 * @param scope - The scope the path lives in.
 * @returns The store-relative physical path.
 */
function toStorePath(wp: WritablePath, scope: WorkspaceScope): string {
	const dir = ROOTS[wp.root].dir;
	return `${scopePrefix(scope)}${wp.rest ? `${dir}/${wp.rest}` : dir}`;
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
 *          or null when the path lies outside the store roots (other
 *          dot-trees like .agents, unrelated store areas).
 */
export function storePathToVirtual(storePath: string): string | null {
	let p = String(storePath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	// step: paths from another scope are NOT this workspace's content — a
	// user-tree event while the workspace is team-rooted (or vice versa)
	// must not be adopted into the virtual tree.
	const prefix = scopePrefix(activeScope);
	if (prefix) {
		if (!p.startsWith(prefix)) return null;
		p = p.slice(prefix.length);
	} else if (p.startsWith('@/')) {
		return null;
	}
	for (const root of STORE_ROOTS_DEEPEST_FIRST) {
		const dir = ROOTS[root].dir;
		if (p === dir) return root;
		if (!p.startsWith(`${dir}/`)) continue;
		const rest = p.slice(dir.length + 1);
		// step: a dot-named first segment is never workspace content: another
		// root's physical folder, a store dot-tree (.agents, .staging), or a
		// name parsePath refuses
		return rest.startsWith('.') ? null : `${root}/${rest}`;
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
 * ARE the other store roots) vanish too.
 *
 * @param client - The connected client.
 * @param wp - The store directory being listed.
 * @param scope - The scope the directory lives in.
 * @returns Entries with name and type.
 */
async function listPhysicalDir(client: RocketRideClient, wp: WritablePath, scope: WorkspaceScope): Promise<Array<{ name: string; type: 'file' | 'dir' }>> {
	const { entries } = await client.fsListDir(toStorePath(wp, scope));
	return entries
		.filter((e) => {
			if (e.name === DIR_MARKER) return false;
			// step: the pipelines root is the .projects root — hide its dot-dirs
			if (wp.root === 'pipelines' && wp.rest === '' && e.name.startsWith('.')) return false;
			return true;
		})
		.map((e) => ({ name: e.name, type: e.type }));
}

// =============================================================================
// BACKEND + VFS — the workspace tree all builders and the agent share
// =============================================================================

/**
 * The CachedVfs backend: an IVirtualFileSystem keyed by VIRTUAL paths that
 * performs the root translation per call, serves the read-only reference
 * root from its tree, enforces the structural rules (protected roots, no
 * cross-root moves), and announces every mutation on the shell event bus.
 * Every store path translates into the scope the backend was built for, so
 * a call that outlives a team switch still lands in its own team's tree.
 *
 * @param scope - The scope every store path translates into.
 * @returns The workspace backend for a CachedVfs.
 */
function createWorkspaceBackend(scope: WorkspaceScope): IVirtualFileSystem {
	return {
		/** Lists one virtual directory ('' = the roots). */
		async list(dir: string): Promise<{ name: string; type: 'file' | 'dir' }[]> {
			const parsed = parsePath(dir, true);
			if (parsed === null) return ROOT_NAMES.map((name) => ({ name, type: 'dir' as const }));
			if (parsed.kind === 'store') return listPhysicalDir(requireClient(), parsed, scope);
			let tree: ReferenceTree;
			try {
				tree = await ROOTS[parsed.root].load();
			} catch (err) {
				// step: an empty folder, not a throw — the tree walk lists every
				// folder in one pass, so a throw here would empty the whole
				// workspace. A read retries the load and shows the error.
				console.warn(`[workspace] ${err instanceof Error ? err.message : String(err)}`);
				return [];
			}
			return tree.list(parsed.rest);
		},
		/** Reads one file as UTF-8 text; a reference file comes from its tree. */
		async read(path: string): Promise<unknown> {
			const parsed = parsePath(path);
			if (parsed.kind === 'reference') return (await ROOTS[parsed.root].load()).read(parsed.rest);
			return requireClient().fsReadString(toStorePath(parsed, scope));
		},
		/**
		 * Batch text read via the store's native fsReadMany (one round trip
		 * per 256 paths instead of one per file); reference files come from
		 * their tree. Same text contract as read(); unreadable entries are
		 * omitted.
		 */
		async readMany(paths: string[]): Promise<Record<string, unknown>> {
			const out: Record<string, unknown> = {};
			const stored: Array<{ path: string; storePath: string }> = [];
			for (const path of paths) {
				const parsed = parsePath(path);
				if (parsed.kind === 'store') {
					stored.push({ path, storePath: toStorePath(parsed, scope) });
					continue;
				}
				try {
					out[path] = (await ROOTS[parsed.root].load()).read(parsed.rest);
				} catch {
					/* unreadable, or the bundle didn't load — omitted by contract */
				}
			}
			if (stored.length === 0) return out;
			const client = requireClient();
			const decoder = new TextDecoder();
			for (let i = 0; i < stored.length; i += 256) {
				const chunk = stored.slice(i, i + 256);
				const results = await client.fsReadMany(chunk.map((s) => s.storePath));
				results.forEach((entry, idx) => {
					if (entry.ok && entry.data) out[chunk[idx].path] = decoder.decode(entry.data);
				});
			}
			return out;
		},
		/** Writes one file as UTF-8 text and announces the change. */
		async write(path: string, content: unknown, origin?: string): Promise<void> {
			const wp = writablePath(path);
			if (!wp.rest) throw new Error(`Cannot write to the ${wp.root}/ root.`);
			const storePath = toStorePath(wp, scope);
			await requireClient().fsWriteString(storePath, String(content));
			emitFsChange(storePath, origin ?? DEFAULT_WRITE_ORIGIN);
		},
		/** Renames within one root and announces both ends. */
		async rename(oldPath: string, newPath: string, origin?: string): Promise<void> {
			const from = writablePath(oldPath);
			const to = writablePath(newPath);
			if (!from.rest || !to.rest) throw new Error('Roots cannot be renamed.');
			// step: an app does not become a node by renaming
			if (from.root !== to.root) {
				throw new Error(`Cannot move between ${from.root}/ and ${to.root}/ — entities do not change kind by renaming.`);
			}
			const fromStore = toStorePath(from, scope);
			const toStore = toStorePath(to, scope);
			await requireClient().fsRename(fromStore, toStore);
			emitFsChange(fromStore, origin ?? DEFAULT_WRITE_ORIGIN);
			emitFsChange(toStore, origin ?? DEFAULT_WRITE_ORIGIN);
		},
		/** Deletes a file (or a directory recursively) and announces it. */
		async delete(path: string, origin?: string): Promise<void> {
			const wp = writablePath(path);
			if (!wp.rest) throw new Error(`Refusing to delete the ${wp.root}/ root.`);
			const client = requireClient();
			const storePath = toStorePath(wp, scope);
			// step: route by actual kind — the tool layer has already enforced
			// the explicit-recursive policy for directories
			const stat = await client.fsStat(storePath);
			if (stat.type === 'dir') await client.fsRmdir(storePath, true);
			else await client.fsDelete(storePath);
			emitFsChange(storePath, origin ?? DEFAULT_WRITE_ORIGIN);
		},
		/** Creates a directory and announces it. */
		async mkdir(path: string, origin?: string): Promise<void> {
			const wp = writablePath(path);
			if (!wp.rest) throw new Error(`The ${wp.root}/ root already exists.`);
			const storePath = toStorePath(wp, scope);
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
	/** The scope the view is rooted in. */
	scope: WorkspaceScope;
	/** The scope's key: '' for the user's own tree, 'team-<id>' for a team's. */
	scopeKey: string;
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
 * Every workspace built in this document, by scope key, with its staging
 * store. A call that started before a team switch can still stage into its
 * workspace after it, so going back to that scope reuses the same
 * workspace: the late change shows as pending there, and the next staged
 * write persists it. A second workspace over the same staging namespace
 * would never see the late change and would rewrite the staging manifest
 * without it. The workspace is reused only while its store's manifest is
 * the one it last loaded or wrote; when another tab changed it meanwhile,
 * a fresh build loads it, as on a first visit.
 */
const builtByScope = new Map<string, { ws: Workspace; staging: StagingStore }>();

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
 * Reopens the workspace of a scope the user switched away from and back to.
 * Its staged layers are the live ones, late writes included, and the caller
 * has checked that no other tab changed the persisted ones since, so nothing
 * rehydrates. Its base cache is dropped and its tree walked again, since
 * nothing kept them current while another scope was active; a read still on
 * its way from before cannot refill the cache (CachedVfs.fill). The mode is
 * decided again the way a fresh build decides it.
 *
 * @param kept - The scope's workspace from before.
 * @param autoCommit - The host's autoCommit setting value.
 * @returns The workspace service, ready for its first read.
 */
async function reopenWorkspace(kept: Workspace, autoCommit: boolean): Promise<Workspace> {
	const view = kept.view;
	view.invalidate();
	try {
		await view.refresh();
	} catch (err) {
		console.log('[workspace] scope switch: re-walking the tree failed:', err);
	}
	const pendingBlocksAuto = autoCommit && view.hasPendingChanges();
	const effectiveAuto = autoCommit && !pendingBlocksAuto;
	if (effectiveAuto) void view.setWriteThrough(true);
	return { ...kept, policy: new CommitPolicy(view, effectiveAuto), pendingBlocksAuto };
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
	// fresh against the new tree, or reopen the workspace built for it
	// before. Chained through workspaceBuild so a
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
		// step: a scope built before keeps its workspace; calls that outlived
		// the switch may still stage into it. Not when another tab changed
		// the scope's staged state meanwhile: the kept layers would erase it.
		const kept = builtByScope.get(scopeKey);
		if (kept && (await kept.staging.isCurrent())) {
			workspace = await reopenWorkspace(kept.ws, options.autoCommit);
			builtByScope.set(scopeKey, { ...kept, ws: workspace });
			return workspace;
		}
		const base = new CachedVfs(createWorkspaceBackend(scope), { skipDirs: SKIP_DIRS });
		// step: staged until rehydration settles — write-through cannot be
		// decided before the restored pending state is known. Staging is
		// namespaced per scope: each team's (and the user tree's) pending
		// state rehydrates only into its own workspace.
		const staging = new StagingStore(options.hostAppId, scopeKey);
		const view = new StagedFileSystem(base, staging, {
			writeThrough: false,
			// step: the read-only rule — a change to .rocketride/ (or outside
			// the roots) is refused before it stages, in both modes
			assertWritable: writablePath,
			// step: staged mutations announce on the SAME bus as physical
			// writes — manual mode's saves reach every onFsChange consumer
			// (dev preview, rescans) exactly like write-through saves do.
			// Write-through delegates to the backend, which announces itself.
			// Either way the path is named in this workspace's scope, even
			// after a team switch.
			onMutate: (p, origin) => emitFsChange(toStorePath(writablePath(p), scope), origin ?? DEFAULT_WRITE_ORIGIN),
		});
		await view.whenReady();
		const pendingBlocksAuto = options.autoCommit && view.hasPendingChanges();
		const effectiveAuto = options.autoCommit && !pendingBlocksAuto;
		if (effectiveAuto) void view.setWriteThrough(true);
		const policy = new CommitPolicy(view, effectiveAuto);
		workspace = { view, scope, scopeKey, policy, pendingBlocksAuto };
		builtByScope.set(scopeKey, { ws: workspace, staging });
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
