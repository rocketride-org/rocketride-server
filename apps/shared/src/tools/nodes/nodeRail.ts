// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// NODE RAIL — the deploy/publish host the shared DeployView runs for a node
// =============================================================================
//
// A published node rides the same rail as an app: immutable versions, each
// published to @me or a team. The server speaks `rrext_deploy add` with kind
// 'node' (upload a .rrnode) and `rrext_deploy_node` (versions / publish /
// unpublish); this module maps those onto the IAppBuilderHost members the
// DeployView already renders. A node has no @public rung and no review ladder.
// =============================================================================

import type { AppVersionInfo, IAppBuilderHost, RungKind, RungPin } from '../appdev/types';

/** One registry version as `rrext_deploy_node versions` answers it. */
export interface WireNodeVersion {
	version: number;
	sha256?: string;
	publishedBy?: { display?: string; userId?: string };
	publishedAt?: number;
	comment?: string;
	state?: string;
}

/** One audience binding as `rrext_deploy_node versions` answers it. */
export interface WireNodePublish {
	audience: { type: string; id: string };
	version: number;
	state?: string;
	updatedAt?: number;
	publishedAt?: number;
}

/** The body of `rrext_deploy_node versions`. */
export interface WireNodeRail {
	versions?: WireNodeVersion[];
	publishes?: WireNodePublish[];
}

/** A team the caller belongs to. */
export interface NodeTeam {
	id: string;
	name: string;
}

/** The rung, label, handle and audience line of one live binding. */
function pinOf(p: WireNodePublish, teams: NodeTeam[]): Pick<RungPin, 'rung' | 'label' | 'handle' | 'audience'> {
	if (p.audience.type === 'user') return { rung: 'personal', label: 'Personal', handle: '@me', audience: 'you' };
	// The publish picker compares handles by team NAME; the server takes either
	const name = teams.find((t) => t.id === p.audience.id)?.name ?? p.audience.id;
	return { rung: 'team', label: 'Team', handle: `@team/${name}`, audience: 'team members' };
}

/**
 * Maps a node's rail onto the DeployView shapes: versions newest first, each
 * with the rungs it is live on, and one pin per live binding.
 *
 * @param rail - The `versions` body.
 * @param teams - The caller's teams, to name team handles.
 * @returns The version cards and the Where-live rows.
 */
export function toNodeRail(rail: WireNodeRail, teams: NodeTeam[]): { versions: AppVersionInfo[]; pins: RungPin[] } {
	const live = (rail.publishes ?? []).filter((p) => p.state === 'enabled' && (p.audience.type === 'user' || p.audience.type === 'team'));
	const pins: RungPin[] = live.map((p) => ({
		...pinOf(p, teams),
		registryVersion: p.version,
		version: '',
		state: 'enabled',
		deployedAt: p.updatedAt ?? p.publishedAt,
	}));
	const versions: AppVersionInfo[] = [...(rail.versions ?? [])]
		.sort((a, b) => b.version - a.version)
		.map((v) => ({
			registryVersion: v.version,
			// A node has no semver of its own: the registry int is its version
			version: '',
			author: v.publishedBy?.display || v.publishedBy?.userId || '',
			publishedAt: v.publishedAt ?? 0,
			sha: v.sha256,
			message: v.comment || undefined,
			rungs: [...new Set(pins.filter((p) => p.registryVersion === v.version).map((p) => p.rung))] as RungKind[],
			// A node has no review: only a failed upload gets a badge
			state: v.state === 'failed' ? 'failed' : undefined,
			// The upload is the build: a version that is not failed serves
			buildStatus: v.state === 'failed' ? 'failed' : '',
		}));
	return { versions, pins };
}

/** The client members the node host reaches. */
interface INodeRailClient {
	call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
	deploy: { add(options: { kind: 'node'; data: Uint8Array; comment?: string }): Promise<{ artifact?: { nodeId?: string; version?: number } }> };
}

/** What the node host needs from the realm (the ConnectionManager, structurally). */
export interface INodeRailBus {
	getClient(): unknown;
	getAccountInfo(): { organization?: { teams?: Array<{ id: string; name: string }> } | null } | undefined;
	refreshServices?(): Promise<void>;
}

