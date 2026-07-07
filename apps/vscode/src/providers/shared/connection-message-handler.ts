// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * ConnectionMessageHandler — shared message routing for connection-related
 * webview messages (cloud auth, engine versions, test connection, docker/service
 * lifecycle).
 *
 * Used by both SettingsProvider and WelcomeProvider so connection
 * management code is never duplicated.
 */

import * as https from 'https';
import * as vscode from 'vscode';
import { RocketRideClient } from 'rocketride';
import { EngineInstaller } from '../../engine/shared/engine-installer';
import { EngineRegistry } from '../../engine';
import { IMAGE_BASE } from '../../engine/docker/docker-manager';
import { ConnectionManager } from '../../connection/connection';
import { type ConnectionMode } from '../../config';
import { CloudAuthProvider } from '../../auth/CloudAuthProvider';
import { setCachedEngineVersions, setCachedDockerTags, getExtensionContext } from '../../extension';
import { getLogger } from '../../shared/util/output';
import { icons } from '../../shared/util/icons';

// =============================================================================
// TYPES
// =============================================================================

export interface ConnectionMessageHandlerOptions {
	extensionFsPath: string;
	getActiveWebviews: () => Iterable<vscode.Webview>;
	/** Returns the ConnectionManager for status events. Optional — auth-only handlers don't need it. */
	getConnectionManager?: () => ConnectionManager | undefined;
	/** Returns the EngineRegistry for engine operations. Optional — auth-only handlers don't need it. */
	getEngineRegistry?: () => EngineRegistry | undefined;
}

// =============================================================================
// HANDLER
// =============================================================================

/** Maximum number of GitHub API attempts before giving up and caching the failure. */
const MAX_FETCH_ATTEMPTS = 2;

/** How long (ms) to keep cached version results before refetching. */
const VERSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Cached GitHub release list, shared across all consumers (local, service, docker).
 * Prevents duplicate API calls and avoids rate limiting.
 */
interface VersionCache {
	/** Cached release list (empty array on failed fetch). */
	versions: Array<{ tag_name: string; prerelease: boolean }>;
	/** When the cache was populated (Date.now()). */
	fetchedAt: number;
	/** ETag from the last successful GitHub API response (persisted to globalState). */
	etag?: string;
	/** True if the fetch is currently in flight (dedup concurrent callers). */
	fetching: boolean;
	/** Promise that concurrent callers can await while a fetch is in flight. */
	promise?: Promise<void>;
}

/**
 * Shared message router for connection-related webview messages.
 *
 * Handles: cloud auth (sign-in/out/status), team fetching, server info probing,
 * engine version/Docker tag fetching (with caching), ioControl dispatch to
 * engine backends, sudo password relay, and engine status polling.
 *
 * Used by SettingsProvider and WelcomeProvider so that connection
 * management code is never duplicated across webview hosts.
 */
export class ConnectionMessageHandler {
	private readonly engineInstaller: EngineInstaller;
	private pendingSudoPassword: ((pw: string) => void) | null = null;
	private cloudAuthCleanups: Array<() => void> = [];
	private cachedServerInfo: { version: string; capabilities: string[]; platform?: string } | null = null;

	/** Global version cache — populated once, served to all webviews. */
	private versionCache: VersionCache = { versions: [], fetchedAt: 0, fetching: false };

	/** Docker GHCR tag cache — same structure as version cache. */
	private dockerTagCache: { tags: string[]; fetchedAt: number; fetching: boolean; promise?: Promise<void> } = { tags: [], fetchedAt: 0, fetching: false };

	constructor(private readonly opts: ConnectionMessageHandlerOptions) {
		this.engineInstaller = new EngineInstaller(opts.extensionFsPath);

		// Hydrate version cache from persistent storage so the first fetch after
		// a restart can send the saved ETag and get a free 304 (no rate limit hit).
		const persisted = getExtensionContext().globalState
			.get<{ etag: string; versions: Array<{ tag_name: string; prerelease: boolean }> }>('versionCache');
		if (persisted) {
			this.versionCache.etag = persisted.etag;
			this.versionCache.versions = persisted.versions;
			// fetchedAt stays 0 — TTL check still triggers a fetch, but with the
			// saved ETag the response is a free 304 when releases haven't changed.
		}
	}


