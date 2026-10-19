// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SETTINGS / CLOUD / ENGINE OPS — the VS Code extension host's implementations
// =============================================================================
//
// The vocabulary is declared in shared/ops/settingsOps.ts; this file is the
// extension-host side of it: the Welcome and Settings page realms configure
// THIS process (its secret store, its staged cloud auth, its engine
// installs) entirely over these ops. It absorbs what used to be
// ConnectionMessageHandler + the provider save paths, with the postMessage
// framing stripped: results answer the caller directly, pushes ride the
// broadcast feed (host.cloud.statusChanged / host.engine.statusChanged /
// host.engine.progress / host.settings.*).
// =============================================================================

import * as https from 'https';
import * as vscode from 'vscode';
import { RocketRideClient, ConnectionException } from 'rocketride';
// Deep imports on purpose — ext-host-safe .ts leaves (see busHost.ts).
import { registerOpHandlers } from 'shell/src/ops/busOps';
import type { IOpBus, OpImplTable } from 'shell/src/ops/busOps';
import type { SettingsHostOpMap, SettingsData, SettingsPayload, SettingsOpenArgs, CloudAuthStatus, EngineVersionItem, EngineVersionsPayload, EngineStatusPayload, EngineProgress } from 'shared/ops/settingsOps';
import { EngineInstaller } from '../engine/shared/engine-installer';
import { IMAGE_BASE } from '../engine/docker/docker-manager';
import { ConnectionManager, commitStagedCloudCredentials } from '../connection/connection';
import { ConfigManager, type SettingsSnapshot } from '../config';
import { CloudAuthProvider } from '../auth/CloudAuthProvider';
import { AgentManager } from '../agents/agent-manager';
import { getConnectionManager, getEngineRegistry, setCachedEngineVersions, setCachedDockerTags } from '../extension';
import { isSubscribed } from '../shared/util/subscriptionGate';
import { PIPE_BUILDER_APP_ID } from '../shared/types';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';

// =============================================================================
// TYPES
// =============================================================================

/** What the registrations need from the host. */
export interface ISettingsOpsDeps {
	context: vscode.ExtensionContext;
	/** Fire-and-forget op to every attached realm (BusHost.broadcastEmitOp). */
	broadcast: (op: string, params: unknown) => void;
}

/** The host-side hooks the extension wires to the pages' panel lifecycle. */
export interface ISettingsOpsController {
	/** Stores + pushes the Settings open command's arguments (focus/authError).
	 *  Called on EVERY command invocation so stale args never replay. */
	setOpenArgs(args: SettingsOpenArgs): void;
	/** A settings-family page's panel opened/revealed — engine status polling
	 *  runs while any such page is open. Idempotent per page. */
	pageOpened(page: string): void;
	/**
	 * A settings-family page's panel closed. On a USER exit without a save in
	 * flight, any staged cloud sign-in/sign-out is discarded (the settings
	 * surfaces are transactional — nothing uncommitted survives them). A save
	 * already in flight OWNS the staged change and commits it itself.
	 */
	pageClosed(page: string, userClosed: boolean): void;
}

/** Maximum GitHub/GHCR attempts before caching the failure. */
const MAX_FETCH_ATTEMPTS = 2;

/** How long (ms) to keep cached version results before refetching. */
const VERSION_CACHE_TTL_MS = 5 * 60 * 1000;

const WELCOME_DISMISSED_KEY = 'welcomeDismissed';

// =============================================================================
// REGISTRATION
// =============================================================================

/**
 * Registers the extension host's settings/cloud/engine op implementations
 * and returns the panel-lifecycle controller the extension wires to the
 * Welcome/Settings FrameworkProvider hooks. Disposal rides
 * context.subscriptions.
 */
