/**
 * Shared Download Utilities
 *
 * Downloads are cached in the `downloads/` directory at project root.
 * This directory persists across `builder clean` commands.
 *
 * Usage:
 *   const archivePath = await downloadFile(url, 'jdk-17.zip', task);
 *   await extractArchive(archivePath, destDir, { stripLevels: 1 });
 */
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');
const tar = require('tar');
const { exists, rm, mkdir, unlink, isFile, isDirectory, createWriteStream, writeFile, readJson } = require('./fs');
const { getState, setState } = require('./state');

// Persistent downloads directory (survives clean)
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DOWNLOADS_DIR = path.join(PROJECT_ROOT, 'downloads');

// Get package info (loaded async)
let VERSION = '0.0.0';
let REPO = 'rocketride-org/rocketride-server';
let packageJsonLoaded = false;

const TODAY = new Date().toISOString().slice(0, 10).replace(/-/g, '.'); // yyyy.MM.dd

/** How long a force-pushed tag's assets are reused before being re-fetched */
const PRERELEASE_TTL_MS = 60 * 60 * 1000;

/**
 * Read the version and repository from the root package.json
 *
 * The file is read once; later calls reuse the values.
 *
 * @returns {Promise<{version: string, repo: string}>} Project version and GitHub `owner/name`
 */
async function loadPackageJson() {
	if (!packageJsonLoaded) {
		const packageJson = await readJson(path.join(PROJECT_ROOT, 'package.json'));
		VERSION = packageJson.version;
		REPO =
			packageJson.repository?.url?.match(/github\.com[/:](.+?)(?:\.git)?$/)?.[1] ||
			'rocketride-org/rocketride-server';
		packageJsonLoaded = true;
	}
	return { version: VERSION, repo: REPO };
}

// How long a request may stay silent (no response, no body data) before it is aborted
// as ETIMEDOUT, so a host that accepts the connection but never answers is retried
// and, in downloadFileFrom, left for the next URL.
const REQUEST_IDLE_TIMEOUT_MS = 60_000;

// Connection failures before any response that are worth another try: the host
// did not answer, reset the connection, or name resolution failed for a moment.
const RETRYABLE_NETWORK_CODES = new Set([
	'ETIMEDOUT',
	'ECONNRESET',
	'ECONNREFUSED',
	'EAI_AGAIN',
	'ENETUNREACH',
	'EHOSTUNREACH',
	'EPIPE',
]);

/**
 * Error code of a failed connection
 *
 * Node reports a connect that tried several addresses as an AggregateError, whose
 * own code can be missing; the code of its first inner error is used then.
 *
 * @param {Error} err - The connection error
 * @returns {string|undefined} The error code, if any
 */
function networkErrorCode(err) {
	return err?.code ?? err?.errors?.find((inner) => inner?.code)?.code;
}

/**
 * Download a file (with caching)
 *
 * Checks state.json downloads[filename] - if true, returns cached path.
 * Otherwise downloads the file, marks it in state, and returns path.
 *
 * @param {string} url - URL to download from
 * @param {string} filename - Filename to save as (used as cache key)
 * @param {Object} task - Optional Listr2 task for progress output
 * @returns {Promise<string>} Full path to the downloaded file
 */
async function downloadFile(url, filename, task) {
	const destPath = path.join(DOWNLOADS_DIR, filename);
	const stateKey = ['downloads', url];

	// Check if already downloaded (atomic read)
	if ((await getState(stateKey)) && (await exists(destPath))) {
		return destPath;
	}

	// Ensure downloads directory exists
	await mkdir(DOWNLOADS_DIR);

	// Download the file
	await _download(url, destPath, task);

	// Mark as downloaded (atomic write)
	await setState(stateKey, { name: filename, date: TODAY });

	return destPath;
}