	/**
	 * Routes a webview message to the appropriate handler.
	 *
	 * @param message - The message from the webview (must have a `type` field).
	 * @param webview - The originating webview, used for sending responses.
	 * @returns `true` if the message was handled, `false` if unrecognized.
	 */
	public async handleMessage(message: { type: string; [key: string]: unknown }, webview: vscode.Webview): Promise<boolean> {
		switch (message.type) {
			case 'cloud:signIn': {
				const cloudAuth = CloudAuthProvider.getInstance();
				await cloudAuth.signIn(process.env.RR_ZITADEL_URL || '', process.env.RR_ZITADEL_VSCODE_CLIENT_ID || '');
				return true;
			}

			case 'cloud:signOut': {
				const cloudAuth = CloudAuthProvider.getInstance();
				await cloudAuth.signOut();
				await this.sendCloudStatus(webview);
				return true;
			}

			case 'cloud:getStatus':
				await this.sendCloudStatus(webview);
				return true;

			case 'fetchTeams':
				await this.fetchCloudTeams(webview, message.hostUrl as string);
				return true;

			case 'fetchVersions':
				// Fetch GitHub releases + Docker GHCR tags in parallel.
				// Both are cached, max 2 retries, broadcast to all active webviews.
				await Promise.all([
					this.fetchAndBroadcastVersions(),
					this.fetchAndBroadcastDockerTags(),
				]);
				return true;

			case 'probeServerInfo':
				this.cachedServerInfo = null; // force re-probe
				await this.probeServerInfo(webview, message.hostUrl as string);
				return true;

			case 'sudoPassword':
				if (this.pendingSudoPassword) {
					this.pendingSudoPassword(message.password as string);
					this.pendingSudoPassword = null;
				}
				return true;

			// Unified engine operation dispatch — webview panels send ioControl
			// messages with a mode (local/docker/service) and a command string
			// (e.g. 'install', 'start', 'stop', 'remove'). The EngineRegistry
			// routes to the correct backend and returns the result. We broadcast
			// the result to all active webviews so every open panel stays in sync.
			case 'ioControl': {
				const mode = message.mode as ConnectionMode;
				const command = message.command as string;
				const params = message.params as Record<string, unknown> | undefined;
				const registry = this.opts.getEngineRegistry?.();
				if (!registry) return false;
				const result = await registry.ioControl(mode, command, params);
				for (const w of this.opts.getActiveWebviews()) {
					w.postMessage({ type: 'ioResult', mode, command, ...result });
				}
				return true;
			}

			default:
				return false;
		}
	}

	/**
	 * Register a cloud auth change listener for a webview.
	 * Returns a cleanup function to call on dispose.
	 */
	public registerCloudAuthListener(webview: vscode.Webview): () => void {
		const cloudAuth = CloudAuthProvider.getInstance();
		const handler = () => this.sendCloudStatus(webview);
		cloudAuth.onDidChange.on('changed', handler);
		const cleanup = () => cloudAuth.onDidChange.removeListener('changed', handler);
		this.cloudAuthCleanups.push(cleanup);
		return cleanup;
	}

	private statusPollInterval?: NodeJS.Timeout;
	private progressHandler?: (event: { mode: string; command: string; message: string }) => void;

	/**
	 * Start polling engine status and forwarding events to all active webviews.
	 * Polls every 3 seconds to detect external state changes
	 * (e.g., NSSM stopping the service, Docker Desktop stopping a container).
	 */
	public async startStatusPolling(): Promise<void> {
		this.stopStatusPolling();

		const cm = this.opts.getConnectionManager?.();
		if (!cm) return;

		// Forward ioControl progress events to webviews
		const registry = this.opts.getEngineRegistry?.();
		if (registry) {
			this.progressHandler = (event: { mode: string; command: string; message: string }) => {
				for (const w of this.opts.getActiveWebviews()) {
					w.postMessage({ type: 'ioProgress', mode: event.mode, command: event.command, message: event.message });
				}
			};
			registry.on('progress', this.progressHandler);
		}

		// Send initial status for service and docker
		await this.pollAndBroadcastStatus();

		// Poll every 3 seconds for external state changes (pull-based)
		this.statusPollInterval = setInterval(() => {
			this.pollAndBroadcastStatus();
		}, 3000);
	}

	/**
	 * Polls service and docker status via static getEngineStatus() and
	 * broadcasts results to all active webviews using the message types
	 * the panels expect.
	 */
	private async pollAndBroadcastStatus(): Promise<void> {
		try {
			const [serviceStatus, dockerStatus] = await Promise.all([
				ConnectionManager.getEngineStatus('service'),
				ConnectionManager.getEngineStatus('docker'),
			]);

			for (const w of this.opts.getActiveWebviews()) {
				w.postMessage({ type: 'serviceStatus', status: serviceStatus });
				w.postMessage({ type: 'dockerStatus', status: dockerStatus });
			}
		} catch {
			// Non-fatal — polling will retry on next interval
		}
	}