export function registerVscodeSettingsOps(bus: IOpBus, deps: ISettingsOpsDeps): ISettingsOpsController {
	const { context, broadcast } = deps;
	const configManager = ConfigManager.getInstance();
	const versions = new VersionCatalog(context);

	/** True while host.settings.save is committing — the close-discard guard. */
	let isSaving = false;
	/** The Settings open command's last arguments. */
	let openArgs: SettingsOpenArgs = {};

	// ── Cloud auth change feed — stored AND staged changes push one status.
	const cloudAuth = CloudAuthProvider.getInstance();
	const onAuthChanged = (): void => {
		void buildCloudStatus().then((status) => broadcast('host.cloud.statusChanged', status));
	};
	cloudAuth.onDidChange.on('changed', onAuthChanged);
	context.subscriptions.push({ dispose: () => cloudAuth.onDidChange.removeListener('changed', onAuthChanged) });

	// ── Settings payload (the one copy of what used to be loadAllSettings).
	const buildSettingsPayload = (): SettingsPayload => {
		const config = configManager.getConfig();
		const workspaceConfig = vscode.workspace.getConfiguration('rocketride');
		const hasApiKey = configManager.hasApiKey();

		// The cloudUrl settings' package.json defaults — HOST-ONLY knowledge
		// (the page probes the effective target but bakes no address).
		const devDefaultCloudUrl = vscode.workspace.getConfiguration('rocketride.development').inspect<string>('cloudUrl')?.defaultValue ?? '';
		const depDefaultCloudUrl = vscode.workspace.getConfiguration('rocketride.deployment').inspect<string>('cloudUrl')?.defaultValue ?? '';

		const settings: SettingsData = {
			development: {
				connectionMode: config.development.connectionMode,
				hostUrl: config.development.hostUrl,
				useCustomServer: config.development.useCustomServer,
				cloudUrl: config.development.cloudUrl,
				defaultCloudUrl: devDefaultCloudUrl,
				hasApiKey,
				apiKey: hasApiKey ? config.development.apiKey || '' : '',
				local: { engineVersion: config.development.local.engineVersion },
			},
			deployment: {
				connectionMode: config.deployment.connectionMode,
				hostUrl: config.deployment.hostUrl,
				useCustomServer: config.deployment.useCustomServer,
				cloudUrl: config.deployment.cloudUrl,
				defaultCloudUrl: depDefaultCloudUrl,
				hasApiKey: !!config.deployment.apiKey,
				apiKey: config.deployment.apiKey || '',
				local: { engineVersion: config.deployment.local.engineVersion },
			},
			defaultPipelinePath: config.defaultPipelinePath,
			pipelineRestartBehavior: config.pipelineRestartBehavior,
			pipelineTtl: config.pipelineTtl,
			pipelineTraceLevel: config.pipelineTraceLevel,
			taskArguments: config.taskArguments,
			pipelineDebugOutput: config.pipelineDebugOutput,
			autoAgentIntegration: workspaceConfig.get('integrations.autoAgentIntegration', true),
			integrationCopilot: workspaceConfig.get('integrations.copilot', false),
			integrationClaudeCode: workspaceConfig.get('integrations.claudeCode', false),
			integrationCursor: workspaceConfig.get('integrations.cursor', false),
			integrationWindsurf: workspaceConfig.get('integrations.windsurf', false),
			integrationClaudeMd: workspaceConfig.get('integrations.claudeMd', false),
			integrationAgentsMd: workspaceConfig.get('integrations.agentsMd', false),
		};

		return { settings, isSubscribed: isSubscribed(getConnectionManager()?.getClient(), PIPE_BUILDER_APP_ID) };
	};

	/**
	 * The one save path (Settings' Save AND Welcome's Save & Connect).
	 *
	 *   1. Atomic config write (listeners suppressed during the batch).
	 *   2. Commit any STAGED cloud sign-in/sign-out — the credential lands in
	 *      SecretStorage only here, together with the form it belongs to.
	 *   3. Mark welcome dismissed (the user has configured settings).
	 *   4. Cancel stale debounced config-change handlers (they would race the
	 *      reconcile) and reconcile engines. With `connect` (the Welcome
	 *      flow), initialization + reconcile are AWAITED — the caller closes
	 *      the page only once the first connection is underway; a plain save
	 *      resolves immediately and reconciles in the background so engine
	 *      downloads never block the "saved" feedback.
	 */
	const save = async (params: { settings: SettingsData; connect?: boolean }): Promise<void> => {
		isSaving = true;
		try {
			await configManager.applyAllSettings(params.settings as unknown as SettingsSnapshot);
			await commitStagedCloudCredentials();
			await vscode.workspace.getConfiguration('rocketride').update(WELCOME_DISMISSED_KEY, true, vscode.ConfigurationTarget.Global);
		} finally {
			isSaving = false;
		}

		// Every open settings-family realm refreshes to the authoritative state.
		broadcast('host.settings.changed', buildSettingsPayload());

		const connectionManager = getConnectionManager();
		// The welcomeDismissed write fires a config-change event AFTER the
		// batch flag clears — cancel it so it doesn't race the reconcile.
		connectionManager?.cancelPendingConfigChange();

		if (params.connect) {
			// Welcome flow: initialize CMs then reconcile — same order as a
			// normal activation (the welcome gate skipped all of it until now).
			if (connectionManager) await connectionManager.initialize();
			await getEngineRegistry()?.reconcile();
			return;
		}

		// Plain save: engines reconcile and agent stubs install in the
		// background — failures surface as notifications, never as a rejected
		// save (the settings themselves are already persisted).
		void (async () => {
			try {
				await getEngineRegistry()?.reconcile();
			} catch (err) {
				getLogger().error(`[settingsOps] Post-save engine reconcile failed: ${String(err)}`);
			}
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (workspaceFolder) {
				try {
					await new AgentManager().installFromSettings(workspaceFolder.uri);
				} catch (agentErr) {
					vscode.window.showWarningMessage(`Agent documentation install failed: ${agentErr}`);
				}
			}
		})();
	};

	// ── Engine status polling — runs while any settings-family page is open.
	const openPages = new Set<string>();
	let statusPollInterval: NodeJS.Timeout | undefined;
	let progressHandler: ((event: EngineProgress) => void) | undefined;

	const pollEngineStatus = async (): Promise<EngineStatusPayload> => {
		const [serviceStatus, dockerStatus] = await Promise.all([ConnectionManager.getEngineStatus('service'), ConnectionManager.getEngineStatus('docker')]);
		return { service: serviceStatus, docker: dockerStatus };
	};

	const startStatusPolling = (): void => {
		if (statusPollInterval) return;
		// Streamed install/update progress rides its own push.
		const registry = getEngineRegistry();
		if (registry && !progressHandler) {
			progressHandler = (event) => broadcast('host.engine.progress', event);
			registry.on('progress', progressHandler);
		}
		const tick = (): void => {
			pollEngineStatus().then(
				(payload) => broadcast('host.engine.statusChanged', payload),
				() => { /* non-fatal — the next tick retries */ }
			);
		};
		tick();
		// 3s: external state (NSSM stopping the service, Docker Desktop
		// stopping a container) has no event to listen for.
		statusPollInterval = setInterval(tick, 3000);
	};

	const stopStatusPolling = (): void => {
		if (statusPollInterval) {
			clearInterval(statusPollInterval);
			statusPollInterval = undefined;
		}
		if (progressHandler) {
			getEngineRegistry()?.removeListener('progress', progressHandler);
			progressHandler = undefined;
		}
	};
	context.subscriptions.push({ dispose: stopStatusPolling });

	// ── The op table ────────────────────────────────────────────────────────
	const impls: OpImplTable<SettingsHostOpMap> = {
		'host.settings.get': () => buildSettingsPayload(),
		'host.settings.save': (p) => save(p),
		'host.settings.clearCredentials': async () => {
			await configManager.deleteApiKey('development');
			broadcast('host.settings.changed', buildSettingsPayload());
			return { hasApiKey: configManager.hasApiKey() };
		},
		'host.settings.getOpenArgs': () => openArgs,

		'host.cloud.status': () => buildCloudStatus(),
		'host.cloud.signIn': async (p) => {
			// Prefer the form's IN-FORM effective server (unsaved edits
			// included); fall back to the saved config — and for a payload
			// that is not a usable string: realm messages are untrusted input,
			// and signIn's contract is a string URL.
			const requested = typeof p.cloudUrl === 'string' ? p.cloudUrl.trim() : '';
			await cloudAuth.signIn(process.env.RR_ZITADEL_URL || '', process.env.RR_ZITADEL_VSCODE_CLIENT_ID || '', requested || ConfigManager.getInstance().getEffectiveCloudUrl());
		},
		// Staged, not applied: the stored session is deleted only on save.
		// Both mutate pending state, which emits 'changed' → statusChanged push.
		'host.cloud.signOutStaged': () => cloudAuth.stageSignOut(),
		'host.cloud.clearPending': () => cloudAuth.clearPendingChanges(),

		'host.engine.versions': () => versions.fetchBoth(),
		'host.engine.status': () => pollEngineStatus(),
		'host.engine.control': async (p) => {
			const registry = getEngineRegistry();
			if (!registry) throw new Error('Engine registry not available');
			return registry.ioControl(p.mode, p.command, p.params);
		},

		// Same untrusted-input rule as cloudUrl: the type is erased at runtime
		// and getServerInfo needs a string.
		'host.server.probe': (p) => probeServerInfo(typeof p.hostUrl === 'string' ? p.hostUrl.trim() : ''),
	};
	registerOpHandlers<SettingsHostOpMap>(bus, impls);

	return {
		setOpenArgs: (args) => {
			openArgs = args;
			broadcast('host.settings.openArgs', args);
		},
		pageOpened: (page) => {
			openPages.add(page);
			startStatusPolling();
		},
		pageClosed: (page, userClosed) => {
			openPages.delete(page);
			if (openPages.size === 0) stopStatusPolling();
			// Closing without saving discards any staged sign-in/sign-out. A
			// save in flight owns the staged change — discarding here would
			// race it and throw away a sign-in the user was told was saved.
			if (userClosed && !isSaving) cloudAuth.clearPendingChanges();
			// Closing the welcome page by ANY user exit (tab X, Advanced
			// Settings, Save & Connect) counts as dismissal — it never nags
			// again. Host shutdown is not a user exit. Best-effort write.
			if (page === 'welcome' && userClosed) {
				vscode.workspace
					.getConfiguration('rocketride')
					.update(WELCOME_DISMISSED_KEY, true, vscode.ConfigurationTarget.Global)
					.then(undefined, () => { /* best effort */ });
			}
		},
	};
}

