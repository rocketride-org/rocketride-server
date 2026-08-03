// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Vendored-shell injection for standalone app repos.
 *
 * Fetches the installable shell platform package (shell.tgz) from a
 * server's /client/shell endpoint and swap-extracts it to
 * .rocketride/shell.
 *
 * Two entry points:
 *   ensureVendoredShell — automatic: called by build.js before the
 *     dependency bootstrap. Scans the workspace package.jsons; when a
 *     member depends on the vendored shell (file: spec into
 *     .rocketride/shell) and the package is MISSING, fetches it so the
 *     following pnpm install succeeds. Never refreshes an existing
 *     install.
 *   vendorShell — explicit: the shell:update task uses it to refresh the
 *     package whether or not it is already installed.
 *
 * Host precedence: --shell=<url> (explicit) beats ROCKETRIDE_URI from
 * .config/.env (ambient) beats http://localhost:5565.
 *
 * Intentionally depends only on Node built-ins (plus getenv, itself
 * built-ins-only): in a standalone repo the workspace cannot even
 * `pnpm install` until .rocketride/shell exists — every app depends on
 * it as file:../../.rocketride/shell — so the automatic path must run
 * BEFORE the builder's dependency bootstrap.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

// =============================================================================
// TAR EXTRACTION
// =============================================================================

/**
 * Extracts a pnpm-pack tarball (gzip + ustar, exactly what pack-shell
 * emits) into a directory, stripping the leading 'package/' segment.
 *
 * Pure JS on purpose: shelling out to `tar` varies by platform (MSYS tar
 * misreads C:\ paths), while pnpm-pack tarballs are plain ustar with pax
 * extended headers only for over-long paths.
 *
 * @param {Buffer} tgz - The gzipped tarball bytes.
 * @param {string} destDir - Directory to extract into (must exist).
 */
function extractShellTgz(tgz, destDir) {
	const tarBuf = zlib.gunzipSync(tgz);
	// Path override supplied by an immediately-preceding pax header.
	let paxPath = null;
	let off = 0;
	while (off + 512 <= tarBuf.length) {
		const block = tarBuf.subarray(off, off + 512);
		// step: two consecutive zero blocks terminate the archive
		if (block.every((b) => b === 0)) break;
		// step: decode the ustar header fields we need
		const readStr = (start, len) => block.subarray(start, start + len).toString('utf8').replace(/\0.*$/, '');
		const name = readStr(0, 100);
		const size = parseInt(readStr(124, 12).trim() || '0', 8);
		const type = readStr(156, 1) || '0';
		const prefix = readStr(345, 155);
		const dataStart = off + 512;
		const data = tarBuf.subarray(dataStart, dataStart + size);
		// step: advance to the next 512-aligned header
		off = dataStart + Math.ceil(size / 512) * 512;
		// step: pax extended header — records a long path for the NEXT entry
		if (type === 'x' || type === 'g') {
			const m = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(data.toString('utf8'));
			if (type === 'x' && m) paxPath = m[1];
			continue;
		}
		const full = paxPath ?? (prefix ? `${prefix}/${name}` : name);
		paxPath = null;
		// step: write files/dirs, stripping 'package/' and refusing escapes
		const rel = full.replace(/^package\//, '');
		if (!rel || rel.includes('..')) continue;
		const target = path.join(destDir, rel);
		if (type === '5') {
			fs.mkdirSync(target, { recursive: true });
		} else if (type === '0') {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, data);
		}
	}
}

// =============================================================================
// WORKSPACE SCAN
// =============================================================================

/**
 * Lists the package.json paths that can depend on the vendored shell:
 * the repo root's own manifest plus every app's (apps/<name>/package.json
 * — apps live in ./apps by convention).
 *
 * @param {string} root - Repository root.
 * @returns {string[]} Absolute package.json paths that exist.
 */
function candidatePackageJsons(root) {
	const pkgs = [];
	// step: the root manifest
	const rootPkg = path.join(root, 'package.json');
	if (fs.existsSync(rootPkg)) pkgs.push(rootPkg);
	// step: one manifest per app directory
	const appsDir = path.join(root, 'apps');
	if (fs.existsSync(appsDir)) {
		for (const name of fs.readdirSync(appsDir)) {
			const p = path.join(appsDir, name, 'package.json');
			if (fs.existsSync(p)) pkgs.push(p);
		}
	}
	return pkgs;
}

/**
 * Whether the root or any app depends on the vendored shell package.
 *
 * The signal is a `shell` dependency whose spec points into
 * .rocketride/shell (file:../../.rocketride/shell). Source-level
 * 'shell/client' imports resolve through the same installed package, so
 * this one check covers the whole platform surface.
 *
 * @param {string} root - Repository root.
 * @returns {boolean} True when the vendored package is required.
 */
