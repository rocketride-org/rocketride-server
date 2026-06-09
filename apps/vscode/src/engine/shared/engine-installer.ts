// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * engine-installer.ts — Engine Download and Installation
 *
 * Downloads engine releases from GitHub, extracts them into a single `engine/`
 * directory, and tracks the installed version via a version file (e.g., `version.local.json`).
 *
 * Only one engine version exists on disk at a time. Installing a new version
 * replaces the previous one. The engine executable path is always fixed at
 * `<parentDir>/engine/engine(.exe)` — callers never need to update paths
 * when switching versions.
 *
 * Uses a cross-process lockfile so multiple VS Code windows can safely share
 * the same engine directory. No process management or connection state —
 * that belongs to EngineManager.
 *
 * Directory layout:
 *   <parentDir>/engine/
 *     engine.exe | engine           — engine binary
 *     ai/eaas.py                    — Python entrypoint
 *   <parentDir>/version.*.json        — { tag, publishedAt } installed version
 *     install.lock                  — cross-process lockfile
 *     engine-<pid>.pid              — written by EngineManager per running process
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as lockfile from 'proper-lockfile';
import { execFile, execFileSync } from 'child_process';
import { getLogger } from '../../shared/util/output';
import { icons } from '../../shared/util/icons';

// =============================================================================
// TYPES
// =============================================================================

/** GitHub release asset metadata. */
interface ReleaseAsset {
	id: number;
	name: string;
	browser_download_url: string;
	size: number;
}

/** GitHub release metadata (tag, date, assets). */
interface ReleaseInfo {
	tag_name: string;
	published_at: string;
	assets: ReleaseAsset[];
}

/** Item in the version picker dropdown. */
export interface ReleaseListItem {
	tag_name: string;
	prerelease: boolean;
}

/**
 * Result of a conditional GitHub API call using ETags.
 * - `data`: fresh data returned (HTTP 200); includes the new ETag for future requests.
 * - `notModified`: server confirmed cached version is still current (HTTP 304, free — no rate limit hit).
 */
export type ConditionalResult<T> =
	| { status: 'data'; data: T; etag: string | undefined }
	| { status: 'notModified' };

/** Platform-specific archive naming. */
interface PlatformInfo {
	name: string;
	ext: string;
}

/** Contents of the version tracking file (e.g., version.local.json). */
interface InstalledVersion {
	tag: string;
	publishedAt: string;
}

// =============================================================================
// ENGINE INSTALLER
// =============================================================================

/**
 * EngineInstaller — downloads, installs, and manages a single engine version.
 *
 * Only one version exists on disk at a time in the `engine/` subdirectory.
 * Installing a new version replaces the old one. The executable path is
 * always `<parentDir>/engine/engine(.exe)`.
 */
export class EngineInstaller {
	private static readonly GITHUB_OWNER = 'rocketride-org';
	private static readonly GITHUB_REPO = 'rocketride-server';

	/** The engine/ directory (e.g., C:\ProgramData\RocketRide\engine). */
	private readonly engineDir: string;

	/** The parent directory (e.g., C:\ProgramData\RocketRide). */
	private readonly parentDir: string;

	/** Filename for version tracking (e.g., 'version.local.json'). */
	private readonly versionFileName: string;

	private readonly logger = getLogger();

	/**
	 * @param parentDir - Parent directory. The engine will be installed
	 *   into a `engine/` subdirectory of this path.
	 * @param versionFileName - Name of the version tracking file, stored in
	 *   parentDir (not inside engine/ — survives engine dir clears).
	 *   Defaults to 'version.json'.
	 */
	constructor(parentDir: string, versionFileName: string = 'version.json') {
		this.parentDir = parentDir;
		this.engineDir = path.join(parentDir, 'engine');
		this.versionFileName = versionFileName;
	}

	// =========================================================================
	// PATHS
	// =========================================================================

	/** Returns the engine/ directory path. */
	get dir(): string {
		return this.engineDir;
	}