/** Inputs of {@link createNodeRailHost}. */
export interface INodeRailHostOptions {
	bus: INodeRailBus;
	/** The node shown, `<developerId>.<name>`. */
	nodeId: string;
	/** Lets the developer choose the .rrnode to upload as the next version. */
	pickPackage: () => Promise<Uint8Array | null>;
}

/**
 * Builds the IAppBuilderHost the DeployView runs for one node.
 *
 * @param o - See {@link INodeRailHostOptions}.
 * @returns The host: versions, Where-live, deploy (upload), publish, unpublish, teams.
 */
export function createNodeRailHost(o: INodeRailHostOptions): IAppBuilderHost {
	const { bus, nodeId, pickPackage } = o;
	const client = (): INodeRailClient => {
		const c = bus.getClient() as INodeRailClient | null;
		if (!c) throw new Error('Not connected to server');
		return c;
	};
	const teams = (): NodeTeam[] => (bus.getAccountInfo()?.organization?.teams ?? []).map((t) => ({ id: t.id, name: t.name }));
	const rail = async () => toNodeRail(await client().call<WireNodeRail>('rrext_deploy_node', { nodeId, subcommand: 'versions' }), teams());
	// The catalogue shows a published node only where it is published: refresh it after a change
	const refreshCatalogue = () => void bus.refreshServices?.().catch(() => undefined);

	return {
		capabilities: { hasNativeFiles: false, canDebug: false, hasReviewLadder: false },
		listVersions: async () => (await rail()).versions,
		getWhereLive: async () => (await rail()).pins,
		listTeams: async () => teams(),
		deploy: async (message) => {
			const data = await pickPackage();
			if (!data) throw new Error('No package was chosen.');
			const added = await client().deploy.add({ kind: 'node', data, comment: message || undefined });
			const uploaded = added.artifact?.nodeId;
			if (uploaded && uploaded !== nodeId) {
				throw new Error(`That package is ${uploaded}, not ${nodeId}; it was added as a version of ${uploaded}.`);
			}
		},
		publish: async (version, target) => {
			await client().call('rrext_deploy_node', { nodeId, subcommand: 'publish', version, target });
			refreshCatalogue();
		},
		removePublish: async (target) => {
			await client().call('rrext_deploy_node', { nodeId, subcommand: 'unpublish', target });
			refreshCatalogue();
		},
	};
}

/**
 * Asks the developer for a .rrnode file and reads it.
 *
 * Must be called from a click: the browser opens a file chooser only during one.
 *
 * @returns The package bytes, or null when the chooser is dismissed.
 */
export function pickNodePackage(): Promise<Uint8Array | null> {
	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.rrnode,application/zip';
		input.addEventListener('change', () => {
			const file = input.files?.[0];
			if (!file) return resolve(null);
			void file.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)));
		});
		input.addEventListener('cancel', () => resolve(null));
		input.click();
	});
}

/**
 * Uploads a .rrnode as a new node (or a new version of one) and says which node it was.
 *
 * @param bus - The realm's ConnectionManager.
 * @param data - The package bytes.
 * @returns The node id the server read from the package.
 */
export async function uploadNodePackage(bus: INodeRailBus, data: Uint8Array): Promise<string> {
	const c = bus.getClient() as INodeRailClient | null;
	if (!c) throw new Error('Not connected to server');
	const added = await c.deploy.add({ kind: 'node', data });
	const nodeId = added.artifact?.nodeId;
	if (!nodeId) throw new Error('The server did not say which node the package is');
	return nodeId;
}

/**
 * The node id a workspace .rrnode names: `acme__echo.rrnode`, or the
 * `.rrnode` marker inside `acme__echo/`, is the node `acme.echo`.
 *
 * @param path - View-relative path of the .rrnode.
 * @returns The node id, or null when the name is not a published node's module.
 */
export function nodeIdOfPackage(path: string): string | null {
	const parts = path.split('/');
	const leaf = parts.pop() ?? '';
	// The bare marker names its folder; a package file names itself
	const module = leaf === '.rrnode' ? (parts.pop() ?? '') : leaf.slice(0, -'.rrnode'.length);
	const at = module.indexOf('__');
	return at > 0 && at < module.length - 2 ? `${module.slice(0, at)}.${module.slice(at + 2)}` : null;
}
