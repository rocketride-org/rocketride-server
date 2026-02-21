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
 * engine-installer.ts - Automatic Engine Download and Installation
 *
 * Downloads the latest engine release from GitHub, extracts it into the
 * extension directory, and manages the engine binary lifecycle.
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
	assets: ReleaseAsset[];
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
	private installPromise: Promise<string> | null = null;

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
	 * Ensures the engine is installed. Downloads if needed.
	 * Returns the path to the engine executable.
	 * Uses a concurrency guard to prevent parallel downloads.
	 */
	public async ensureEngine(
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<string> {
		if (this.isInstalled()) {
			return this.getExecutablePath();
		}

		// Concurrency guard: reuse in-flight install
		if (this.installPromise) {
			return this.installPromise;
		}

		this.installPromise = this.downloadAndInstall(progress, token, githubToken).finally(() => {
			this.installPromise = null;
		});

		return this.installPromise;
	}

	private async createOctokit(githubToken?: string) {
		const { Octokit } = await import('@octokit/rest');
		return new Octokit({
			auth: githubToken,
			userAgent: 'RocketRide-VSCode'
		});
	}

	private async downloadAndInstall(
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
		token?: vscode.CancellationToken,
		githubToken?: string
	): Promise<string> {
		this.logger.output(`${icons.info} Server not found locally, downloading...`);

		// Fetch latest release info from GitHub
		progress?.report({ message: 'Fetching latest release info...' });
		const release = await this.fetchLatestRelease(token, githubToken);

		// Find the correct asset for this platform
		const asset = this.findPlatformAsset(release);
		this.logger.output(`${icons.info} Found release ${release.tag_name}: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);

		// Download to a temp file
		const tmpPath = path.join(os.tmpdir(), `rocketride-engine-${Date.now()}${asset.name.endsWith('.zip') ? '.zip' : '.tar.gz'}`);

		try {
			progress?.report({ message: `Downloading ${asset.name}...` });
			await this.downloadAsset(asset, tmpPath, progress, token, githubToken);

			// Clean up existing engine dir if partial install exists
			if (fs.existsSync(this.engineDir)) {
				fs.rmSync(this.engineDir, { recursive: true, force: true });
			}
			fs.mkdirSync(this.engineDir, { recursive: true });

			// Extract
			progress?.report({ message: 'Extracting server...' });
			await this.extractArchive(tmpPath, this.engineDir);

			// Set executable permissions on Unix
			await this.setExecutablePermission();

			// Verify the executable exists after extraction
			if (!this.isInstalled()) {
				throw new Error(
					`Engine extraction completed but executable not found at expected path: ${this.getExecutablePath()}`
				);
			}

			this.logger.output(`${icons.success} Server installed at ${this.engineDir}`);
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

	private async fetchLatestRelease(token?: vscode.CancellationToken, githubToken?: string): Promise<ReleaseInfo> {
		this.throwIfCancelled(token);

		const octokit = await this.createOctokit(githubToken);
		const { data } = await octokit.repos.listReleases({
			owner: EngineInstaller.GITHUB_OWNER,
			repo: EngineInstaller.GITHUB_REPO,
			per_page: 1
		});

		if (data.length === 0) {
			throw new Error('No releases found on GitHub');
		}

		const release = data[0];
		if (!release.tag_name || !release.assets || release.assets.length === 0) {
			throw new Error(`Release ${release.tag_name} has no assets`);
		}

		return {
			tag_name: release.tag_name,
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

	private getPlatformAssetName(tagName: string): string {
		const info = this.getPlatformInfo();
		return `rocketride-${tagName}-${info.name}.${info.ext}`;
	}

	private findPlatformAsset(release: ReleaseInfo): ReleaseAsset {
		const expectedName = this.getPlatformAssetName(release.tag_name);
		const asset = release.assets.find(a => a.name === expectedName);

		if (!asset) {
			const available = release.assets.map(a => a.name).join(', ');
			throw new Error(
				`No release asset found for this platform (expected: ${expectedName}). Available: ${available}`
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
							progress?.report({ message: `Downloading: ${percent}% (${mb}/${totalMb} MB)` });
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