// =============================================================================
// CLOUD STATUS
// =============================================================================

async function buildCloudStatus(): Promise<CloudAuthStatus> {
	const cloudAuth = CloudAuthProvider.getInstance();
	const [signedIn, userName, signedInUrl] = await Promise.all([cloudAuth.isSignedIn(), cloudAuth.getUserName(), cloudAuth.getSignedInUrl()]);
	const waitlistedName = cloudAuth.getWaitlistedName();
	const pending = cloudAuth.getPendingSession();
	return {
		signedIn,
		userName,
		signedInUrl,
		waitlisted: waitlistedName !== null,
		waitlistedName: waitlistedName ?? '',
		pendingSignIn: pending !== null,
		pendingUserName: pending?.displayName ?? '',
		pendingUrl: pending?.cloudUrl ?? '',
		pendingSignOut: cloudAuth.hasPendingSignOut(),
	};
}

// =============================================================================
// SERVER PROBE
// =============================================================================

/**
 * Unauthenticated capability probe. Always probes fresh (panels ask on URL
 * change); the result answers the caller directly — no echo-routing.
 */
async function probeServerInfo(hostUrl: string): Promise<{ version: string; capabilities: string[]; platform?: string; unreachable?: boolean }> {
	if (!hostUrl) return { version: '', capabilities: [], unreachable: true };
	try {
		return await RocketRideClient.getServerInfo(hostUrl, 5000);
	} catch (error) {
		// Transport-level failures are ConnectionExceptions; anything else
		// means a socket opened — reachable, just not probe-capable (legacy/OSS).
		return { version: '', capabilities: [], unreachable: error instanceof ConnectionException };
	}
}