	/** Returns the platform-specific executable filename (engine.exe or engine). */
	private executableName(): string {
		return process.platform === 'win32' ? 'engine.exe' : 'engine';
	}

	/** Returns the full path to the engine executable. */
	public getExecutablePath(): string {
		return path.join(this.engineDir, this.executableName());
	}

	/**
	 * Path to the cross-process lockfile in the parent directory (not inside
	 * engine/ — that gets cleared during install). proper-lockfile creates a
	 * <file>.lock directory next to this file as its locking mechanism.
	 */
	private lockFilePath(): string {
		return path.join(path.dirname(this.engineDir), '.installing');
	}

	/** Path to the version tracking file in the parent directory. */
	private versionJsonPath(): string {
		return path.join(this.parentDir, this.versionFileName);
	}

	/** Creates the parent dir, engine/ subdir, and lockfile if they don't exist. */
	private ensureEngineDir(): void {
		fs.mkdirSync(this.engineDir, { recursive: true });
		const lockPath = this.lockFilePath();
		if (!fs.existsSync(lockPath)) {
			fs.mkdirSync(path.dirname(lockPath), { recursive: true });
			fs.writeFileSync(lockPath, '', 'utf8');
		}
	}

	// =========================================================================
	// PUBLIC API
	// =========================================================================

	/** Returns true if an engine executable exists on disk. */
	public isInstalled(): boolean {
		return fs.existsSync(this.getExecutablePath());
	}

	/**
	 * Reads version file from the engine directory.
	 * Returns null if no engine is installed or the file is missing/corrupt.
	 */
	public getInstalledVersion(): InstalledVersion | null {
		try {
			const p = this.versionJsonPath();
			if (fs.existsSync(p)) {
				// Verify the engine binary actually exists — version file alone
				// can be a leftover from a partial uninstall
				if (!fs.existsSync(this.getExecutablePath())) return null;
				return JSON.parse(fs.readFileSync(p, 'utf8')) as InstalledVersion;
			}
		} catch {
			// Corrupt or unreadable — treat as unknown version
		}
		return null;
	}