	/**
	 * Stop status polling.
	 */
	public stopStatusPolling(): void {
		if (this.statusPollInterval) {
			clearInterval(this.statusPollInterval);
			this.statusPollInterval = undefined;
		}
		if (this.progressHandler) {
			const registry = this.opts.getEngineRegistry?.();
			registry?.removeListener('progress', this.progressHandler);
			this.progressHandler = undefined;
		}
	}

	// =========================================================================
	// SERVER INFO PROBE
	// =========================================================================

	/**
	 * Probe the server for capabilities.
	 * Uses the dev connection manager's URL when connected (actual running
	 * server, which may be on a dynamic port). Falls back to the build-time
	 * ROCKETRIDE_URI for pre-connection probing.
	 * Caches the result so subsequent calls are instant.
	 */
	public async probeServerInfo(webview: vscode.Webview, hostUrl: string): Promise<void> {
		if (this.cachedServerInfo) {
			webview.postMessage({ type: 'serverInfo', ...this.cachedServerInfo });
			return;
		}

		const uri = hostUrl;
		if (!uri) return;

		console.log(`[ConnectionMessageHandler] probeServerInfo: uri=${uri}`);

		try {
			const info = await RocketRideClient.getServerInfo(uri, 5000);
			console.log(`[ConnectionMessageHandler] probeServerInfo result: capabilities=${JSON.stringify(info.capabilities)}, version=${info.version}`);
			this.cachedServerInfo = info;
			webview.postMessage({ type: 'serverInfo', ...info });
		} catch (error) {
			console.log(`[ConnectionMessageHandler] probeServerInfo FAILED: ${error}`);
			// Fall back to showing all modes if probe fails
			webview.postMessage({ type: 'serverInfo', capabilities: [], version: '' });
		}
	}

	// =========================================================================
	// CLOUD AUTH
	// =========================================================================

	public async sendCloudStatus(webview: vscode.Webview): Promise<void> {
		const cloudAuth = CloudAuthProvider.getInstance();
		const signedIn = await cloudAuth.isSignedIn();
		const userName = await cloudAuth.getUserName();
		webview.postMessage({ type: 'cloud:status', signedIn, userName });
	}

	/**
	 * Fetch cloud teams by connecting to the given cloud URL with the
	 * stored cloud auth token. The URL comes from the webview (build-time
	 * ROCKETRIDE_URI injected into the CloudPanel).
	 */
	public async fetchCloudTeams(webview: vscode.Webview, hostUrl: string): Promise<void> {
		const cloudAuth = CloudAuthProvider.getInstance();
		const token = await cloudAuth.getToken();
		if (!token) return;

		const uri = hostUrl;
		if (!uri) return;

		console.log(`[ConnectionMessageHandler] fetchCloudTeams: uri=${uri}`);

		let client: RocketRideClient | undefined;
		try {
			client = new RocketRideClient({ module: 'CONN-CFG', requestTimeout: 8000 });
			await client.connect(token, { uri, timeout: 10000 });

			const teams = this.extractTeams(client.getAccountInfo());
			console.log(`[ConnectionMessageHandler] fetchCloudTeams: ${teams.length} teams found`);
			webview.postMessage({ type: 'teamsLoaded', teams });
		} catch (error) {
			console.log('[ConnectionMessageHandler] Could not fetch cloud teams:', error);
		} finally {
			if (client) client.disconnect().catch(() => {});
		}
	}

	private extractTeams(account: ReturnType<RocketRideClient['getAccountInfo']>): Array<{ id: string; name: string }> {
		if (!account?.organization) return [];
		return (account.organization.teams ?? []).map((t) => ({ id: t.id, name: t.name }));
	}

	// =========================================================================
	// VERSION FETCHING — cached, retry-limited, shared across all consumers
	// =========================================================================