// =============================================================================
// VERSION CATALOGS — GitHub releases + GHCR tags, cached, retry-limited
// =============================================================================

interface ReleaseCache {
	versions: EngineVersionItem[];
	fetchedAt: number;
	/** ETag from the last successful GitHub response (persisted to globalState
	 *  so the first fetch after a restart gets a free 304). */
	etag?: string;
	promise?: Promise<void>;
}

/**
 * The two engine version catalogs, cached for 5 minutes with concurrent-call
 * dedup and a 2-attempt budget (GitHub rate limits are real). Successful
 * fetches also feed the extension-global caches the engine backends read.
 */
class VersionCatalog {
	private readonly installer: EngineInstaller;
	private releases: ReleaseCache = { versions: [], fetchedAt: 0 };
	private docker: { tags: string[]; fetchedAt: number; promise?: Promise<void> } = { tags: [], fetchedAt: 0 };

	constructor(private readonly context: vscode.ExtensionContext) {
		this.installer = new EngineInstaller(context.extensionUri.fsPath);
		// Hydrate from persistent storage: the saved ETag makes the first
		// fetch a free 304 when releases haven't changed. fetchedAt stays 0 —
		// the TTL check still triggers that fetch.
		const persisted = context.globalState.get<{ etag: string; versions: EngineVersionItem[] }>('versionCache');
		if (persisted) {
			this.releases.etag = persisted.etag;
			this.releases.versions = persisted.versions;
		}
	}