	/**
	 * Ensures the engine is installed at the requested version. Downloads if
	 * needed, replacing the current engine/ contents.
	 *
	 * Uses a cross-process lockfile so multiple VS Code windows coordinate safely.
	 * Returns the path to the engine executable (always the same fixed path).
	 *
	 * @param versionSpec - 'latest', 'prerelease', or a specific tag (e.g., 'server-3.2.0')
	 * @param progress - Progress reporter for UI feedback
	 * @param token - Cancellation token
	 * @param githubToken - Optional GitHub token for higher API rate limits
	 */
	public async install(
		versionSpec: string = 'latest',
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<string> {
		const displaySpec = versionSpec.replace(/^server-/, '');
		this.logger.output(`${icons.info} Engine version requested: ${displaySpec}`);

		// Ensure engine directory and lockfile exist
		this.ensureEngineDir();

		// Acquire cross-process lock (blocking — waits for other windows)
		progress?.report({ message: 'Waiting for engine lock...' });
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(this.lockFilePath(), {
				stale: 120000,
				retries: { retries: 30, minTimeout: 2000, maxTimeout: 5000 },
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to acquire engine install lock: ${msg}`);
		}

		try {
			const exePath = await this.installUnderLock(versionSpec, progress, token, githubToken);
			// Run the runtime-dep check on EVERY install attempt, not just fresh
			// downloads. installUnderLock has three return paths (fresh download,
			// "already up to date" short-circuit, GitHub-unreachable fallback);
			// users whose engine was installed before this check existed only hit
			// the latter two, so putting the check here is the only way to reach
			// them without forcing a manual uninstall+reinstall.
			await this.checkLinuxRuntimeDeps(exePath);
			return exePath;
		} finally {
			try { await release(); } catch { /* ignore stale lock */ }
		}
	}

	/**
	 * Removes the entire engine/ directory.
	 * Uses the cross-process lock to prevent races.
	 */
	public async uninstall(): Promise<void> {
		this.ensureEngineDir();
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(this.lockFilePath(), {
				stale: 120000,
				retries: { retries: 5, minTimeout: 1000, maxTimeout: 3000 },
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to acquire engine lock for uninstall: ${msg}`);
		}
		try {
			if (fs.existsSync(this.engineDir)) {
				fs.rmSync(this.engineDir, { recursive: true, force: true });
				this.logger.output(`${icons.info} Engine uninstalled from ${this.engineDir}`);
			}
		} finally {
			try { await release(); } catch { /* ignore stale lock */ }
		}
	}

	// =========================================================================
	// INSTALL LOGIC (under lock)
	// =========================================================================

	/**
	 * Core install logic — runs inside the cross-process lock.
	 *
	 * 1. Fetch the target release from GitHub
	 * 2. Compare tag against installed version file — skip if same
	 * 3. Clear engine/ contents (preserve lockfile and PID files)
	 * 4. Extract new archive into engine/
	 * 5. Write version file
	 */
	private async installUnderLock(
		versionSpec: string,
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<string> {
		const displaySpec = versionSpec.replace(/^server-/, '');
		const exePath = this.getExecutablePath();
		const installed = this.getInstalledVersion();

		// --- Resolve the target release ---
		let releaseInfo: ReleaseInfo;
		try {
			progress?.report({ message: 'Checking for updates...' });
			releaseInfo = await this.fetchRelease(versionSpec, token, githubToken);
		} catch {
			// GitHub unreachable — use what's already installed if we have it
			if (installed && fs.existsSync(exePath)) {
				this.logger.output(`${icons.info} Could not check for updates, using installed version`);
				return exePath;
			}
			throw new Error(`No engine installed and cannot reach GitHub to download ${displaySpec}`);
		}

		// --- Already up to date? ---
		if (installed && installed.tag === releaseInfo.tag_name && fs.existsSync(exePath)) {
			const displayTag = releaseInfo.tag_name.replace(/^server-/, '');
			this.logger.output(`${icons.success} Engine ${displayTag} already installed`);
			return exePath;
		}

		// --- Download and install ---
		return this.downloadAndInstall(releaseInfo, progress, token, githubToken);
	}

	// =========================================================================
	// DOWNLOAD AND EXTRACT
	// =========================================================================

	/**
	 * Downloads a release archive, clears the engine directory, extracts the
	 * new version, writes version file, and returns the executable path.
	 */
	private async downloadAndInstall(
		release: ReleaseInfo,
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<string> {
		const displayVersion = release.tag_name.replace(/^server-/, '');

		// Find the correct asset for this platform
		const asset = this.findPlatformAsset(release);
		this.logger.output(`${icons.info} Found release ${displayVersion}: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);

		// Download to a temp file
		const tmpPath = path.join(os.tmpdir(), `rocketride-engine-${Date.now()}${asset.name.endsWith('.zip') ? '.zip' : '.tar.gz'}`);

		try {
			progress?.report({ message: `Downloading ${displayVersion}...` });
			await this.downloadAsset(asset, tmpPath, displayVersion, progress, token, githubToken);
			this.throwIfCancelled(token);

			// Clear existing engine contents (preserve lockfile and PID files)
			this.clearEngineDir();

			// Extract into engine/
			fs.mkdirSync(this.engineDir, { recursive: true });
			progress?.report({ message: 'Extracting server...' });
			await this.extractArchive(tmpPath, this.engineDir);

			// Set executable permissions on Unix
			const exePath = this.getExecutablePath();
			if (process.platform !== 'win32' && fs.existsSync(exePath)) {
				fs.chmodSync(exePath, 0o755);
			}

			// Verify the executable exists
			if (!fs.existsSync(exePath)) {
				throw new Error(`Engine extraction completed but executable not found at: ${exePath}`);
			}

			// (Runtime dep check runs in install() after this returns, so it
			// covers fresh downloads AND "already installed" short-circuits.)

			// Write version file so we know what's installed
			this.writeVersionJson({ tag: release.tag_name, publishedAt: release.published_at });

			this.logger.output(`${icons.success} Server ${release.tag_name} installed at ${this.engineDir}`);
			progress?.report({ message: 'Server ready!' });

			return exePath;
		} finally {
			// Clean up temp file
			try {
				if (fs.existsSync(tmpPath)) {
					fs.unlinkSync(tmpPath);
				}
			} catch {
				// Ignore cleanup errors
			}
		}
	}

	/**
	 * Removes all files from engine/ except install.lock and PID files.
	 * Called before extracting a new version.
	 */
	private clearEngineDir(): void {
		if (!fs.existsSync(this.engineDir)) return;

		for (const entry of fs.readdirSync(this.engineDir, { withFileTypes: true })) {
			// Keep PID files for processes that are still alive
			if (entry.name.endsWith('.pid')) {
				try {
					const pidStr = fs.readFileSync(path.join(this.engineDir, entry.name), 'utf8').trim();
					const pid = parseInt(pidStr, 10);
					if (!isNaN(pid) && isPidAlive(pid)) continue;
				} catch { /* stale — allow removal */ }
			}

			const fullPath = path.join(this.engineDir, entry.name);
			try {
				fs.rmSync(fullPath, { recursive: true, force: true });
			} catch {
				// EBUSY on Windows — binary may be locked by a running process
				this.logger.output(`${icons.warning} Could not remove ${entry.name} (may be in use)`);
			}
		}
	}

	/** Writes version file into the engine directory. */
	private writeVersionJson(version: InstalledVersion): void {
		fs.writeFileSync(this.versionJsonPath(), JSON.stringify(version, null, 2), 'utf8');
	}

	// =========================================================================
	// GITHUB API
	// =========================================================================

	/**
	 * Fetches all available releases for the version dropdown.
	 * Returns server-tagged releases with assets, sorted newest first.
	 *
	 * Supports ETag-based conditional requests: pass the ETag from a previous
	 * response to get a free HTTP 304 (not counted against GitHub rate limit)
	 * when releases haven't changed.
	 */
	public async getReleases(
		token?: vscode.CancellationToken,
		githubToken?: string,
		etag?: string
	): Promise<ConditionalResult<ReleaseListItem[]>> {
		this.throwIfCancelled(token);
		const octokit = await this.createOctokit(githubToken);

		// Build conditional request headers
		const headers: Record<string, string> = {};
		if (etag) {
			headers['if-none-match'] = etag;
		}

		try {
			const response = await octokit.repos.listReleases({
				owner: EngineInstaller.GITHUB_OWNER,
				repo: EngineInstaller.GITHUB_REPO,
				per_page: 100,
				headers,
			});

			// HTTP 200 — fresh data
			const data = response.data
				.filter(r => r.tag_name?.startsWith('server-') && !r.prerelease && r.assets && r.assets.length > 0)
				.map(r => ({
					tag_name: r.tag_name,
					prerelease: r.prerelease
				}));

			return { status: 'data', data, etag: response.headers.etag };
		} catch (error: unknown) {
			// Octokit throws RequestError with status 304 for Not Modified
			if (this.isNotModifiedError(error)) {
				return { status: 'notModified' };
			}
			throw error;
		}
	}

	/** Creates an authenticated (or anonymous) Octokit instance. */
	private async createOctokit(githubToken?: string) {
		const { Octokit } = await import('@octokit/rest');
		return new Octokit({
			auth: githubToken,
			userAgent: 'RocketRide-VSCode'
		});
	}

	/**
	 * Checks if an error is an Octokit RequestError with HTTP 304 status.
	 * Octokit throws rather than returning a response for 304s.
	 * Duck-types the check to avoid importing @octokit/request-error.
	 */
	private isNotModifiedError(error: unknown): boolean {
		return (
			error instanceof Error &&
			'status' in error &&
			(error as { status: number }).status === 304
		);
	}

	/**
	 * Fetches a specific release based on version spec.
	 * - 'latest': newest non-prerelease with assets
	 * - 'prerelease': newest prerelease with assets
	 * - specific tag (e.g., 'server-3.2.0'): exact release by tag
	 */
	private async fetchRelease(
		versionSpec: string,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<ReleaseInfo> {
		this.throwIfCancelled(token);
		const octokit = await this.createOctokit(githubToken);

		if (versionSpec === 'latest') {
			const { data } = await octokit.repos.listReleases({
				owner: EngineInstaller.GITHUB_OWNER,
				repo: EngineInstaller.GITHUB_REPO,
				per_page: 20
			});
			const stable = data.find(r => r.tag_name.startsWith('server-') && !r.prerelease && r.assets && r.assets.length > 0);
			if (!stable) throw new Error('No stable server releases found on GitHub');
			return this.toReleaseInfo(stable);
		}

		if (versionSpec === 'prerelease') {
			const { data } = await octokit.repos.listReleases({
				owner: EngineInstaller.GITHUB_OWNER,
				repo: EngineInstaller.GITHUB_REPO,
				per_page: 20
			});
			const pre = data.find(r => r.tag_name.startsWith('server-') && r.prerelease && r.assets && r.assets.length > 0);
			if (!pre) throw new Error('No prerelease server releases found on GitHub');
			return this.toReleaseInfo(pre);
		}

		// Specific tag
		const { data } = await octokit.repos.getReleaseByTag({
			owner: EngineInstaller.GITHUB_OWNER,
			repo: EngineInstaller.GITHUB_REPO,
			tag: versionSpec
		});
		return this.toReleaseInfo(data);
	}

	/** Converts raw GitHub release data to our ReleaseInfo type. */
	private toReleaseInfo(release: { tag_name: string; published_at?: string | null; assets: Array<{ id: number; name: string; browser_download_url: string; size: number }> }): ReleaseInfo {
		if (!release.tag_name || !release.assets || release.assets.length === 0) {
			throw new Error(`Release ${release.tag_name} has no assets`);
		}
		return {
			tag_name: release.tag_name,
			published_at: release.published_at ?? '',
			assets: release.assets.map(a => ({
				id: a.id,
				name: a.name,
				browser_download_url: a.browser_download_url,
				size: a.size
			}))
		};
	}

	// =========================================================================
	// PLATFORM AND ASSET HELPERS
	// =========================================================================

	/** Returns platform-specific archive naming info. */
	private getPlatformInfo(): PlatformInfo {
		const platform = process.platform;
		const arch = process.arch;

		if (platform === 'win32') return { name: 'win64', ext: 'zip' };
		if (platform === 'darwin') {
			const darwinArch = arch === 'arm64' ? 'arm64' : 'x64';
			return { name: `darwin-${darwinArch}`, ext: 'tar.gz' };
		}
		if (platform === 'linux') return { name: 'linux-x64', ext: 'tar.gz' };

		throw new Error(`Unsupported platform: ${platform} ${arch}. Supported: Windows (x64), macOS (x64/ARM64), Linux (x64).`);
	}

	/** Finds the matching asset for this platform in a release. */
	private findPlatformAsset(release: ReleaseInfo): ReleaseAsset {
		const info = this.getPlatformInfo();
		const suffix = `-${info.name}.${info.ext}`;
		const asset = release.assets.find(a =>
			a.name.startsWith('rocketride-') && a.name.endsWith(suffix)
		);

		if (!asset) {
			const available = release.assets.map(a => a.name).join(', ');
			throw new Error(`No release asset found for this platform (expected: *${suffix}). Available: ${available}`);
		}

		return asset;
	}

	// =========================================================================
	// DOWNLOAD
	// =========================================================================

	/**
	 * Downloads a release asset with retry logic (up to 15 retries for
	 * 503/504 errors) and progress reporting.
	 */
	private async downloadAsset(
		asset: ReleaseAsset,
		destPath: string,
		displayVersion: string,
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<void> {
		const MAX_RETRIES = 15;
		const RETRY_DELAY_MS = 1000;

		const downloadUrl = await this.resolveAssetDownloadUrl(asset, githubToken);

		let response: http.IncomingMessage | undefined;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			this.throwIfCancelled(token);

			response = await this.httpStream(downloadUrl);

			if (!response) throw new Error('No response received');

			if (response.statusCode === 503 || response.statusCode === 504) {
				response.destroy();
				if (attempt < MAX_RETRIES) {
					progress?.report({ message: `Server error (${response.statusCode}), retrying... (${attempt}/${MAX_RETRIES})` });
					await this.delay(RETRY_DELAY_MS);
					continue;
				}
				throw new Error(`Download failed after ${MAX_RETRIES} retries: HTTP ${response.statusCode}`);
			}

			if (response.statusCode !== 200) {
				const statusCode = response.statusCode;
				response.destroy();
				if (statusCode === 403) throw new Error('GitHub API rate limit exceeded. Please try again later.');
				if (statusCode === 404) throw new Error(`Release asset not found: ${asset.name}`);
				throw new Error(`Download failed: HTTP ${statusCode}`);
			}

			break;
		}

		if (!response) throw new Error('No response received after retries');

		// Stream to disk with progress tracking
		const totalBytes = asset.size || parseInt(response.headers['content-length'] || '0', 10);
		let downloadedBytes = 0;
		let lastPercent = -1;

		const tmpDownloadPath = destPath + '.tmp';
		const file = fs.createWriteStream(tmpDownloadPath);

		try {
			await new Promise<void>((resolve, reject) => {
				const onCancel = () => {
					response!.destroy();
					file.close();
					reject(new vscode.CancellationError());
				};

				if (token?.isCancellationRequested) { onCancel(); return; }
				const cancelListener = token?.onCancellationRequested(onCancel);

				response!.on('data', (chunk: Buffer) => {
					downloadedBytes += chunk.length;
					if (totalBytes > 0) {
						const percent = Math.round((downloadedBytes / totalBytes) * 100);
						if (percent !== lastPercent) {
							lastPercent = percent;
							const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
							const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
							progress?.report({ message: `Downloading ${displayVersion}: ${percent}% (${mb}/${totalMb} MB)` });
						}
					}
				});

				response!.pipe(file);
				file.on('finish', () => { file.close(); response!.destroy(); cancelListener?.dispose(); resolve(); });
				file.on('error', (err) => { response!.destroy(); cancelListener?.dispose(); reject(err); });
				response!.on('error', (err) => { response!.destroy(); cancelListener?.dispose(); reject(err); });
			});

			// Verify download completeness
			if (totalBytes > 0) {
				const stat = fs.statSync(tmpDownloadPath);
				if (stat.size !== totalBytes) {
					throw new Error(`Download incomplete: expected ${totalBytes} bytes, got ${stat.size} bytes`);
				}
			}

			fs.renameSync(tmpDownloadPath, destPath);
		} catch (err) {
			try {
				file.close();
				if (fs.existsSync(tmpDownloadPath)) fs.unlinkSync(tmpDownloadPath);
			} catch { /* ignore cleanup errors */ }
			throw err;
		}
	}

	/** Resolves the actual download URL for a release asset (follows redirects). */
	private async resolveAssetDownloadUrl(asset: ReleaseAsset, githubToken?: string): Promise<string> {
		const octokit = await this.createOctokit(githubToken);

		const response = await octokit.request('GET /repos/{owner}/{repo}/releases/assets/{asset_id}', {
			owner: EngineInstaller.GITHUB_OWNER,
			repo: EngineInstaller.GITHUB_REPO,
			asset_id: asset.id,
			headers: { accept: 'application/octet-stream' },
			request: { redirect: 'manual' }
		});

		const location = (response as { headers: Record<string, string> }).headers?.location;
		if (location) return location;

		const url = (response as { url?: string }).url;
		if (url) return url;

		return asset.browser_download_url;
	}

	/** Extracts a .zip or .tar.gz archive into the destination directory. */
	private async extractArchive(archivePath: string, destDir: string): Promise<void> {
		if (archivePath.endsWith('.zip')) {
			const AdmZip = require('adm-zip');
			const zip = new AdmZip(archivePath);
			zip.extractAllTo(destDir, true);
		} else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
			const tar = require('tar');
			await tar.extract({ file: archivePath, cwd: destDir });
		} else {
			throw new Error(`Unsupported archive format: ${path.basename(archivePath)}`);
		}
	}

	/** Opens an HTTP(S) stream, following redirects. */
	private httpStream(url: string): Promise<http.IncomingMessage> {
		return new Promise((resolve, reject) => {
			const protocol = url.startsWith('https') ? https : http;
			const req = protocol.get(url, { headers: { 'User-Agent': 'RocketRide-VSCode' } }, (response) => {
				if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
					response.destroy();
					this.httpStream(response.headers.location).then(resolve, reject);
					return;
				}
				resolve(response);
			});
			req.on('error', reject);
		});
	}

	/** Throws CancellationError if the token has been cancelled. */
	private throwIfCancelled(token?: vscode.CancellationToken): void {
		if (token?.isCancellationRequested) throw new vscode.CancellationError();
	}

	/** Simple delay helper. */
	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	// =========================================================================
	// LINUX RUNTIME DEPENDENCY CHECK
	// =========================================================================

	private static readonly LIB_TO_PACKAGE: Record<string, string> = {
		'libc++.so.1': 'libc++1',
		'libc++abi.so.1': 'libc++abi1',
		'libgomp.so.1': 'libgomp1',
	};

	private async checkLinuxRuntimeDeps(exePath: string): Promise<void> {
		if (process.platform !== 'linux') return;

		let lddOutput = '';
		try {
			lddOutput = execFileSync('ldd', [exePath], { encoding: 'utf8' });
		} catch { return; }

		const packages = [...new Set(
			lddOutput.split('\n')
				.filter(l => l.includes('=> not found'))
				.map(l => l.trim().match(/^(\S+)/)?.[1])
				.map(lib => lib ? EngineInstaller.LIB_TO_PACKAGE[lib] : undefined)
				.filter((p): p is string => !!p),
		)];
		if (!packages.length) return;

		// One-click install assumes apt; on non-Debian distros show the list and let the user handle it.
		const hasApt = fs.existsSync('/usr/bin/apt') || fs.existsSync('/bin/apt');
		if (!hasApt) {
			void vscode.window.showWarningMessage(
				`RocketRide needs these system libraries: ${packages.join(', ')}. Install them with your system package manager.`,
				{ modal: true },
			);
			return;
		}

		const choice = await vscode.window.showWarningMessage(
			`RocketRide needs these system libraries: ${packages.join(', ')}.`,
			{ modal: true, detail: 'Without these libraries the engine cannot start.' },
			'Install',
		);
		if (choice !== 'Install') return;

		try {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Installing system libraries...', cancellable: false },
				() => new Promise<void>((resolve, reject) => {
					execFile('pkexec', ['apt', 'install', '-y', ...packages], { timeout: 5 * 60 * 1000 }, (err, _stdout, stderr) => {
						if (err) reject(new Error(stderr?.trim() || err.message));
						else resolve();
					});
				}),
			);
			void vscode.window.showInformationMessage('System libraries installed.');
		} catch (err) {
			void vscode.window.showErrorMessage(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

// =============================================================================
// UTILITY
// =============================================================================

/**
 * Checks if a process with the given PID is currently running.
 * Uses signal 0 which doesn't actually send a signal — just checks existence.
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
