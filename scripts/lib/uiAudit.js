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
 * UI app-family consistency audit (the `ui:audit` builder action).
 *
 * Guards the invariants of the aligned app family — every apps/<name>
 * carrying an rsbuild.config.mts, plus apps/shared and packages/shell where
 * present. Drift in any of these fails the task with a per-finding message:
 *
 *   1. Template conformance — each standard MF remote's rsbuild.config.mts
 *      must render byte-identically from the canonical template
 *      (scripts/assets/rsbuild-app-config.template), parameterized only by
 *      title, dev hint, port, and the optional writeToDisk dev block.
 *   2. Port uniqueness — no two apps may share a dev port (allowlisted
 *      pairs excepted).
 *   3. Manifest hygiene — license field, the standard scripts block, and
 *      the canonical browserslist.
 *   4. Dependency-range consistency — a dependency must declare the SAME
 *      range everywhere in the family; multi-range exceptions live in an
 *      explicit allowlist so they stay documented, never silent.
 *
 * Overlay-aware: pass overlayRoot to audit the overlay repo's apps/ tree
 * together with this repo's own (cross-repo port collisions only surface
 * in overlay runs).
 */

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./paths');

// =============================================================================
// POLICY
// =============================================================================

// Apps that predate the MF baseline; standalone rsbuild apps, exempt from
// template + browserslist conformance (still checked for license, scripts,
// ports, and dependency ranges).
const LEGACY_APPS = ['chat-ui', 'dropper-ui'];

// Apps allowed to extend the baseline (extra plugins/rules); checked for the
// structural invariants instead of byte-conformance.
const STRUCTURAL_APPS = ['rocket-ui'];

// Directories under apps/ that are not MF remotes.
const EXCLUDED_DIRS = ['vscode', 'shared'];

// Pairs allowed to share a dev port: shells that never co-run (oss vs saas).
const ALLOWED_PORT_SHARERS = [['hello-ui', 'home-ui']];

// Deps intentionally declared with more than one range across the family.
const ALLOWED_RANGES = {
	// explorer-ui pins the concrete 3.4.x line; shared's peer states the
	// broader floor apps must satisfy.
	dompurify: ['~3.4.13', '~3.4.0'],
};

// The single browser floor every remote (and the shell host) compiles for.
const CANONICAL_BROWSERSLIST = ['chrome >= 81', 'edge >= 83', 'firefox >= 76', 'safari >= 13'];

// Scripts block every app package.json must expose.
const REQUIRED_SCRIPTS = ['build', 'build:prod', 'dev', 'typecheck'];

// The optional dev block, exactly as it appears in conforming configs.
const DEV_BLOCK =
	'\t\tdev: {\n' +
	"\t\t\t// Write built assets to disk so the shell's static file server\n" +
	'\t\t\t// picks up changes without a full saas:dev restart.\n' +
	'\t\t\twriteToDisk: true,\n' +
	'\t\t},\n';

// =============================================================================
// DISCOVERY
// =============================================================================

/**
 * Finds every app directory carrying an rsbuild.config.mts under the
 * platform repo and (when given) the overlay repo.
 *
 * @param {string} [overlayRoot] - Overlay repo root (saas mode), if any.
 * @returns {Array<{name: string, dir: string}>} App entries.
 */
function discoverApps(overlayRoot) {
	const roots = [PROJECT_ROOT];
	if (overlayRoot && path.resolve(overlayRoot) !== path.resolve(PROJECT_ROOT)) {
		roots.push(path.resolve(overlayRoot));
	}
	const apps = [];
	for (const root of roots) {
		const appsDir = path.join(root, 'apps');
		if (!fs.existsSync(appsDir)) continue;
		for (const name of fs.readdirSync(appsDir)) {
			if (EXCLUDED_DIRS.includes(name)) continue;
			const dir = path.join(appsDir, name);
			if (fs.existsSync(path.join(dir, 'rsbuild.config.mts'))) {
				apps.push({ name, dir });
			}
		}
	}
	return apps;
}

/**
 * Collects the package.json paths of the whole family: every discovered app
 * plus apps/shared (per root) and packages/shell (platform repo only).
 *
 * @param {Array<{name: string, dir: string}>} apps - Discovered apps.
 * @param {string} [overlayRoot] - Overlay repo root, if any.
 * @returns {Array<{name: string, pkg: object}>} Parsed manifests.
 */
