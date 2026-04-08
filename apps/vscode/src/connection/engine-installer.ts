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

/**
 * engine-installer.ts - Engine Download and Installation
 *
 * Manages what is installed on disk: downloads engine releases from GitHub,
 * extracts them into versioned directories, and tracks installed versions.
 * Uses a cross-process lockfile so multiple VS Code windows can safely share
 * the same engines directory. No process management or connection state —
 * that belongs to EngineManager.
 *
 * Directory layout:
 *   <enginesRoot>/engines/
 *     install.lock                        — cross-process lockfile
 *     current-stable.json                 — pointer to active stable version dir
 *     current-pre.json                    — pointer to active prerelease version dir
 *     server-3.10.2--a1b2c3d4/            — versioned install dir
 *       engine.exe | engine
 *       ai/eaas.py
 *       engine-<pid>.pid                  — written by EngineManager per running process
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as lockfile from 'proper-lockfile';
import { getLogger } from '../shared/util/output';
import { icons } from '../shared/util/icons';

interface ReleaseAsset {
	id: number;
	name: string;
	browser_download_url: string;
	size: number;
}

interface ReleaseInfo {
	tag_name: string;
	published_at: string;
	assets: ReleaseAsset[];
}

export interface ReleaseListItem {
	tag_name: string;
	prerelease: boolean;
}

interface PlatformInfo {
	name: string;
	ext: string;
}

interface VersionPointer {
	tag: string;
	publishedAt: string;
	dir: string;
}

type Channel = 'stable' | 'pre';

export class EngineInstaller {
	private static readonly GITHUB_OWNER = 'rocketride-org';
	private static readonly GITHUB_REPO = 'rocketride-server';

	private readonly enginesRoot: string;
	private readonly logger = getLogger();

	constructor(enginesRoot: string) {
		this.enginesRoot = path.join(enginesRoot, 'engines');
	}

	// =========================================================================
	// Version directory helpers
	// =========================================================================

	private versionDirName(tag: string, publishedAt: string): string {
		const hash = crypto.createHash('sha256').update(publishedAt).digest('hex').substring(0, 8);
		return `${tag}--${hash}`;
	}

	private versionDirPath(tag: string, publishedAt: string): string {
		return path.join(this.enginesRoot, this.versionDirName(tag, publishedAt));
	}

	private executableName(): string {
		return process.platform === 'win32' ? 'engine.exe' : 'engine';
	}

	private executableInDir(dir: string): string {
		return path.join(dir, this.executableName());
	}

	private getChannel(versionSpec: string): Channel {
		return versionSpec === 'prerelease' ? 'pre' : 'stable';
	}

	// =========================================================================
	// Pointer files (current-stable.json / current-pre.json)
	// =========================================================================

	private pointerPath(channel: Channel): string {
		return path.join(this.enginesRoot, `current-${channel}.json`);
	}

	private readPointer(channel: Channel): VersionPointer | null {
		const p = this.pointerPath(channel);
		try {
			if (fs.existsSync(p)) {
				return JSON.parse(fs.readFileSync(p, 'utf8')) as VersionPointer;
			}
		} catch {
			// Corrupt pointer — treat as missing
		}
		return null;
	}

	private writePointer(channel: Channel, pointer: VersionPointer): void {
		const p = this.pointerPath(channel);
		const tmp = p + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(pointer, null, 2), 'utf8');
		fs.renameSync(tmp, p);
	}

	// =========================================================================
	// Lockfile path
	// =========================================================================

	private lockFilePath(): string {
		return path.join(this.enginesRoot, 'install.lock');
	}

	private ensureLockFileExists(): void {
		const p = this.lockFilePath();
		if (!fs.existsSync(p)) {
			fs.writeFileSync(p, '', 'utf8');
		}
	}

	// =========================================================================
	// Public API
	// =========================================================================

	/**
	 * Returns the path to the currently installed executable for the given channel,
	 * or null if nothing is installed.
	 */
	public getExecutablePath(channel?: Channel): string | null {
		const pointer = this.getLatestPointer(channel);
		if (!pointer) return null;
		const exe = this.executableInDir(path.join(this.enginesRoot, pointer.dir));
		return fs.existsSync(exe) ? exe : null;
	}

	/**
	 * Returns the directory path for the currently installed version.
	 */
	public getInstalledDir(channel?: Channel): string | null {
		const pointer = this.getLatestPointer(channel);
		if (!pointer) return null;
		return path.join(this.enginesRoot, pointer.dir);
	}

	public isInstalled(channel?: Channel): boolean {
		return this.getExecutablePath(channel) !== null;
	}

	public getInstalledVersion(channel?: Channel): string | null {
		return this.getLatestPointer(channel)?.tag ?? null;
	}

	public getInstalledPublishedAt(channel?: Channel): string | null {
		return this.getLatestPointer(channel)?.publishedAt ?? null;
	}

	/**
	 * Returns the pointer for the given channel. If no channel specified,
	 * falls back to stable then pre.
	 */
	private getLatestPointer(channel?: Channel): VersionPointer | null {
		if (channel) {
			return this.readPointer(channel);
		}
		return this.readPointer('stable') ?? this.readPointer('pre') ?? null;
	}

	/**
	 * Removes all engine directories and pointer files.
	 * Uses the same cross-process lock as install() to prevent races.
	 */
	public async uninstall(): Promise<void> {
		this.ensureLockFileExists();
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(this.lockFilePath(), {
				stale: 120000,
				retries: { retries: 5, minTimeout: 1000, maxTimeout: 3000 }
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to acquire engine lock for uninstall: ${msg}`);
		}
		try {
			if (fs.existsSync(this.enginesRoot)) {
				fs.rmSync(this.enginesRoot, { recursive: true, force: true });
				this.logger.output(`${icons.info} All engines uninstalled from ${this.enginesRoot}`);
			}
		} finally {
			try { await release(); } catch { /* ignore stale lock */ }
		}
	}

	/**
	 * Ensures the engine is installed at the requested version. Downloads if needed.
	 * Uses a cross-process lockfile so multiple VS Code windows coordinate safely.
	 * Returns the path to the engine executable.
	 */
	public async install(
		versionSpec: string = 'latest',
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<string> {
		const displaySpec = versionSpec.replace(/^server-/, '');
		const channel = this.getChannel(versionSpec);
		this.logger.output(`${icons.info} Engine version requested: ${displaySpec} (channel: ${channel})`);

		// Ensure engines root directory exists
		fs.mkdirSync(this.enginesRoot, { recursive: true });
		this.ensureLockFileExists();

		// Acquire cross-process lock (blocking — waits for other windows)
		progress?.report({ message: 'Waiting for engine lock...' });
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(this.lockFilePath(), {
				stale: 120000,
				retries: {
					retries: 30,
					minTimeout: 2000,
					maxTimeout: 5000,
				}
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to acquire engine install lock: ${msg}`);
		}

		try {
			return await this.installUnderLock(versionSpec, channel, progress, token, githubToken);
		} finally {
			try {
				await release();
			} catch {
				// Ignore unlock errors (stale lock already cleaned)
			}
		}
	}

	/**
	 * Runs inside the lockfile — checks for updates, downloads if needed.
	 */
	private async installUnderLock(
		versionSpec: string,
		channel: Channel,
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<string> {
		const displaySpec = versionSpec.replace(/^server-/, '');
		const pointer = this.readPointer(channel);

		if (versionSpec === 'latest' || versionSpec === 'prerelease') {
			// Check GitHub for the latest release in this channel
			let release: ReleaseInfo;
			try {
				progress?.report({ message: 'Checking for updates...' });
				release = await this.fetchRelease(versionSpec, token, githubToken);
			} catch {
				// GitHub unreachable — use what we have if anything is installed
				if (pointer) {
					const exe = this.executableInDir(path.join(this.enginesRoot, pointer.dir));
					if (fs.existsSync(exe)) {
						this.logger.output(`${icons.info} Could not check for updates, using installed version`);
						return exe;
					}
				}
				throw new Error(`No engine installed and cannot reach GitHub to download ${displaySpec}`);
			}

			// Compute target directory
			const targetDir = this.versionDirName(release.tag_name, release.published_at);
			const targetDirPath = path.join(this.enginesRoot, targetDir);
			const targetExe = this.executableInDir(targetDirPath);

			// Already installed? (another window may have done it while we waited for the lock)
			if (fs.existsSync(targetExe)) {
				const displayTag = release.tag_name.replace(/^server-/, '');
				this.logger.output(`${icons.success} Engine ${displayTag} already installed`);
				this.writePointer(channel, { tag: release.tag_name, publishedAt: release.published_at, dir: targetDir });
				return targetExe;
			}

			// Need to download
			return this.downloadAndInstall(release, targetDir, targetDirPath, channel, progress, token, githubToken);
		}

		// Specific tag requested
		if (pointer && pointer.tag === versionSpec) {
			const exe = this.executableInDir(path.join(this.enginesRoot, pointer.dir));
			if (fs.existsSync(exe)) {
				this.logger.output(`${icons.success} Installed version matches, skipping download`);
				return exe;
			}
		}

		// Need to fetch and install the specific version
		progress?.report({ message: `Fetching ${displaySpec}...` });
		const release = await this.fetchRelease(versionSpec, token, githubToken);
		const targetDir = this.versionDirName(release.tag_name, release.published_at);
		const targetDirPath = path.join(this.enginesRoot, targetDir);
		const targetExe = this.executableInDir(targetDirPath);

		if (fs.existsSync(targetExe)) {
			this.logger.output(`${icons.success} Engine ${displaySpec} already installed`);
			this.writePointer(channel, { tag: release.tag_name, publishedAt: release.published_at, dir: targetDir });
			return targetExe;
		}

		return this.downloadAndInstall(release, targetDir, targetDirPath, channel, progress, token, githubToken);
	}

	// =========================================================================
	// Cleanup
	// =========================================================================

	/**
	 * Removes old version directories that are not in use.
	 * Acquires the installer lock to prevent races with concurrent installs.
	 * Preserves directories referenced by channel pointers and those with
	 * live engine processes. Catches file-lock errors on Windows.
	 */
	public async cleanupOldVersions(keepDir: string): Promise<void> {
		this.ensureLockFileExists();
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(this.lockFilePath(), {
				stale: 300_000,
				retries: { retries: 3, minTimeout: 500, maxTimeout: 3000 },
			});
		} catch {
			// Could not acquire lock — skip cleanup to avoid races
			this.logger.output(`${icons.info} Skipping cleanup: could not acquire installer lock`);
			return;
		}

		try {
			const keepDirs = new Set<string>();
			keepDirs.add(path.basename(keepDir));

			// Preserve directories referenced by channel pointers
			for (const channel of ['stable', 'pre'] as const) {
				const pointer = this.readPointer(channel);
				if (pointer?.dir) {
					keepDirs.add(pointer.dir);
				}
			}

			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(this.enginesRoot, { withFileTypes: true });
			} catch {
				return; // Directory doesn't exist or isn't readable
			}

			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (keepDirs.has(entry.name)) continue;

				// Only consider directories that look like version dirs (contain --)
				if (!entry.name.includes('--')) continue;

				const dirPath = path.join(this.enginesRoot, entry.name);

				// Check for live engine processes via PID files
				if (this.hasLiveProcesses(dirPath)) {
					this.logger.output(`${icons.info} Skipping cleanup of ${entry.name} (engine running)`);
					continue;
				}

				try {
					fs.rmSync(dirPath, { recursive: true, force: true });
					this.logger.output(`${icons.info} Cleaned up old engine version: ${entry.name}`);
				} catch (err: unknown) {
					// EBUSY/EPERM on Windows when binary is locked
					const code = (err as { code?: string }).code;
					if (code === 'EBUSY' || code === 'EPERM') {
						this.logger.output(`${icons.info} Skipping cleanup of ${entry.name} (file locked)`);
					} else {
						this.logger.output(`${icons.warning} Failed to clean up ${entry.name}: ${err}`);
					}
				}
			}
		} finally {
			if (release) {
				await release();
			}
		}
	}

	/**
	 * Checks if any engine-*.pid files in the directory reference a live process.
	 */
	private hasLiveProcesses(dir: string): boolean {
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			return false;
		}

		for (const file of files) {
			if (!file.startsWith('engine-') || !file.endsWith('.pid')) continue;

			try {
				const pidStr = fs.readFileSync(path.join(dir, file), 'utf8').trim();
				const pid = parseInt(pidStr, 10);
				if (!isNaN(pid) && isPidAlive(pid)) {
					return true;
				}
			} catch {
				// Can't read PID file — skip it
			}
		}

		return false;
	}

	// =========================================================================
	// Download and extract
	// =========================================================================

	private async downloadAndInstall(
		release: ReleaseInfo,
		targetDir: string,
		targetDirPath: string,
		channel: Channel,
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

			// Extract into the versioned directory
			fs.mkdirSync(targetDirPath, { recursive: true });

			progress?.report({ message: 'Extracting server...' });
			await this.extractArchive(tmpPath, targetDirPath);

			// Set executable permissions on Unix
			const exePath = this.executableInDir(targetDirPath);
			if (process.platform !== 'win32' && fs.existsSync(exePath)) {
				fs.chmodSync(exePath, 0o755);
			}

			// Verify the executable exists after extraction
			if (!fs.existsSync(exePath)) {
				// Clean up failed extraction
				fs.rmSync(targetDirPath, { recursive: true, force: true });
				throw new Error(
					`Engine extraction completed but executable not found at expected path: ${exePath}`
				);
			}

			// Update the channel pointer
			this.writePointer(channel, { tag: release.tag_name, publishedAt: release.published_at, dir: targetDir });

			this.logger.output(`${icons.success} Server ${release.tag_name} installed at ${targetDirPath}`);
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

	// =========================================================================
	// GitHub API
	// =========================================================================

	/**
	 * Fetches all available releases for the version dropdown.
	 * Returns only release (non-prerelease) versions that have assets, sorted newest first.
	 */
	public async getReleases(
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<ReleaseListItem[]> {
		this.throwIfCancelled(token);
		const octokit = await this.createOctokit(githubToken);
		const { data } = await octokit.repos.listReleases({
			owner: EngineInstaller.GITHUB_OWNER,
			repo: EngineInstaller.GITHUB_REPO,
			per_page: 100
		});
		return data
			.filter(r => r.tag_name?.startsWith('server-') && !r.prerelease && r.assets && r.assets.length > 0)
			.map(r => ({
				tag_name: r.tag_name,
				prerelease: r.prerelease
			}));
	}

	private async createOctokit(githubToken?: string) {
		const { Octokit } = await import('@octokit/rest');
		return new Octokit({
			auth: githubToken,
			userAgent: 'RocketRide-VSCode'
		});
	}

	/**
	 * Fetches a specific release based on version spec.
	 * - 'latest': newest non-prerelease with assets
	 * - 'prerelease': newest release (including prereleases)
	 * - specific tag (e.g. 'server-v3.1.1'): exact release by tag
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
			if (!stable) {
				throw new Error('No stable server releases found on GitHub');
			}
			return this.toReleaseInfo(stable);
		}

		if (versionSpec === 'prerelease') {
			const { data } = await octokit.repos.listReleases({
				owner: EngineInstaller.GITHUB_OWNER,
				repo: EngineInstaller.GITHUB_REPO,
				per_page: 20
			});
			const pre = data.find(r => r.tag_name.startsWith('server-') && r.prerelease && r.assets && r.assets.length > 0);
			if (!pre) {
				throw new Error('No prerelease server releases found on GitHub');
			}
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
	// Platform and asset helpers
	// =========================================================================

	private getPlatformInfo(): PlatformInfo {
		const platform = process.platform;
		const arch = process.arch;

		if (platform === 'win32') {
			return { name: 'win64', ext: 'zip' };
		} else if (platform === 'darwin') {
			const darwinArch = arch === 'arm64' ? 'arm64' : 'x64';
			return { name: `darwin-${darwinArch}`, ext: 'tar.gz' };
		} else if (platform === 'linux') {
			return { name: 'linux-x64', ext: 'tar.gz' };
		}

		throw new Error(`Unsupported platform: ${platform} ${arch}. Supported: Windows (x64), macOS (x64/ARM64), Linux (x64).`);
	}

	private findPlatformAsset(release: ReleaseInfo): ReleaseAsset {
		const info = this.getPlatformInfo();
		const suffix = `-${info.name}.${info.ext}`;
		const asset = release.assets.find(a =>
			a.name.startsWith('rocketride-') && a.name.endsWith(suffix)
		);

		if (!asset) {
			const available = release.assets.map(a => a.name).join(', ');
			throw new Error(
				`No release asset found for this platform (expected: *${suffix}). Available: ${available}`
			);
		}

		return asset;
	}

	// =========================================================================
	// Download (unchanged from original)
	// =========================================================================

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

			if (!response) {
				throw new Error('No response received');
			}

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

				if (statusCode === 403) {
					throw new Error('GitHub API rate limit exceeded. Please try again later.');
				}
				if (statusCode === 404) {
					throw new Error(`Release asset not found: ${asset.name}`);
				}
				throw new Error(`Download failed: HTTP ${statusCode}`);
			}

			break;
		}

		if (!response) {
			throw new Error('No response received after retries');
		}

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

				if (token?.isCancellationRequested) {
					onCancel();
					return;
				}
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

				file.on('finish', () => {
					file.close();
					response!.destroy();
					cancelListener?.dispose();
					resolve();
				});

				file.on('error', (err) => {
					response!.destroy();
					cancelListener?.dispose();
					reject(err);
				});

				response!.on('error', (err) => {
					response!.destroy();
					cancelListener?.dispose();
					reject(err);
				});
			});

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
				if (fs.existsSync(tmpDownloadPath)) {
					fs.unlinkSync(tmpDownloadPath);
				}
			} catch {
				// Ignore cleanup errors
			}
			throw err;
		}
	}

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
		if (location) {
			return location;
		}

		const url = (response as { url?: string }).url;
		if (url) {
			return url;
		}

		return asset.browser_download_url;
	}

	private async extractArchive(archivePath: string, destDir: string): Promise<void> {
		if (archivePath.endsWith('.zip')) {
			const AdmZip = require('adm-zip');
			const zip = new AdmZip(archivePath);
			zip.extractAllTo(destDir, true);
		} else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
			const tar = require('tar');
			await tar.extract({
				file: archivePath,
				cwd: destDir
			});
		} else {
			throw new Error(`Unsupported archive format: ${path.basename(archivePath)}`);
		}
	}

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

	private throwIfCancelled(token?: vscode.CancellationToken): void {
		if (token?.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}

// =========================================================================
// Utility: cross-platform PID liveness check
// =========================================================================

/**
 * Checks if a process with the given PID is currently running.
 * Uses signal 0 which doesn't actually send a signal — just checks existence.
 * Works on Windows, macOS, and Linux in Node.js.
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