	/**
	 * Fetches GitHub releases (with caching and retry limiting), then broadcasts
	 * the result to ALL active webviews. Also triggers Docker GHCR tag fetch
	 * via EngineOperations.
	 *
	 * Cache behaviour:
	 *   - Results are cached for 5 minutes (VERSION_CACHE_TTL_MS).
	 *   - Concurrent callers share a single in-flight request (deduplication).
	 *   - Max 2 attempts per fetch cycle to avoid rate limiting.
	 *   - On failure, caches an empty result so we don't hammer the API.
	 */
	private async fetchAndBroadcastVersions(): Promise<void> {
		// Serve from cache if still fresh
		const now = Date.now();
		if (this.versionCache.fetchedAt > 0 && (now - this.versionCache.fetchedAt) < VERSION_CACHE_TTL_MS) {
			this.broadcastVersions(this.versionCache.versions);
			return;
		}

		// Deduplicate: if a fetch is already in flight, wait for it
		if (this.versionCache.fetching && this.versionCache.promise) {
			await this.versionCache.promise;
			this.broadcastVersions(this.versionCache.versions);
			return;
		}

		// Start a new fetch
		this.versionCache.fetching = true;
		this.versionCache.promise = this.doFetchVersions();

		try {
			await this.versionCache.promise;
		} finally {
			this.versionCache.fetching = false;
			this.versionCache.promise = undefined;
		}

		this.broadcastVersions(this.versionCache.versions);
	}

