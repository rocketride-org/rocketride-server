/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Deploy API namespace for the RocketRide TypeScript SDK.
 *
 * Teams-as-environments deployments over two DAP commands (dispatched by
 * `subcommand`) on the existing WebSocket connection:
 *
 * - `rrext_deploy` — the GENERIC, kind-agnostic rail door: `add` deploys any
 *   kind (pipe|app|node) as an IMMUTABLE, sha256-locked registry version;
 *   `versions`/`artifact`/`history` read the rail.
 * - `rrext_deploy_pipe` — PIPE-specific control: `deploy` points a TEAM at a
 *   published version (teams ARE the environments — Staging, Production, ...;
 *   promotion and rollback are the same pointer move; targets are always
 *   explicit, no default-team fallback), plus its lifecycle, scheduling
 *   (`schedule_*`), and run-now dispatch (`run`).
 * - Every deploy and pointer change lands in an immutable audit history.
 * - `list`/`versions`/`history` return the standard list envelope
 *   (`{rows, total, page, pageSize}`) with page/search/filter/sort params.
 */

import type { RocketRideClient } from './client.js';
import type { DeployHistoryEntry, DeployListEnvelope, DeployListParams, Deployment, DeployArtifact, PipelineConfig, PublishResult, SchedulePreview } from './types/deploy.js';
import { getRegisteredAppPack } from './app-pack-registry.js';
import type { AppPackModule } from './app-pack-registry.js';
import type { AppVerifyReport, CreatedApp } from '../app-pack/index.js';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Folds the standard list-API params into wire arguments.
 *
 * Only supplied values are sent — the server applies its own defaults
 * (page 1, clamped page size) to whatever is absent. `pageSize` maps to the
 * wire's `page_size` key.
 *
 * @param params - The caller's list params.
 * @returns Wire-shaped arguments to spread into the call.
 */
function listArgs(params: DeployListParams): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	if (params.page !== undefined) args.page = params.page;
	if (params.pageSize !== undefined) args.page_size = params.pageSize;
	if (params.search !== undefined) args.search = params.search;
	if (params.filters !== undefined) args.filters = params.filters;
	if (params.sort !== undefined) args.sort = params.sort;
	return args;
}

// =============================================================================
// DEPLOY API CLASS
// =============================================================================

/**
 * Typed wrapper around the `rrext_deploy` (generic rail door) and
 * `rrext_deploy_pipe` (pipe deploy control) DAP commands and their subcommands.
 *
 * Accessed via `client.deploy` — not instantiated directly. All methods
 * delegate to {@link RocketRideClient.call} which handles envelope
 * unwrapping and error propagation.
 */
export class DeployApi {
	/** @param client - The parent RocketRideClient that owns this namespace. */
	constructor(private client: RocketRideClient) {}

	// =========================================================================
	// ADD — deploy any kind of object into the org registry (the ONE rail door)
	// =========================================================================

	/**
	 * Deploys an object to the server as the next immutable registry version.
	 *
	 * The ONE generic rail door for every kind — DEPLOY in the settled
	 * vocabulary means "copy code to the server"; binding it to an audience
	 * is the separate publish step ({@link deploy} for pipe teams; the app
	 * publish verbs for apps). The artifact is sha256-locked: what was
	 * deployed is provably what runs.
	 *
	 * Kind dispatch:
	 * - `kind: 'pipe'` (default) — pass `pipeline` (the full definition;
	 *   `name` REQUIRED: it renders on every deploy surface forever).
	 * - `kind: 'app'` — pass `data` (ONE zip of the app's SOURCE — the server
	 *   owns the build and never trusts client-produced binaries). Two
	 *   layouts: package.json + src at the zip root (legacy), or
	 *   workspace-relative with `metadata.appRoot` naming the app folder so
	 *   `appManifest.include` extras ride at their real workspace paths. The
	 *   server retains the zip and unpacks it at receipt; the app deployment
	 *   is born state 'private' (internally publishable — an @me/@team binding
	 *   may serve it; the developer submits it for review to reach the public
	 *   store).
	 *
	 * @param options.kind - 'pipe' (default) | 'app'.
	 * @param options.pipeline - The pipeline definition (kind 'pipe').
	 * @param options.data - The source zip bytes (kind 'app').
	 * @param options.metadata - Optional metadata blob (e.g. projectId
	 *   provenance, appRoot for workspace-relative app zips).
	 * @param options.comment - "What changed" note kept in the registry.
	 * @param options.deployTo - Team id to deploy the new version to
	 *   immediately (one-step add+deploy; pipes only).
	 * @returns The artifact entry, plus the deployment when `deployTo` was given.
	 */
	async add(options: { kind?: 'pipe' | 'app' | 'node'; pipeline?: PipelineConfig & { name: string }; data?: Uint8Array; metadata?: Record<string, unknown>; comment?: string; deployTo?: string }): Promise<PublishResult> {
		return this.client.call<PublishResult>('rrext_deploy', {
			subcommand: 'add',
			kind: options.kind ?? 'pipe',
			...(options.pipeline !== undefined && { pipeline: options.pipeline }),
			...(options.data !== undefined && { data: options.data }),
			...(options.metadata !== undefined && { metadata: options.metadata }),
			...(options.comment !== undefined && { comment: options.comment }),
			...(options.deployTo !== undefined && { deployTo: options.deployTo }),
		});
	}

