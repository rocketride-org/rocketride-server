/**
 * Runtime binary downloader.
 *
 * Downloads release assets from GitHub and extracts them to
 * ~/.rocketride/runtimes/{version}/.
 */

import { createWriteStream, existsSync, chmodSync, mkdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { randomBytes } from 'crypto';
import { RuntimeNotFoundError } from '../exceptions/index.js';
import { runtimesDir, runtimeBinary, ensureDirs } from './paths.js';
import { assetName, releaseTag } from './platform.js';

const GITHUB_DOWNLOAD = 'https://github.com/rocketride-org/rocketride-server/releases/download';

export interface DownloadCallbacks {
	onProgress?: (downloaded: number, total: number) => void;
	onPhase?: (phase: 'downloading' | 'extracting' | 'done') => void;
}

export async function downloadRuntime(version: string, callbacks?: DownloadCallbacks): Promise<string> {
	const binary = runtimeBinary(version);
	if (existsSync(binary)) return binary;

	ensureDirs();

	const asset = assetName(version);
	const tag = releaseTag(version);
	const url = `${GITHUB_DOWNLOAD}/${tag}/${asset}`;

	const ext = asset.endsWith('.zip') ? '.zip' : '.tar.gz';
	const tmpPath = join(tmpdir(), `rr-${randomBytes(8).toString('hex')}${ext}`);

	try {
		// Download
		const resp = await fetch(url, { redirect: 'follow' });

		if (resp.status === 404) {
			throw new RuntimeNotFoundError(`Runtime v${version} not found.\n` + `  No release asset matching "${asset}" exists under GitHub release "${tag}".\n` + `  This usually means the version does not exist or has no binary for your platform.\n` + `  Run "rocketride runtime install latest" to install the latest stable release,\n` + `  or check available versions at:\n` + `  https://github.com/rocketride-org/rocketride-server/releases`);
		}
		if (!resp.ok) {
			throw new RuntimeNotFoundError(`Failed to download runtime v${version}: HTTP ${resp.status} from ${url}`);
		}

		const total = parseInt(resp.headers.get('content-length') ?? '0', 10) || 0;
		callbacks?.onPhase?.('downloading');

		// Stream to temp file with progress tracking
		let downloaded = 0;
		const body = resp.body;
		if (!body) throw new RuntimeNotFoundError('Empty response body');

		const reader = body.getReader();
		let lastProgressTime = 0;
		const nodeStream = new Readable({
			async read() {
				const { done, value } = await reader.read();
				if (done) {
					callbacks?.onProgress?.(downloaded, total);
					this.push(null);
					return;
				}
				downloaded += value.byteLength;
				const now = Date.now();
				if (now - lastProgressTime >= 100) {
					lastProgressTime = now;
					callbacks?.onProgress?.(downloaded, total);
				}
				this.push(Buffer.from(value));
			},
		});

		await pipeline(nodeStream, createWriteStream(tmpPath));

		// Extract
		callbacks?.onPhase?.('extracting');
		const dest = runtimesDir(version);
		mkdirSync(dest, { recursive: true });

		if (asset.endsWith('.tar.gz')) {
			const tar = await import('tar');
			await tar.extract({ file: tmpPath, cwd: dest });
		} else if (asset.endsWith('.zip')) {
			// Use PowerShell on Windows for zip extraction
			const { execSync } = await import('child_process');
			execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${tmpPath}' -DestinationPath '${dest}' -Force"`, { windowsHide: true });
		}

		// Set executable on Unix
		if (process.platform !== 'win32' && existsSync(binary)) {
			chmodSync(binary, 0o755);
		}

		if (!existsSync(binary)) {
			throw new RuntimeNotFoundError(`Downloaded and extracted v${version} but binary not found at ${binary}. Check the release asset structure.`);
		}

		callbacks?.onPhase?.('done');
		return binary;
	} finally {
		try {
			unlinkSync(tmpPath);
		} catch {
			/* already cleaned or never created */
		}
	}
}