function workspaceNeedsShell(root) {
	for (const pkgPath of candidatePackageJsons(root)) {
		let pkg;
		try {
			pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		} catch {
			continue; // malformed manifest — pnpm will report it
		}
		const spec = (pkg.dependencies && pkg.dependencies.shell) || (pkg.devDependencies && pkg.devDependencies.shell);
		if (typeof spec === 'string' && spec.replace(/\\/g, '/').includes('.rocketride/shell')) return true;
	}
	return false;
}

// =============================================================================
// VENDOR
// =============================================================================

/**
 * Resolves the server to vendor the platform package from.
 *
 * Explicit beats ambient: --shell=<url> from the command line, then
 * ROCKETRIDE_URI from the builder env (.config/.env), then localhost.
 *
 * @param {string} [cliShell] - Value of the --shell= option, if given.
 * @returns {string} Base URL without a trailing slash.
 */
function resolveHost(cliShell) {
	const { getenv } = require('./getenv');
	return (cliShell || getenv().ROCKETRIDE_URI || 'http://localhost:5565').replace(/\/$/, '');
}

/**
 * Renames with a few retries: on Windows a freshly-written directory can be
 * transiently locked (antivirus/indexer scanning the new files), failing
 * the swap with EPERM/EBUSY even though nothing holds it moments later.
 *
 * @param {string} from - Source path.
 * @param {string} to - Destination path.
 */
async function renameWithRetry(from, to) {
	for (let attempt = 1; ; attempt++) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (err) {
			const transient = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'ENOTEMPTY';
			if (attempt >= 5 || !transient) throw err;
			await new Promise((resolve) => setTimeout(resolve, attempt * 200));
		}
	}
}

/**
 * Fetches <server>/client/shell and swap-extracts it to
 * <root>/.rocketride/shell, optionally relinking the workspace
 * (pnpm install) afterwards.
 *
 * The raw tarball is kept beside the extraction for provenance. The
 * extraction is swap-based — a torn update never leaves a half-written
 * package installed.
 *
 * @param {string} root - Repository root (the directory holding .rocketride/).
 * @param {string} [host] - Server base URL; resolved via resolveHost().
 * @param {object} [opts]
 * @param {boolean} [opts.install=true] - Run pnpm install after the swap.
 *   Pass false when the caller runs its own install right after.
 * @param {(msg: string) => void} [opts.log=console.log] - Progress sink
 *   (the shell:update task routes this into its listr output).
 * @returns {Promise<string>} The vendored package version.
 */
async function vendorShell(root, host, opts = {}) {
	const { install = true, log = console.log } = opts;
	const base = resolveHost(host);
	const url = `${base}/client/shell`;

	// step: fetch the stable-named tarball from the server
	log(`Fetching ${url} ...`);
	let res;
	try {
		res = await fetch(url);
	} catch (err) {
		throw new Error(`Cannot reach ${base} — is the server running? (${err.message})`);
	}
	if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} — the server does not serve the shell package`);
	const tgz = Buffer.from(await res.arrayBuffer());

	// step: keep the raw tarball beside the extraction (provenance)
	const rrDir = path.join(root, '.rocketride');
	fs.mkdirSync(rrDir, { recursive: true });
	fs.writeFileSync(path.join(rrDir, 'shell.tgz'), tgz);

	// step: swap-extract so a torn update never leaves a half-written
	// package installed
	const staging = path.join(rrDir, 'shell.extracting');
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true });
	extractShellTgz(tgz, staging);
	const dest = path.join(rrDir, 'shell');
	fs.rmSync(dest, { recursive: true, force: true });
	await renameWithRetry(staging, dest);
	const version = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).version;

	// step: relink — apps consume the pnpm-store copy of the file:
	// dependency, which only refreshes on install
	if (install) {
		log(`shell v${version} vendored — relinking workspace (pnpm install)...`);
		execFileSync('pnpm', ['install'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
	}
	log(`shell v${version} vendored from ${base}`);
	return version;
}

/**
 * Automatic injection: fetches the vendored shell before the caller's
 * pnpm install, but ONLY when a workspace member actually depends on it
 * and .rocketride/shell is missing. An existing install is never touched
 * — refreshing is explicit (builder shell:update).
 *
 * @param {string} root - Repository root.
 * @param {object} [options] - Parsed builder options (reads options.shell).
 * @returns {Promise<boolean>} True when the package was fetched.
 */
async function ensureVendoredShell(root, options = {}) {
	// step: cheap exits — package already present, or nobody needs it
	if (fs.existsSync(path.join(root, '.rocketride', 'shell', 'package.json'))) return false;
	if (!workspaceNeedsShell(root)) return false;

	// step: fetch without the trailing install — the caller's dependency
	// bootstrap runs pnpm install right after
	console.log('Vendored shell missing — fetching it before installing dependencies...');
	await vendorShell(root, options.shell, { install: false });
	return true;
}

// renameWithRetry is shared with copy-scripts.js — same Windows swap dance.
module.exports = { vendorShell, ensureVendoredShell, renameWithRetry };