/**
 * Download a file published at several URLs, from the first one that works (with caching)
 *
 * A copy already downloaded from any of the URLs is reused. Otherwise the URLs are
 * tried in order through downloadFile, and a URL that fails moves on to the next.
 *
 * @param {string[]} urls - URLs of the same file, in order of preference
 * @param {string} filename - Filename to save as (used as cache key)
 * @param {Object} task - Optional Listr2 task for progress output
 * @returns {Promise<string>} Full path to the downloaded file
 */
async function downloadFileFrom(urls, filename, task) {
	const destPath = path.join(DOWNLOADS_DIR, filename);
	for (const url of urls) {
		if ((await getState(['downloads', url])) && (await exists(destPath))) {
			return destPath;
		}
	}

	const failures = [];
	for (const url of urls) {
		try {
			return await downloadFile(url, filename, task);
		} catch (err) {
			failures.push(`${url}: ${err.message || networkErrorCode(err) || String(err)}`);
			if (task) {
				task.output = `Download from ${new URL(url).host} failed, trying the next source...`;
			}
		}
	}
	throw new Error(`Download failed from every source:\n  ${failures.join('\n  ')}`);
}

/**
 * Download an asset of a GitHub release of this repository (with caching)
 *
 * A missing asset (HTTP 404) is remembered for the rest of the day and yields null instead of
 * an error. Assets of a prerelease tag are re-fetched once they are older than
 * PRERELEASE_TTL_MS, because such a tag may be force-pushed.
 *
 * @param {string} releaseTag - Release tag that holds the asset
 * @param {string} filename - Asset name on the release
 * @param {Object} task - Optional Listr2 task for progress output
 * @returns {Promise<string|null>} Full path to the downloaded file, or null if the asset does not exist
 */
async function downloadGitHubFile(releaseTag, filename, task) {
	const { repo } = await loadPackageJson();
	const fileUrl = `https://github.com/${repo}/releases/download/${releaseTag}/${filename}`;

	const downloadName = `${releaseTag}_${filename}`;
	const filePath = path.join(DOWNLOADS_DIR, downloadName);
	const stateKey = ['downloads', fileUrl];

	try {
		const fileState = await getState(stateKey);

		// File not found today, so skip it
		if (fileState && fileState.notFound && fileState.date === TODAY) {
			return null;
		}

		// Prerelease or experimental release 'server-vX.X.X-<suffix>'
		const prerelease = /-v[\d.]+-.+$/.test(releaseTag);
		const expired = Date.now() - (fileState?.timestamp ?? 0) >= PRERELEASE_TTL_MS;

		// Download the new file or re-download a prerelease one if it is out of date
		if (!(await exists(filePath)) || (prerelease && expired)) {
			// Ensure downloads directory exists
			await mkdir(DOWNLOADS_DIR);

			// Download the file
			await _download(fileUrl, filePath, task);

			await setState(stateKey, { name: downloadName, date: TODAY, timestamp: Date.now() });
		}

		return filePath;
	} catch (err) {
		if (err.message && err.message.includes('HTTP 404')) {
			// Let’s just note for today that the file cannot be found
			await setState(stateKey, { notFound: true, date: TODAY });
			return null;
		}
		throw err;
	}
}

/**
 * Internal: Perform the actual HTTP download
 *
 * Follows up to 5 redirects, retries 503/504 responses, retries a few connection failures
 * with a growing pause, and streams the body to destPath. A partial file is deleted when
 * the transfer fails.
 *
 * @param {string} url - URL to download from
 * @param {string} destPath - Full path of the file to write
 * @param {Object} task - Optional Listr2 task for progress output
 * @returns {Promise<void>} Resolves once the file is fully written
 */