function readFamilyManifests(apps, overlayRoot) {
	const entries = apps.map(({ name, dir }) => ({ name, dir }));
	const roots = [PROJECT_ROOT];
	if (overlayRoot && path.resolve(overlayRoot) !== path.resolve(PROJECT_ROOT)) {
		roots.push(path.resolve(overlayRoot));
	}
	for (const root of roots) {
		const sharedDir = path.join(root, 'apps', 'shared');
		if (fs.existsSync(path.join(sharedDir, 'package.json'))) {
			entries.push({ name: 'shared', dir: sharedDir });
		}
	}
	const shellDir = path.join(PROJECT_ROOT, 'packages', 'shell');
	if (fs.existsSync(path.join(shellDir, 'package.json'))) {
		entries.push({ name: 'shell', dir: shellDir });
	}
	return entries.map(({ name, dir }) => ({
		name,
		pkg: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')),
	}));
}

// =============================================================================
// CHECKS
// =============================================================================

/**
 * Renders the canonical template with one app's parameters and compares it
 * against the app's actual config. Returns an error string, or null.
 *
 * @param {string} name - App directory name (for messages).
 * @param {string} configText - LF-normalized rsbuild.config.mts content.
 * @param {string} template - Canonical template content.
 * @returns {string|null} Error description or null when conforming.
 */
function checkTemplateConformance(name, configText, template) {
	const titleMatch = configText.match(/\n\/\/ =+\n\/\/ (.+)\n\/\/ =+\n/);
	const hintMatch = configText.match(/Run (\S+) for development/);
	const portMatch = configText.match(/port: (\d+)/);
	if (!titleMatch || !hintMatch || !portMatch) {
		return `${name}: rsbuild.config.mts is missing the header title, dev hint, or port`;
	}
	const rendered = template
		.split('{{TITLE}}').join(titleMatch[1])
		.split('{{DEVHINT}}').join(hintMatch[1])
		.split('{{PORT}}').join(portMatch[1])
		.split('{{DEVBLOCK}}').join(configText.includes('writeToDisk: true') ? DEV_BLOCK : '');
	if (rendered === configText) return null;
	const a = rendered.split('\n');
	const b = configText.split('\n');
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i] !== b[i]) {
			return `${name}: rsbuild.config.mts drifts from the canonical template at line ${i + 1} ` +
				`(expected ${JSON.stringify(a[i] ?? '<EOF>')}, found ${JSON.stringify(b[i] ?? '<EOF>')})`;
		}
	}
	return `${name}: rsbuild.config.mts drifts from the canonical template`;
}

/**
 * Structural invariants for apps that legitimately extend the baseline.
 *
 * @param {string} name - App directory name.
 * @param {string} configText - LF-normalized config content.
 * @returns {string[]} Error descriptions (empty when sound).
 */
function checkStructuralInvariants(name, configText) {
	const errors = [];
	if (!configText.includes("throw new Error('package.json must define a non-empty appManifest.id')")) {
		errors.push(`${name}: missing the fail-hard appManifest.id guard`);
	}
	if (!configText.includes('ROCKETRIDE_BUILD_ROOT')) {
		errors.push(`${name}: distPath does not honor ROCKETRIDE_BUILD_ROOT`);
	}
	if (!configText.includes('.pipe$')) {
		errors.push(`${name}: missing the .pipe -> JSON module rule`);
	}
	if (!configText.includes('MIT License')) {
		errors.push(`${name}: missing the MIT header`);
	}
	return errors;
}

/**
 * Dev-port uniqueness across every discovered app.
 *
 * @param {Array<{name: string, port: string}>} ports - Per-app dev ports.
 * @returns {string[]} Error descriptions (empty when unique).
 */
function checkPortUniqueness(ports) {
	const byPort = new Map();
	for (const { name, port } of ports) {
		if (!byPort.has(port)) byPort.set(port, []);
		byPort.get(port).push(name);
	}
	const errors = [];
	for (const [port, names] of byPort) {
		if (names.length < 2) continue;
		const sorted = [...names].sort();
		const allowed = ALLOWED_PORT_SHARERS.some(
			pair => pair.length === sorted.length && pair.every((n, i) => n === sorted[i]),
		);
		if (!allowed) {
			errors.push(`dev port ${port} is claimed by ${sorted.join(' AND ')}`);
		}
	}
	return errors;
}