	/**
	 * Performs the actual GitHub API call with retry limiting.
	 * Populates the version cache on success or failure.
	 */
	private async doFetchVersions(): Promise<void> {
		const logger = getLogger();

		// Get GitHub token if available (raises rate limit from 60/hr to 5000/hr)
		let githubToken: string | undefined;
		try {
			const session = await vscode.authentication.getSession('github', [], { createIfNone: false });
			githubToken = session?.accessToken;
		} catch {
			/* proceed without token */
		}

		const authMode = githubToken ? 'authenticated' : 'unauthenticated';
		const hasEtag = !!this.versionCache.etag;
		logger.output(`${icons.info} Fetching engine versions (${authMode}, etag=${hasEtag ? 'cached' : 'none'})...`);

		for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
			try {
				const result = await this.engineInstaller.getReleases(
					undefined,
					githubToken,
					this.versionCache.etag
				);

				if (result.status === 'notModified') {
					// Data hasn't changed — just refresh the TTL timestamp.
					// Versions are already correct (hydrated from globalState or previous fetch).
					logger.output(`${icons.success} Engine versions unchanged (304 Not Modified, no rate limit used)`);
					this.versionCache.fetchedAt = Date.now();
					return;
				}

				// Fresh data received — update cache, global state, and persistent storage
				logger.output(`${icons.success} Engine versions fetched: ${result.data.length} releases found`);
				this.versionCache.versions = result.data;
				this.versionCache.fetchedAt = Date.now();
				this.versionCache.etag = result.etag;
				setCachedEngineVersions(result.data);
				getExtensionContext().globalState.update('versionCache', {
					etag: result.etag,
					versions: result.data
				});
				return;
			} catch (error) {
				logger.output(`${icons.warning} Version fetch attempt ${attempt}/${MAX_FETCH_ATTEMPTS} failed: ${error}`);

				// If rate-limited, extract reset time from GitHub response headers
				const rateLimitReset = (error as { response?: { headers?: Record<string, string> } })
					?.response?.headers?.['x-ratelimit-reset'];
				if (rateLimitReset) {
					const resetDate = new Date(Number(rateLimitReset) * 1000);
					const minutesLeft = Math.max(1, Math.ceil((resetDate.getTime() - Date.now()) / 60000));
					logger.output(`${icons.info} GitHub rate limit resets in ~${minutesLeft} minute${minutesLeft === 1 ? '' : 's'} (${resetDate.toLocaleTimeString()})`);
				}

				if (attempt === MAX_FETCH_ATTEMPTS) {
					// All attempts failed. If we have cached versions (from
					// globalState or a prior fetch), serve those instead of
					// clearing the list — the data is still valid.
					this.versionCache.fetchedAt = Date.now();
					if (this.versionCache.versions.length > 0) {
						logger.output(`${icons.info} Serving ${this.versionCache.versions.length} cached versions`);
						setCachedEngineVersions(this.versionCache.versions);
					} else {
						logger.output(`${icons.error} All version fetch attempts failed — no cached data available`);
						setCachedEngineVersions([]);
					}
				}
			}
		}
	}

	/**
	 * Broadcasts the cached version list to all active webviews.
	 */
	private broadcastVersions(versions: Array<{ tag_name: string; prerelease: boolean }>): void {
		for (const w of this.opts.getActiveWebviews()) {
			w.postMessage({ type: 'versionsLoaded', versions });
		}
	}

	// =========================================================================
	// DOCKER GHCR TAG FETCHING — cached, same pattern as GitHub releases
	// =========================================================================

	/**
	 * Fetches GHCR container tags (with caching and deduplication),
	 * then broadcasts `dockerVersionsLoaded` to all active webviews.
	 */
	private async fetchAndBroadcastDockerTags(): Promise<void> {
		const now = Date.now();
		if (this.dockerTagCache.fetchedAt > 0 && (now - this.dockerTagCache.fetchedAt) < VERSION_CACHE_TTL_MS) {
			this.broadcastDockerTags(this.dockerTagCache.tags);
			return;
		}

		if (this.dockerTagCache.fetching && this.dockerTagCache.promise) {
			await this.dockerTagCache.promise;
			this.broadcastDockerTags(this.dockerTagCache.tags);
			return;
		}

		this.dockerTagCache.fetching = true;
		this.dockerTagCache.promise = this.doFetchDockerTags();

		try {
			await this.dockerTagCache.promise;
		} finally {
			this.dockerTagCache.fetching = false;
			this.dockerTagCache.promise = undefined;
		}

		this.broadcastDockerTags(this.dockerTagCache.tags);
	}

	/**
	 * Fetches tags from the GHCR (GitHub Container Registry) API.
	 *
	 * GHCR uses a two-step auth flow even for public images:
	 *   1. Request an anonymous bearer token scoped to the image repository
	 *   2. Use that token to call the OCI distribution tags/list endpoint
	 *
	 * Results are filtered to semver-like tags (plus 'latest' and 'prerelease')
	 * and sorted newest-first for display in the Docker version dropdown.
	 */
	private async doFetchDockerTags(): Promise<void> {
		// Strip the registry prefix to get the scope string GHCR expects
		const scope = IMAGE_BASE.replace('ghcr.io/', '');

		for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
			try {
				// Step 1: Get anonymous bearer token (no credentials needed for public images)
				const tokenUrl = `https://ghcr.io/token?scope=repository:${scope}:pull`;
				const tokenData = await this.httpsGetJson<{ token: string }>(tokenUrl);

				// Step 2: List tags using the OCI distribution API
				const tagsUrl = `https://ghcr.io/v2/${scope}/tags/list`;
				const tagsData = await this.httpsGetJson<{ tags: string[] }>(tagsUrl, tokenData.token);

				// Filter out CI artifacts (sha-xxxx, branch names) — only keep
				// user-facing version tags that the Docker dropdown should display
				const tags = (tagsData.tags || [])
					.filter((t: string) => /^\d+\.\d+/.test(t) || t === 'latest' || t === 'prerelease')
					.sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }));

				this.dockerTagCache.tags = tags;
				this.dockerTagCache.fetchedAt = Date.now();
				setCachedDockerTags(tags);
				return;
			} catch (error) {
				console.error(`[ConnectionMessageHandler] Docker tag fetch attempt ${attempt}/${MAX_FETCH_ATTEMPTS} failed:`, error);
				if (attempt === MAX_FETCH_ATTEMPTS) {
					this.dockerTagCache.tags = [];
					this.dockerTagCache.fetchedAt = Date.now();
					setCachedDockerTags([]);
				}
			}
		}
	}

	/**
	 * Simple HTTPS GET that parses the response body as JSON.
	 *
	 * @param url - The HTTPS URL to fetch.
	 * @param bearerToken - Optional bearer token added as an Authorization header.
	 * @returns The parsed JSON response body.
	 */
	private httpsGetJson<T>(url: string, bearerToken?: string): Promise<T> {
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
				res.on('data', (chunk) => { body += chunk; });
				res.on('end', () => {
					try { resolve(JSON.parse(body)); }
					catch (e) { reject(e); }
				});
			});
			req.on('error', reject);
			req.on('timeout', () => { req.destroy(new Error(`Request to ${url} timed out`)); });
		});
	}

	/**
	 * Resolves 'prerelease' to the newest prerelease tag from the cached GHCR tag list.
	 * Returns null if no prerelease tags are available.
	 */
	private resolveDockerPrerelease(): string | null {
		const tag = this.dockerTagCache.tags.find((t) => t.includes('prerelease') || t.includes('-pre'));
		return tag ?? null;
	}

	private broadcastDockerTags(tags: string[]): void {
		for (const w of this.opts.getActiveWebviews()) {
			w.postMessage({ type: 'dockerVersionsLoaded', tags });
		}
	}

	public dispose(): void {
		this.stopStatusPolling();
		for (const cleanup of this.cloudAuthCleanups) {
			cleanup();
		}
		this.cloudAuthCleanups = [];
	}
}
