// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide, Inc.
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
 * extracts them into the extension directory, and tracks installed versions.
 * No process management or connection state — that belongs to EngineManager.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
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

export class EngineInstaller {
	private static readonly GITHUB_OWNER = 'rocketride-org';
	private static readonly GITHUB_REPO = 'rocketride-server';

	private readonly engineDir: string;
	private readonly logger = getLogger();

	constructor(extensionPath: string) {
		this.engineDir = path.join(extensionPath, 'engine');
	}

	public getExecutablePath(): string {
		const exe = process.platform === 'win32' ? 'engine.exe' : 'engine';
		return path.join(this.engineDir, exe);
	}

	public isInstalled(): boolean {
		return fs.existsSync(this.getExecutablePath());
	}

	/**
	 * Removes the engine directory and all installed files.
	 */
	public uninstall(): void {
		if (fs.existsSync(this.engineDir)) {
			fs.rmSync(this.engineDir, { recursive: true, force: true });
			this.logger.output(`${icons.info} Engine uninstalled from ${this.engineDir}`);
		}
	}

	/**
	 * Ensures the engine is installed at the requested version. Downloads if needed.
	 * Returns the path to the engine executable.
	 *
	 * The caller is responsible for ensuring only one call is active at a time.
	 */
	public async install(
		versionSpec: string = 'latest',
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<string> {
		const displaySpec = versionSpec.replace(/^server-/, '');
		this.logger.output(`${icons.info} Engine version requested: ${displaySpec}`);

		if (this.isInstalled()) {
			const installed = this.getInstalledVersion();
			const displayInstalled = installed?.replace(/^server-/, '') ?? 'unknown';
			this.logger.output(`${icons.info} Engine installed: ${displayInstalled}`);
			if (versionSpec === 'latest' || versionSpec === 'prerelease') {
				// Check GitHub for a newer version
				try {
					const release = await this.fetchRelease(versionSpec, token, githubToken);
					const installedPublishedAt = this.getInstalledPublishedAt();
					if (installed === release.tag_name && installedPublishedAt === release.published_at) {
						this.logger.output(`${icons.success} Installed version is up to date`);
						return this.getExecutablePath();
					}
					const displayNew = release.tag_name.replace(/^server-/, '');
					this.logger.output(`${icons.info} Update available: ${displayNew} (published ${release.published_at}), updating...`);
					// Fall through to download
				} catch {
					// GitHub unreachable — use what we have
					this.logger.output(`${icons.info} Could not check for updates, using installed version`);
					return this.getExecutablePath();
				}
			} else {
				// Specific version: only reuse if it matches
				if (installed === versionSpec) {
					this.logger.output(`${icons.success} Installed version matches, skipping download`);
					return this.getExecutablePath();
				}
				this.logger.output(`${icons.info} Version mismatch, downloading ${displaySpec}...`);
				// Different version requested — fall through to download
			}
		} else {
			this.logger.output(`${icons.info} No engine installed, downloading ${displaySpec}...`);
		}

		return this.downloadAndInstall(versionSpec, progress, token, githubToken);
	}

	public getInstalledVersion(): string | null {
		const versionFile = path.join(this.engineDir, '.version');
		if (fs.existsSync(versionFile)) {
			return fs.readFileSync(versionFile, 'utf8').trim();
		}
		return null;
	}

	public getInstalledPublishedAt(): string | null {
		const file = path.join(this.engineDir, '.published_at');
		if (fs.existsSync(file)) {
			return fs.readFileSync(file, 'utf8').trim();
		}
		return null;
	}

	private writeInstalledVersion(tagName: string, publishedAt: string): void {
		fs.writeFileSync(path.join(this.engineDir, '.version'), tagName, 'utf8');
		fs.writeFileSync(path.join(this.engineDir, '.published_at'), publishedAt, 'utf8');
	}

	private async createOctokit(githubToken?: string) {
		const { Octokit } = await import('@octokit/rest');
		return new Octokit({
			auth: githubToken,
			userAgent: 'RocketRide-VSCode'
		});
	}

	private async downloadAndInstall(
		versionSpec: string,
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<string> {
		// Fetch release info from GitHub
		progress?.report({ message: 'Fetching release info...' });
		const release = await this.fetchRelease(versionSpec, token, githubToken);
		const displayVersion = release.tag_name.replace(/^server-/, '');

		// Find the correct asset for this platform
		const asset = this.findPlatformAsset(release);
		this.logger.output(`${icons.info} Found release ${displayVersion}: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);

		// Download to a temp file
		const tmpPath = path.join(os.tmpdir(), `rocketride-engine-${Date.now()}${asset.name.endsWith('.zip') ? '.zip' : '.tar.gz'}`);

		try {
			progress?.report({ message: `Downloading ${displayVersion}...` });
			await this.downloadAsset(asset, tmpPath, displayVersion, progress, token, githubToken);

			// Check cancellation before wiping the existing engine
			this.throwIfCancelled(token);

			// Clean up existing engine dir if partial install exists
			if (fs.existsSync(this.engineDir)) {
				fs.rmSync(this.engineDir, { recursive: true, force: true });
			}
			fs.mkdirSync(this.engineDir, { recursive: true });

			// Extract
			progress?.report({ message: 'Extracting server...' });
			await this.extractArchive(tmpPath, this.engineDir);

			// Patch legacy apaext_ command prefixes to rrext_ in downloaded engine
			this.patchEngineCommandNames(this.engineDir);

			// Set executable permissions on Unix
			await this.setExecutablePermission();

			// Verify the executable exists after extraction
			if (!this.isInstalled()) {
				throw new Error(
					`Engine extraction completed but executable not found at expected path: ${this.getExecutablePath()}`
				);
			}

			this.writeInstalledVersion(release.tag_name, release.published_at);
			this.logger.output(`${icons.success} Server ${release.tag_name} installed at ${this.engineDir}`);
			progress?.report({ message: 'Server ready!' });

			return this.getExecutablePath();
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
	 * Fetches all available releases for the version dropdown.
	 * Returns releases that have assets, sorted newest first.
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
			.filter(r => r.tag_name?.startsWith('server-') && r.assets && r.assets.length > 0)
			.map(r => ({
				tag_name: r.tag_name,
				prerelease: r.prerelease
			}));
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
			const pre = data.find(r => r.tag_name.startsWith('server-') && r.assets && r.assets.length > 0);
			if (!pre) {
				throw new Error('No server releases found on GitHub');
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
		// Match by platform suffix (e.g. "-win64.zip", "-darwin-arm64.tar.gz")
		// to handle cases where the asset version doesn't match the tag exactly.
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

	/**
	 * Downloads a release asset using the Octokit API to resolve the CDN URL,
	 * then streams the binary with progress tracking via Node.js https.
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

		// Use Octokit to get the CDN download URL (follows the API redirect for us)
		const downloadUrl = await this.resolveAssetDownloadUrl(asset, githubToken);

		let response: http.IncomingMessage | undefined;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			this.throwIfCancelled(token);

			// Stream from CDN URL (no auth needed — Octokit already resolved the redirect)
			response = await this.httpStream(downloadUrl);

			if (!response) {
				throw new Error('No response received');
			}

			// Retry on 503/504
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

			// Success
			break;
		}

		if (!response) {
			throw new Error('No response received after retries');
		}

		// Stream response to file with progress tracking
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

			// Verify download size
			if (totalBytes > 0) {
				const stat = fs.statSync(tmpDownloadPath);
				if (stat.size !== totalBytes) {
					throw new Error(`Download incomplete: expected ${totalBytes} bytes, got ${stat.size} bytes`);
				}
			}

			// Rename from .tmp to final path
			fs.renameSync(tmpDownloadPath, destPath);
		} catch (err) {
			// Clean up partial download
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

	/**
	 * Uses Octokit to resolve the CDN download URL for a release asset.
	 * The GitHub API responds with a 302 redirect to the CDN; Octokit's
	 * getReleaseAsset with octet-stream Accept follows it and returns
	 * the final URL we can stream from.
	 */
	private async resolveAssetDownloadUrl(asset: ReleaseAsset, githubToken?: string): Promise<string> {
		const octokit = await this.createOctokit(githubToken);

		// Request the asset with octet-stream Accept and redirect: 'manual' so
		// we capture the CDN Location header instead of downloading the whole file.
		const response = await octokit.request('GET /repos/{owner}/{repo}/releases/assets/{asset_id}', {
			owner: EngineInstaller.GITHUB_OWNER,
			repo: EngineInstaller.GITHUB_REPO,
			asset_id: asset.id,
			headers: { accept: 'application/octet-stream' },
			request: { redirect: 'manual' }
		});

		// When redirect is manual, Octokit returns a 302 with the Location header
		const location = (response as { headers: Record<string, string> }).headers?.location;
		if (location) {
			return location;
		}

		// If Octokit followed the redirect anyway (some versions do), check the url property
		const url = (response as { url?: string }).url;
		if (url) {
			return url;
		}

		// Fallback to the browser download URL
		return asset.browser_download_url;
	}

	private patchEngineCommandNames(dir: string): void {
		const walkAndPatch = (currentDir: string) => {
			if (!fs.existsSync(currentDir)) {
				return;
			}
			for (const entry of fs.readdirSync(currentDir)) {
				const fullPath = path.join(currentDir, entry);
				const stat = fs.statSync(fullPath);
				if (stat.isDirectory()) {
					walkAndPatch(fullPath);
				} else if (entry.endsWith('.py')) {
					const original = fs.readFileSync(fullPath, 'utf8');
					const patched = original.replace(/apaext_/g, 'rrext_');
					if (patched !== original) {
						fs.writeFileSync(fullPath, patched, 'utf8');
						this.logger.output(`${icons.info} Patched command prefixes in ${entry}`);
					}
				}
			}
		};
		walkAndPatch(dir);
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

	private async setExecutablePermission(): Promise<void> {
		if (process.platform === 'win32') {
			return;
		}

		const execPath = this.getExecutablePath();
		if (fs.existsSync(execPath)) {
			fs.chmodSync(execPath, 0o755);
		}
	}

	/**
	 * Opens a streaming HTTP(S) GET connection. Used for binary asset downloads
	 * where we need progress tracking (Octokit buffers entire responses in memory).
	 */
	private httpStream(url: string): Promise<http.IncomingMessage> {
		return new Promise((resolve, reject) => {
			const protocol = url.startsWith('https') ? https : http;
			const req = protocol.get(url, { headers: { 'User-Agent': 'RocketRide-VSCode' } }, (response) => {
				// Follow redirects (CDN may redirect once more)
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