/**
 * License / scripts / browserslist hygiene for one manifest.
 *
 * @param {string} name - Package directory name.
 * @param {object} pkg - Parsed package.json.
 * @param {boolean} isApp - True for app remotes (scripts block required).
 * @param {boolean} needsBrowserslist - True when the canonical floor applies.
 * @returns {string[]} Error descriptions (empty when clean).
 */
function checkManifestHygiene(name, pkg, isApp, needsBrowserslist) {
	const errors = [];
	if (pkg.license !== 'MIT') {
		errors.push(`${name}: package.json license must be "MIT" (found ${JSON.stringify(pkg.license)})`);
	}
	if (isApp) {
		for (const script of REQUIRED_SCRIPTS) {
			if (!pkg.scripts || !pkg.scripts[script]) {
				errors.push(`${name}: package.json is missing the "${script}" script`);
			}
		}
	}
	if (needsBrowserslist &&
		JSON.stringify(pkg.browserslist) !== JSON.stringify(CANONICAL_BROWSERSLIST)) {
		errors.push(`${name}: browserslist must equal the canonical floor ${JSON.stringify(CANONICAL_BROWSERSLIST)}`);
	}
	return errors;
}

/**
 * One-declared-range-per-dependency across the family, modulo the allowlist.
 *
 * @param {Array<{name: string, pkg: object}>} manifests - Family manifests.
 * @returns {string[]} Error descriptions (empty when consistent).
 */
function checkDependencyRanges(manifests) {
	const ranges = new Map(); // dep -> Map(range -> [pkg names])
	for (const { name, pkg } of manifests) {
		for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
			for (const [dep, range] of Object.entries(pkg[section] || {})) {
				if (!ranges.has(dep)) ranges.set(dep, new Map());
				const byRange = ranges.get(dep);
				if (!byRange.has(range)) byRange.set(range, []);
				byRange.get(range).push(name);
			}
		}
	}
	const errors = [];
	for (const [dep, byRange] of ranges) {
		if (byRange.size < 2) continue;
		const allowed = ALLOWED_RANGES[dep];
		if (allowed && [...byRange.keys()].every(r => allowed.includes(r))) continue;
		const detail = [...byRange.entries()]
			.map(([range, names]) => `${range} <- ${names.join(', ')}`)
			.join('; ');
		errors.push(`dependency "${dep}" is declared with ${byRange.size} different ranges: ${detail}`);
	}
	return errors;
}

// =============================================================================
// ENTRY POINT
// =============================================================================

/**
 * Runs the full audit and throws when any check fails.
 *
 * @param {object} [options]
 * @param {string} [options.overlayRoot] - Overlay repo root (saas mode).
 * @param {object} [options.task] - Listr task for progress output.
 * @throws {Error} Aggregated findings, one line per problem.
 */
function runUiAudit({ overlayRoot, task } = {}) {
	const template = fs
		.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'assets', 'rsbuild-app-config.template'), 'utf8')
		.replace(/\r\n/g, '\n');
	const apps = discoverApps(overlayRoot);
	const errors = [];
	const ports = [];

	// Pass 1: per-config checks + port collection.
	for (const { name, dir } of apps) {
		const configText = fs
			.readFileSync(path.join(dir, 'rsbuild.config.mts'), 'utf8')
			.replace(/\r\n/g, '\n');
		const portMatch = configText.match(/port: (\d+)/);
		if (portMatch) ports.push({ name, port: portMatch[1] });
		if (LEGACY_APPS.includes(name)) continue;
		if (STRUCTURAL_APPS.includes(name)) {
			errors.push(...checkStructuralInvariants(name, configText));
		} else {
			const err = checkTemplateConformance(name, configText, template);
			if (err) errors.push(err);
		}
	}

	// Pass 2: port uniqueness (cross-repo in overlay runs).
	errors.push(...checkPortUniqueness(ports));

	// Pass 3 + 4: manifest hygiene and dependency-range drift.
	const manifests = readFamilyManifests(apps, overlayRoot);
	for (const { name, pkg } of manifests) {
		const isApp = apps.some(a => a.name === name);
		const needsBrowserslist = name === 'shell' || (isApp && !LEGACY_APPS.includes(name));
		errors.push(...checkManifestHygiene(name, pkg, isApp, needsBrowserslist));
	}
	errors.push(...checkDependencyRanges(manifests));

	if (task) {
		task.output = `${apps.length} apps + ${manifests.length - apps.length} support packages audited`;
	}
	if (errors.length) {
		throw new Error(`ui:audit found ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`);
	}
}

module.exports = { runUiAudit, discoverApps };
