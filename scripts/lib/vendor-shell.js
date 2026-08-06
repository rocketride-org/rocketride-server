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
 *   vendorShell — explicit: the client:update task uses it to refresh the
 *     package whether or not it is already installed.
 *
 * Host precedence: --shell=<url> (explicit) beats ROCKETRIDE_URI from
 * .config/.env (ambient) beats http://localhost:5565.
 *
 * Intentionally depends only on Node built-ins (plus getenv, itself
 * built-ins-only): in a standalone repo the workspace cannot even
 * `pnpm install` until .rocketride/shell/shell.tgz exists — every app
 * depends on it as file:../../.rocketride/shell/shell.tgz — so the
 * automatic path must run BEFORE the builder's dependency bootstrap.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
 * .rocketride/shell (file:../../.rocketride/shell/shell.tgz). Source-level
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
 * Fetches <server>/client/shell to the canonical
 * <root>/.rocketride/shell/shell.tgz, optionally relinking the workspace
 * (pnpm install) afterwards.
 *
 * @param {string} root - Repository root (the directory holding .rocketride/).
 * @param {string} [host] - Server base URL; resolved via resolveHost().
 * @param {object} [opts]
 * @param {boolean} [opts.install=true] - Run pnpm install after the write.
 *   Pass false when the caller runs its own install right after.
 * @param {(msg: string) => void} [opts.log=console.log] - Progress sink
 *   (the client:update task routes this into its listr output).
 * @returns {Promise<string>} The canonical tarball path.
 */
async function vendorShell(root, host, opts = {}) {
	const { install = true, log = console.log } = opts;
	const base = resolveHost(host);
	const url = `${base}/client/shell`;

	// step: fetch the stable-named tarball from the server
	log(`Fetching ${url} ...`);
	let res;
	try {
		// Bounded wait — a black-holed host must fail loudly, not hang the build.
		res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
	} catch (err) {
		if (err.name === 'TimeoutError') {
			throw new Error(`${url} timed out after 60s — is the server responding?`);
		}
		throw new Error(`Cannot reach ${base} — is the server running? (${err.message})`);
	}
	if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} — the server does not serve the shell package`);
	const tgz = Buffer.from(await res.arrayBuffer());

	// step: write the canonical install artifact — the file every member's
	// shell dependency (and the workspace override) resolves
	const shellDir = path.join(root, '.rocketride', 'shell');
	const tgzPath = path.join(shellDir, 'shell.tgz');
	fs.mkdirSync(shellDir, { recursive: true });
	fs.writeFileSync(tgzPath, tgz);
	// A real package supersedes any fresh-clone stub.
	fs.rmSync(`${tgzPath}.stub`, { force: true });

	// step: relink — apps consume the pnpm-store copy of the file:
	// dependency, which only refreshes on install
	if (install) {
		log('shell package vendored — relinking workspace (pnpm install)...');
		// execSync string form: pnpm is a .cmd shim on Windows, so the command
		// must go through the shell — and the string form avoids DEP0190
		// (shell:true with an args array concatenates unescaped).
		execSync('pnpm install', { cwd: root, stdio: 'inherit' });
	}
	log(`shell package vendored from ${base} (${(tgz.length / 1024).toFixed(0)} KB) -> ${tgzPath}`);
	return tgzPath;
}

/**
 * Automatic injection: fetches the vendored shell before the caller's
 * pnpm install, but ONLY when a workspace member actually depends on it
 * and .rocketride/shell is missing. An existing install is never touched
 * — refreshing is explicit (builder client:update).
 *
 * @param {string} root - Repository root.
 * @param {object} [options] - Parsed builder options (reads options.shell).
 * @returns {Promise<boolean>} True when the package was fetched.
 */
async function ensureVendoredShell(root, options = {}) {
	// step: cheap exits — artifact already present, or nobody needs it
	if (fs.existsSync(path.join(root, '.rocketride', 'shell', 'shell.tgz'))) return false;
	if (!workspaceNeedsShell(root)) return false;

	// step: fetch without the trailing install — the caller's dependency
	// bootstrap runs pnpm install right after
	console.log('Vendored shell missing — fetching it before installing dependencies...');
	await vendorShell(root, options.shell, { install: false });
	return true;
}

/**
 * Fresh-clone stub: packs the minimal placeholder shell package (the
 * plain-text fixture at scripts/assets/shell-stub) to the root's canonical
 * .rocketride/shell/shell.tgz so the workspace's file: tarball
 * dependencies resolve BEFORE shell:build has ever produced the real
 * artifact.
 *
 * pnpm only needs the tarball to exist with a parseable manifest; nothing
 * compiles against the stub (ui:build orders shell:build before every app,
 * and the first shell:build overwrites it — the changed integrity makes
 * the chained install relink every consumer). The shell.tgz.stub marker
 * written beside it lets the shell bundle's cache-skip tell stub from real
 * without unpacking anything.
 *
 * @param {string} root - Repository root (the platform or overlay repo).
 * @returns {boolean} True when a stub was written.
 */
function ensureShellStub(root) {
	// step: cheap exits — an artifact (real or previous stub) already
	// present, or nobody installs it
	const shellDir = path.join(root, '.rocketride', 'shell');
	const tgzPath = path.join(shellDir, 'shell.tgz');
	if (fs.existsSync(tgzPath)) return false;
	if (!workspaceNeedsShell(root)) return false;

	// step: pack the fixture with pnpm (guaranteed present — it is the very
	// package manager the bootstrap is about to run) into the canonical
	// spot. execSync string form: pnpm is a .cmd shim on Windows, so the
	// command must go through the shell — and the string form avoids
	// DEP0190 (shell:true with an args array concatenates unescaped).
	const stubSrc = path.join(__dirname, '..', 'assets', 'shell-stub');
	fs.mkdirSync(shellDir, { recursive: true });
	execSync(`pnpm pack --pack-destination "${shellDir}"`, { cwd: stubSrc, stdio: 'pipe' });
	const packed = fs.readdirSync(shellDir).find((f) => /^shell-.*\.tgz$/.test(f));
	if (!packed) throw new Error('shell-stub: pnpm pack produced no tarball');
	fs.renameSync(path.join(shellDir, packed), tgzPath);
	// step: mark it as the stub so the shell build never cache-skips past it
	fs.writeFileSync(`${tgzPath}.stub`, '');
	console.log('Vendored shell missing — packed the placeholder shell.tgz (the first shell:build replaces it with the real package)');
	return true;
}

// renameWithRetry is shared with copy-scripts.js — same Windows swap dance.
module.exports = { vendorShell, ensureVendoredShell, ensureShellStub, renameWithRetry };