	/**
	 * Loads the Node-only app packer: the registry when a host armed it (a
	 * bundled host side-effect-imports `rocketride/app-pack`), else a
	 * runtime dynamic self-import that keeps the fs/zip machinery out of
	 * browser bundles (same pattern as `use({ filepath })`).
	 */
	private async loadAppPack(): Promise<AppPackModule> {
		if (typeof window !== 'undefined') {
			throw new Error('App packing requires Node.js - pack and deploy from a script or CI, not the browser.');
		}
		const registered = getRegisteredAppPack();
		if (registered) {
			return registered;
		}
		const dynamicImport = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<AppPackModule>;
		return dynamicImport('rocketride/app-pack');
	}

	/**
	 * Packs an app folder's source and deploys it as the next immutable
	 * registry version — the ONE call behind the App Builder's Deploy
	 * button, the CLI's `app deploy`, and CI scripts (Node.js only).
	 *
	 * Verify → pack → send: the pack applies the canonical rules
	 * (workspace-rooted zip layout, `appManifest.include` honored,
	 * hierarchical gitignore filtering with the hard baseline
	 * node_modules/dist/.git, symlink containment, 50MB zipped / 512MB
	 * uncompressed caps) and every step can narrate through `onProgress`.
	 * Deploying never activates anything — bind an audience with
	 * `publishApp` afterwards. Run `verifyApp` first for a no-side-effect
	 * precheck of the same rules.
	 *
	 * @param appRoot - The app folder: absolute, or relative to
	 *   `options.workspaceRoot`.
	 * @param options.workspaceRoot - The workspace the zip is rooted at and
	 *   that `appManifest.include` entries resolve against
	 *   (default: `process.cwd()`).
	 * @param options.comment - "What changed" note kept in the registry.
	 * @param options.metadata - Extra metadata merged over the packed
	 *   defaults (e.g. projectId provenance); `appRoot` is always set from
	 *   the pack.
	 * @param options.onProgress - Receives one line per pack step (include
	 *   checks, per-file adds, totals) for hosts that surface progress.
	 * @returns The artifact entry for the new version.
	 */
	async addApp(appRoot: string, options: { workspaceRoot?: string; comment?: string; metadata?: Record<string, unknown>; onProgress?: (line: string) => void } = {}): Promise<PublishResult> {
		const pack = await this.loadAppPack();
		const packed = pack.packAppSource(options.workspaceRoot ?? process.cwd(), appRoot, options.onProgress);
		return this.add({
			kind: 'app',
			data: packed.data,
			metadata: { ...options.metadata, ...(packed.appRoot ? { appRoot: packed.appRoot } : {}) },
			...(options.comment !== undefined && { comment: options.comment }),
		});
	}