async function _download(url, destPath, task) {
	/**
	 * Send one GET request
	 *
	 * A socket that stays silent for REQUEST_IDLE_TIMEOUT_MS is destroyed with an ETIMEDOUT
	 * error, since a socket timeout does not abort the request by itself.
	 *
	 * @param {string} currentUrl - URL to request
	 * @returns {Promise<import('http').IncomingMessage>} The response, whatever its status
	 */
	const makeRequest = (currentUrl) => {
		return new Promise((resolve, reject) => {
			const protocol = currentUrl.startsWith('https') ? https : require('http');
			const req = protocol.get(
				currentUrl,
				{ headers: { 'User-Agent': 'rocketride-build' }, timeout: REQUEST_IDLE_TIMEOUT_MS },
				resolve
			);
			// A socket timeout does not abort the request by itself.
			req.on('timeout', () => {
				const err = new Error(
					`No data from ${new URL(currentUrl).host} for ${REQUEST_IDLE_TIMEOUT_MS / 1000}s`
				);
				err.code = 'ETIMEDOUT';
				req.destroy(err);
			});
			req.on('error', reject);
		});
	};

	/**
	 * Wait for a while
	 *
	 * @param {number} ms - Time to wait, in milliseconds
	 * @returns {Promise<void>} Resolves after the wait
	 */
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	// Retry settings for 503/504 errors
	const MAX_RETRIES = 15;
	const RETRY_DELAY_MS = 1000;

	// A connection that fails before any response is tried a few times, with a
	// growing pause; a longer outage is left to the caller (e.g. a second URL).
	const MAX_NETWORK_ATTEMPTS = 3;
	const NETWORK_RETRY_DELAY_MS = 2000;
	let networkAttempts = 0;

	let response;
	let lastError;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		// Follow redirects (up to 5)
		let currentUrl = url;
		try {
			for (let i = 0; i <= 5; i++) {
				response = await makeRequest(currentUrl);
				if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
					// Destroy redirect response to close socket
					response.destroy();
					currentUrl = response.headers.location;
					continue;
				}
				break;
			}
		} catch (err) {
			networkAttempts++;
			const code = networkErrorCode(err);
			if (!RETRYABLE_NETWORK_CODES.has(code) || networkAttempts >= MAX_NETWORK_ATTEMPTS) {
				throw err;
			}
			const delay = NETWORK_RETRY_DELAY_MS * networkAttempts;
			if (task) {
				const retry = `${networkAttempts}/${MAX_NETWORK_ATTEMPTS - 1}`;
				task.output = `Connection failed (${code}), retrying in ${delay / 1000}s... (${retry})`;
			}
			await sleep(delay);
			continue;
		}

		if (response.statusCode >= 300 && response.statusCode < 400) {
			response.destroy();
			throw new Error('Too many redirects');
		}

		// Retry on 503 (Service Unavailable) or 504 (Gateway Timeout)
		if (response.statusCode === 503 || response.statusCode === 504) {
			response.destroy();
			lastError = `HTTP ${response.statusCode}`;
			if (task) {
				task.output = `Server error (${response.statusCode}), retrying in 1s... (${attempt}/${MAX_RETRIES})`;
			}
			await sleep(RETRY_DELAY_MS);
			continue;
		}

		if (response.statusCode !== 200) {
			response.destroy();
			throw new Error(`Download failed: HTTP ${response.statusCode}`);
		}

		// Success - break out of retry loop
		break;
	}

	// If we exhausted retries
	if (response.statusCode === 503 || response.statusCode === 504) {
		throw new Error(`Download failed after ${MAX_RETRIES} retries: ${lastError}`);
	}

	// Download with progress
	const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
	let downloadedBytes = 0;
	let lastPercent = -1; // Track last reported percentage to avoid duplicate updates
	const file = createWriteStream(destPath);

	try {
		await new Promise((resolve, reject) => {
			response.on('data', (chunk) => {
				downloadedBytes += chunk.length;
				if (task && totalBytes) {
					const percent = Math.round((downloadedBytes / totalBytes) * 100);
					// Only update when percentage changes
					if (percent !== lastPercent) {
						lastPercent = percent;
						const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
						task.output = `Downloading: ${percent}% (${mb} MB)`;
					}
				}
			});

			response.pipe(file);
			file.on('finish', () => {
				file.close();
				// Destroy the response stream to close the underlying socket
				response.destroy();
				resolve();
			});
			file.on('error', (err) => {
				response.destroy();
				reject(err);
			});
			response.on('error', (err) => {
				response.destroy();
				reject(err);
			});
		});
	} catch (err) {
		file.close();
		response.destroy();
		await unlink(destPath);
		throw err;
	}
}