	/** Both catalogs, in parallel, each served from cache when fresh. */
	public async fetchBoth(): Promise<EngineVersionsPayload> {
		await Promise.all([this.ensureReleases(), this.ensureDockerTags()]);
		return { releases: this.releases.versions, dockerTags: this.docker.tags };
	}

	private async ensureReleases(): Promise<void> {
		const now = Date.now();
		if (this.releases.fetchedAt > 0 && now - this.releases.fetchedAt < VERSION_CACHE_TTL_MS) return;
		if (!this.releases.promise) {
			this.releases.promise = this.fetchReleases().finally(() => {
				this.releases.promise = undefined;
			});
		}
		await this.releases.promise;
	}

	private async fetchReleases(): Promise<void> {
		const logger = getLogger();

		// A GitHub token raises the rate limit from 60/hr to 5000/hr.
		let githubToken: string | undefined;
		try {
			const session = await vscode.authentication.getSession('github', [], { createIfNone: false });
			githubToken = session?.accessToken;
		} catch {
			/* proceed without token */
		}

		logger.output(`${icons.info} Fetching engine versions (${githubToken ? 'authenticated' : 'unauthenticated'}, etag=${this.releases.etag ? 'cached' : 'none'})...`);

		for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
			try {
				const result = await this.installer.getReleases(undefined, githubToken, this.releases.etag);

				if (result.status === 'notModified') {
					// Unchanged — refresh the TTL; versions are already correct.
					logger.output(`${icons.success} Engine versions unchanged (304 Not Modified, no rate limit used)`);
					this.releases.fetchedAt = Date.now();
					return;
				}

				logger.output(`${icons.success} Engine versions fetched: ${result.data.length} releases found`);
				this.releases.versions = result.data;
				this.releases.fetchedAt = Date.now();
				this.releases.etag = result.etag;
				setCachedEngineVersions(result.data);
				void this.context.globalState.update('versionCache', { etag: result.etag, versions: result.data });
				return;
			} catch (error) {
				logger.output(`${icons.warning} Version fetch attempt ${attempt}/${MAX_FETCH_ATTEMPTS} failed: ${error}`);

				const rateLimitReset = (error as { response?: { headers?: Record<string, string> } })?.response?.headers?.['x-ratelimit-reset'];
				if (rateLimitReset) {
					const resetDate = new Date(Number(rateLimitReset) * 1000);
					const minutesLeft = Math.max(1, Math.ceil((resetDate.getTime() - Date.now()) / 60000));
					logger.output(`${icons.info} GitHub rate limit resets in ~${minutesLeft} minute${minutesLeft === 1 ? '' : 's'} (${resetDate.toLocaleTimeString()})`);
				}

				if (attempt === MAX_FETCH_ATTEMPTS) {
					// Cache the failure (don't hammer the API); keep serving any
					// data we already have — it is still valid.
					this.releases.fetchedAt = Date.now();
					if (this.releases.versions.length > 0) {
						logger.output(`${icons.info} Serving ${this.releases.versions.length} cached versions`);
						setCachedEngineVersions(this.releases.versions);
					} else {
						logger.output(`${icons.error} All version fetch attempts failed — no cached data available`);
						setCachedEngineVersions([]);
					}
				}
			}
		}
	}

	private async ensureDockerTags(): Promise<void> {
		const now = Date.now();
		if (this.docker.fetchedAt > 0 && now - this.docker.fetchedAt < VERSION_CACHE_TTL_MS) return;
		if (!this.docker.promise) {
			this.docker.promise = this.fetchDockerTags().finally(() => {
				this.docker.promise = undefined;
			});
		}
		await this.docker.promise;
	}

	/**
	 * GHCR uses a two-step auth flow even for public images: an anonymous
	 * bearer token scoped to the repository, then the OCI tags/list endpoint.
	 * Results are filtered to user-facing version tags, newest first.
	 */
	private async fetchDockerTags(): Promise<void> {
		const scope = IMAGE_BASE.replace('ghcr.io/', '');

		for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
			try {
				const tokenData = await httpsGetJson<{ token: string }>(`https://ghcr.io/token?scope=repository:${scope}:pull`);
				const tagsData = await httpsGetJson<{ tags: string[] }>(`https://ghcr.io/v2/${scope}/tags/list`, tokenData.token);

				// Filter out CI artifacts (sha-xxxx, branch names).
				const tags = (tagsData.tags || [])
					.filter((t: string) => /^\d+\.\d+/.test(t) || t === 'latest' || t === 'prerelease')
					.sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }));

				this.docker.tags = tags;
				this.docker.fetchedAt = Date.now();
				setCachedDockerTags(tags);
				return;
			} catch (error) {
				getLogger().error(`[settingsOps] Docker tag fetch attempt ${attempt}/${MAX_FETCH_ATTEMPTS} failed: ${String(error)}`);
				if (attempt === MAX_FETCH_ATTEMPTS) {
					this.docker.tags = [];
					this.docker.fetchedAt = Date.now();
					setCachedDockerTags([]);
				}
			}
		}
	}
}

/** Simple HTTPS GET that parses the response body as JSON. */
function httpsGetJson<T>(url: string, bearerToken?: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const options: https.RequestOptions = {
			headers: {
				'User-Agent': 'RocketRide-VSCode',
				...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
			},
			timeout: 15000,
		};
		const req = https.get(url, options, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error(`HTTP ${res.statusCode} from ${url}`));
				return;
			}
			let body = '';
			res.on('data', (chunk) => {
				body += chunk;
			});
			res.on('end', () => {
				try {
					resolve(JSON.parse(body));
				} catch (e) {
					reject(e);
				}
			});
		});
		req.on('error', reject);
		req.on('timeout', () => {
			req.destroy(new Error(`Request to ${url} timed out`));
		});
	});
}