	/**
	 * Scaffolds a new app in the workspace — the programmatic twin of the
	 * App Builder's New App wizard, rendering the identical templates
	 * (Node.js only). Writes `./apps/<slug>`, ensures the pnpm workspace
	 * file and ignore hygiene, vendors the connected server's shell +
	 * client packages, and runs the workspace install. Scaffolding only —
	 * nothing is deployed; the normal lifecycle (edit → `verifyApp` →
	 * `addApp` → `publishApp`) follows.
	 *
	 * @param slug - The app-name slug (lowercase; digits/-/_ after the
	 *   first character). The id becomes `<developerId>.<slug>`.
	 * @param options - Template, display name, developer id (default
	 *   'local'), frame options, install toggle, `onProgress`, and
	 *   `workspaceRoot` (default `process.cwd()`). The server base URL for
	 *   vendoring defaults to this client's own connection.
	 * @returns The created app's identity and a report of what ran.
	 */
	async createApp(slug: string, options: { workspaceRoot?: string; template?: 'Blank' | 'Dashboard'; displayName?: string; developerId?: string; sidebar?: boolean; statusFooter?: boolean; docTabs?: boolean; install?: boolean; serverBaseUrl?: string; onProgress?: (line: string) => void } = {}): Promise<CreatedApp> {
		const pack = await this.loadAppPack();
		// Vendor from the server THIS client talks to unless overridden —
		// ws(s) URIs map onto the http(s) origin serving /client/*.
		let serverBaseUrl = options.serverBaseUrl;
		if (!serverBaseUrl) {
			const uri = this.client.getConnectionInfo().uri;
			if (uri) {
				serverBaseUrl = uri.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/task\/service\/?$/i, '').replace(/\/+$/, '');
			}
		}
		const { workspaceRoot, onProgress, ...rest } = options;
		return pack.createAppWorkspace(workspaceRoot ?? process.cwd(), slug, { ...rest, serverBaseUrl, onProgress });
	}

	/**
	 * Pre-checks everything `addApp` needs, WITHOUT deploying (Node.js
	 * only, purely local — no server call). Verifies the manifest shape and
	 * id grammar, declared icon/README assets, `appManifest.include`
	 * entries, and a pack dry run against the size caps. Server-side
	 * concerns (the build, store review) are out of scope — the Package
	 * tab's readiness and the review ladder cover those.
	 *
	 * @param appRoot - The app folder: absolute, or relative to
	 *   `options.workspaceRoot`.
	 * @param options.workspaceRoot - The workspace the pack would be rooted
	 *   at (default: `process.cwd()`).
	 * @returns The structured report — `ok` plus every check with an
	 *   actionable note.
	 */
	async verifyApp(appRoot: string, options: { workspaceRoot?: string } = {}): Promise<AppVerifyReport> {
		const pack = await this.loadAppPack();
		return pack.verifyAppSource(options.workspaceRoot ?? process.cwd(), appRoot);
	}

	// =========================================================================
	// DEPLOY — point a team at a version (promotion and rollback alike)
	// =========================================================================

	/**
	 * Points a team at a published version.
	 *
	 * Promotion (Staging → Production) and rollback (v3 → v2) are both this
	 * call — the team's pointer moves, nothing else changes. The team is
	 * always explicit; requires `task.control` on it.
	 *
	 * @param projectId - The project whose artifact to deploy.
	 * @param version - The registry version to point the team at.
	 * @param teamId - The target team (the environment).
	 * @returns The updated deployment record, registry-joined.
	 */
	async deploy(projectId: string, version: number, teamId: string): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy_pipe', {
			subcommand: 'deploy',
			projectId,
			version,
			teamId,
		});
	}

	// =========================================================================
	// READS — standard list envelopes
	// =========================================================================

	/**
	 * Deployments visible to the caller, as the standard list envelope.
	 *
	 * @param params - Optional team scope + list-API params.
	 * @param params.teamId - Restrict to one team; omitted = the visibility
	 *   model: the caller's member teams plus their own personal space, and
	 *   the whole org for an org admin.
	 * @returns `{rows, total, page, pageSize}` of {@link Deployment} rows.
	 */
	async list(params: DeployListParams & { teamId?: string } = {}): Promise<DeployListEnvelope<Deployment>> {
		return this.client.call<DeployListEnvelope<Deployment>>('rrext_deploy_pipe', {
			subcommand: 'list',
			...(params.teamId !== undefined && { teamId: params.teamId }),
			...listArgs(params),
		});
	}

	/**
	 * One team's deployment of a project, registry-joined.
	 *
	 * @param projectId - The project.
	 * @param teamId - The team whose deployment to fetch.
	 * @returns The deployment record (version, state, schedules, actors).
	 */
	async get(projectId: string, teamId: string): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy_pipe', {
			subcommand: 'get',
			projectId,
			teamId,
		});
	}

	/**
	 * The org-registry versions of a project (the version strip), newest
	 * first, as the standard list envelope.
	 *
	 * @param projectId - The project whose registry to read.
	 * @param params - Optional list-API params.
	 * @returns `{rows, total, page, pageSize}` of {@link DeployArtifact} rows.
	 */
	async versions(projectId: string, params: DeployListParams = {}): Promise<DeployListEnvelope<DeployArtifact>> {
		return this.client.call<DeployListEnvelope<DeployArtifact>>('rrext_deploy', {
			subcommand: 'versions',
			projectId,
			...listArgs(params),
		});
	}

	/**
	 * Starts one deployed source NOW (manual trigger).
	 *
	 * The same trusted team dispatch the scheduler uses — the run executes
	 * as the team and carries NO human identity; billing attributes to the
	 * org and team, and who fired it is recorded only in the deployment's
	 * audit history. The deployment must be enabled.
	 *
	 * @param projectId - The deployed project.
	 * @param sourceId - The pipeline source to fire.
	 * @param teamId - The team whose deployment to run.
	 * @returns The started run's token and the version that ran.
	 */
	async run(projectId: string, sourceId: string, teamId: string): Promise<{ token?: string; version?: number }> {
		return this.client.call<{ token?: string; version?: number }>('rrext_deploy_pipe', {
			subcommand: 'run',
			projectId,
			sourceId,
			teamId,
		});
	}

	/**
	 * Fetches one immutable artifact's pipeline JSON from the registry.
	 *
	 * sha256-verified server-side on load: what you get is provably what was
	 * published. This is the source of truth for read-only rendering of a
	 * deployed version — never a local file, never a running task.
	 *
	 * @param projectId - The project.
	 * @param version - The registry version to fetch.
	 * @returns The pipeline definition exactly as published.
	 */
	async artifact(projectId: string, version: number): Promise<PipelineConfig> {
		return this.client.call<PipelineConfig>('rrext_deploy', {
			subcommand: 'artifact',
			projectId,
			version,
		});
	}

	/**
	 * The immutable audit trail of a project, newest first, as the standard
	 * list envelope.
	 *
	 * The trail is unbounded by design (who published what when, who put
	 * which version live where) — the server pages it; rows carry `seq`, the
	 * stable append-order key, as their identity.
	 *
	 * @param projectId - The project whose trail to read.
	 * @param params - Optional team scope + list-API params (`filters.at__gte`
	 *   / `at__lte` take epoch seconds).
	 * @param params.teamId - Restrict to one team's pointer changes
	 *   (org-wide publish rows always ride along).
	 * @returns `{rows, total, page, pageSize}` of {@link DeployHistoryEntry} rows.
	 */
	async history(projectId: string, params: DeployListParams & { teamId?: string } = {}): Promise<DeployListEnvelope<DeployHistoryEntry>> {
		return this.client.call<DeployListEnvelope<DeployHistoryEntry>>('rrext_deploy', {
			subcommand: 'history',
			projectId,
			...(params.teamId !== undefined && { teamId: params.teamId }),
			...listArgs(params),
		});
	}

	// =========================================================================
	// STATE — enable / disable / soft remove
	// =========================================================================

	/**
	 * Disables one team's deployment — the kill switch: NOTHING runs
	 * (schedules stop firing and manual runs are refused) until it is
	 * enabled again.
	 *
	 * @param projectId - The project.
	 * @param teamId - The team whose deployment to disable.
	 * @returns The updated deployment record.
	 */
	async disable(projectId: string, teamId: string): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy_pipe', {
			subcommand: 'disable',
			projectId,
			teamId,
		});
	}

	/**
	 * Enables one team's disabled deployment.
	 *
	 * @param projectId - The project.
	 * @param teamId - The team whose deployment to enable.
	 * @returns The updated deployment record.
	 */
	async enable(projectId: string, teamId: string): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy_pipe', {
			subcommand: 'enable',
			projectId,
			teamId,
		});
	}

	/**
	 * Soft-removes one team's deployment.
	 *
	 * Listings hide it; the audit history and every registry artifact
	 * survive forever (the enterprise requirement). Re-deploying any version
	 * revives it.
	 *
	 * @param projectId - The project.
	 * @param teamId - The team whose deployment to remove.
	 * @returns The final deployment record (state `removed`).
	 */
	async remove(projectId: string, teamId: string): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy_pipe', {
			subcommand: 'remove',
			projectId,
			teamId,
		});
	}

	// =========================================================================
	// SCHEDULES
	// =========================================================================

	/**
	 * Sets (or clears) one source's schedule on a team deployment.
	 *
	 * The paused flag is untouched — editing cron/ttl preserves it (a new
	 * schedule starts unpaused); {@link pauseSchedule}/{@link resumeSchedule}
	 * own it.
	 *
	 * @param projectId - The project.
	 * @param sourceId - The pipeline source the schedule fires.
	 * @param schedule - 5-field cron expression; `null` or `'manual'` clears
	 *   the schedule.
	 * @param teamId - The team whose deployment to schedule.
	 * @param options - Optional schedule options.
	 * @param options.ttl - Run window in seconds ('fixed window'); omitted
	 *   runs each task until the pipeline finishes.
	 * @returns The updated deployment record.
	 */
	async setSchedule(projectId: string, sourceId: string, schedule: string | null, teamId: string, options: { ttl?: number } = {}): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy_pipe', {
			subcommand: 'schedule_set',
			projectId,
			sourceId,
			teamId,
			...(schedule !== null && { schedule }),
			...(options.ttl !== undefined && { ttl: options.ttl }),
		});
	}

	/**
	 * Sets one source's execution settings (trace level + debug output).
	 *
	 * These ride every deploy run of the source — scheduled and manual —
	 * exactly like the dev-run settings. Editing the schedule never touches
	 * them; a source keeps its settings even with no schedule.
	 *
	 * @param projectId - The project.
	 * @param sourceId - The source whose settings to store.
	 * @param teamId - The team whose deployment carries them.
	 * @param options - The settings.
	 * @param options.traceLevel - Trace verbosity; omit/null for the deploy
	 *   default (full).
	 * @param options.debugOut - Full task debug output (--trace=debugOut).
	 * @returns The updated deployment record.
	 */
	async setSourceConfig(projectId: string, sourceId: string, teamId: string, options: { traceLevel?: 'none' | 'metadata' | 'summary' | 'full' | null; debugOut?: boolean } = {}): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy_pipe', {
			subcommand: 'source_config',
			projectId,
			sourceId,
			teamId,
			...(options.traceLevel ? { traceLevel: options.traceLevel } : {}),
			debugOut: options.debugOut ?? false,
		});
	}

	/**
	 * Pauses ONE source's schedule — the cron/ttl stay configured, it just
	 * stops firing until resumed.
	 *
	 * @param projectId - The project.
	 * @param sourceId - The source whose schedule to pause.
	 * @param teamId - The team whose deployment carries the schedule.
	 * @returns The updated deployment record.
	 */
	async pauseSchedule(projectId: string, sourceId: string, teamId: string): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy_pipe', {
			subcommand: 'schedule_pause',
			projectId,
			sourceId,
			teamId,
		});
	}

	/**
	 * Resumes a paused source schedule.
	 *
	 * @param projectId - The project.
	 * @param sourceId - The source whose schedule to resume.
	 * @param teamId - The team whose deployment carries the schedule.
	 * @returns The updated deployment record.
	 */
	async resumeSchedule(projectId: string, sourceId: string, teamId: string): Promise<Deployment> {
		return this.client.call<Deployment>('rrext_deploy_pipe', {
			subcommand: 'schedule_resume',
			projectId,
			sourceId,
			teamId,
		});
	}

	/**
	 * Validates a schedule and returns its next occurrences.
	 *
	 * THE single cron evaluator: panel validation, "next:" lines, and DVR
	 * ghost tracks all render from this — nothing client-side parses cron,
	 * so a preview can never disagree with what the scheduler fires.
	 *
	 * @param schedule - 5-field cron expression (or `'manual'`).
	 * @param count - How many upcoming occurrences to return (server-capped).
	 * @returns Validity plus the next occurrence timestamps.
	 */
	async preview(schedule: string, count?: number): Promise<SchedulePreview> {
		return this.client.call<SchedulePreview>('rrext_deploy_pipe', {
			subcommand: 'preview',
			schedule,
			...(count !== undefined && { count }),
		});
	}
}