/**
 * Create an archive (zip or tar.gz, chosen by the file extension) from files and directories
 *
 * @param {string} archivePath - Path of the archive to write
 * @param {string} cwd - Directory the entries are relative to
 * @param {string[]} files - Files and directories, relative to cwd, to put in the archive
 * @returns {Promise<void>} Resolves once the archive is written
 * @throws {Error} If the extension is not .zip or .tar.gz, or a zip entry does not exist
 */
async function createArchive(archivePath, cwd, files) {
	if (archivePath.endsWith('.tar.gz')) {
		await tar.create({ file: archivePath, cwd: cwd, gzip: true }, files);
	} else if (archivePath.endsWith('.zip')) {
		const zip = new AdmZip();
		for (const file of files) {
			const filepath = path.join(cwd, file);
			if (await isFile(filepath)) {
				zip.addLocalFile(filepath, '', file);
			} else if (await isDirectory(filepath)) {
				zip.addLocalFolder(filepath, file);
			} else {
				throw new Error(`File or directory not found: ${filepath}`);
			}
		}
		zip.writeZip(archivePath);
	} else {
		throw new Error(`Unsupported archive format: ${path.basename(archivePath)}`);
	}
}

/**
 * Extract an archive (zip or tar.gz) to a destination directory
 *
 * @param {string} archivePath - Path to archive file
 * @param {string} destDir - Destination directory
 * @param {Object} options - Options
 * @param {number} options.stripLevels - Number of leading path components to strip
 * @param {boolean} options.resetDestDir - Delete destDir first, so no file of an earlier extraction is left
 * @returns {Promise<void>} Resolves once the archive is extracted
 * @throws {Error} If the archive is not a .zip, .tar.gz or .tgz
 */
async function extractArchive(archivePath, destDir, options = {}) {
	const { stripLevels = 0, resetDestDir = false } = options;

	// Remove dest if exists
	if (resetDestDir && (await exists(destDir))) {
		await rm(destDir);
	}
	await mkdir(destDir);

	if (archivePath.endsWith('.zip')) {
		const zip = new AdmZip(archivePath);

		if (stripLevels > 0) {
			// Extract each entry with path stripping (no temp directory)
			const entries = zip.getEntries();
			for (const entry of entries) {
				// Split path and strip leading components
				const parts = entry.entryName.split('/').filter((p) => p);
				if (parts.length <= stripLevels) continue; // Skip entries that would be stripped entirely

				const strippedPath = parts.slice(stripLevels).join('/');
				const targetPath = path.join(destDir, strippedPath);

				if (entry.isDirectory) {
					await mkdir(targetPath);
				} else {
					// Ensure parent directory exists
					await mkdir(path.dirname(targetPath));
					// Extract file content
					const content = entry.getData();
					await writeFile(targetPath, content);
				}
			}
		} else {
			// Extract directly
			zip.extractAllTo(destDir, true);
		}
	} else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
		await mkdir(destDir);
		await tar.extract({
			file: archivePath,
			cwd: destDir,
			strip: stripLevels,
		});
	} else {
		throw new Error(`Unknown archive format: ${archivePath}`);
	}
}

module.exports = {
	DOWNLOADS_DIR,
	loadPackageJson,
	downloadFile,
	downloadFileFrom,
	downloadGitHubFile,
	createArchive,
	extractArchive,
};
