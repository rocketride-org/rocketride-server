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
 * App-types bundle generator — the SHIPPED type surface for standalone
 * (third-party) RocketRide apps.
 *
 * A standalone app repo has no rocketride-server checkout: at runtime and at
 * build time the platform modules arrive from the shell's Module Federation
 * share scope (consume-only, `import: false`), so the ONLY thing such a repo
 * needs from us is TYPES. This script produces that artifact:
 *
 *   build/app-types/
 *     shell-ui/index.d.ts   — the NEWEST FROZEN shell-api contract, verbatim.
 *                             Third-party apps compile against the frozen
 *                             contract (the floors guarantee it keeps
 *                             working); only in-tree apps ride the live API.
 *     shared/index.d.ts     — dts-bundle-generator rollup of the shared-ui
 *                             component barrel (same tool the freeze uses).
 *     app-types.json        — provenance: shell-api version, commit, date.
 *
 * The App Builder vendors this bundle into app folders as
 * `types/rocketride-shell/` (scaffold + refresh on open) and the scaffolded
 * tsconfig maps `shell-ui`/`shared` onto it via `paths`.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// =============================================================================
// PATHS + TOOLING
// =============================================================================

const APP_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(APP_ROOT, '..', '..');
const VERSIONS_DIR = path.join(REPO_ROOT, 'packages', 'shell-api', 'versions');
const SHARED_SRC = path.join(REPO_ROOT, 'packages', 'shared-ui', 'src');
const OUT_DIR = path.join(process.env.ROCKETRIDE_BUILD_ROOT ?? path.join(REPO_ROOT, 'build'), 'app-types');

/**
 * Resolves a package's executable the same way the freeze script does.
 *
 * @param {string} pkg - Package name.
 * @param {string} binName - Bin entry name.
 * @returns {{ binPath: string, version: string }} Executable path + version.
 */
function resolveBin(pkg, binName) {
	const pkgJsonPath = require.resolve(`${pkg}/package.json`, { paths: [APP_ROOT] });
	const pkgDir = path.dirname(pkgJsonPath);
	const manifest = require(pkgJsonPath);
	const binRel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[binName];
	return { binPath: path.join(pkgDir, binRel), version: manifest.version };
}

const DBG = resolveBin('dts-bundle-generator', 'dts-bundle-generator');

// =============================================================================
// STEPS
// =============================================================================

/**
 * Finds the newest frozen shell-api snapshot (vN.d.ts with the highest N).
 *
 * @returns {{ file: string, version: number }} Snapshot path + version.
 */
function newestFrozenContract() {
	const versions = fs.readdirSync(VERSIONS_DIR)
		.map((name) => /^v(\d+)\.d\.ts$/.exec(name))
		.filter(Boolean)
		.map((m) => Number(m[1]))
		.sort((a, b) => b - a);
	if (versions.length === 0) throw new Error(`generate-app-types: no frozen shell-api versions in ${VERSIONS_DIR} — run ./builder shell:freeze first`);
	return { file: path.join(VERSIONS_DIR, `v${versions[0]}.d.ts`), version: versions[0] };
}

/**
 * Rolls up the shared-ui barrel into one .d.ts via dts-bundle-generator.
 *
 * @param {string} outFile - Destination file.
 */
function bundleShared(outFile) {
	// --no-check: shared-ui type-checks in its own CI; this is a packaging
	// step. External imports (react, rocketride) stay external — react types
	// come from the app's own devDependencies; rocketride from the SDK
	// package when the app installs it (skipLibCheck covers it otherwise).
	execFileSync(process.execPath, [
		DBG.binPath,
		'--no-check',
		'--no-banner',
		'--export-referenced-types=false',
		'-o', outFile,
		'index.ts',
	], { cwd: SHARED_SRC, stdio: ['ignore', 'pipe', 'pipe'] });
}

// =============================================================================
// MAIN
// =============================================================================

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT_DIR, 'shell-ui'), { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'shared'), { recursive: true });

// shell-ui: the newest frozen contract, verbatim (already a module-shaped
// rollup — tsconfig `paths` maps the 'shell-ui' specifier straight onto it).
const frozen = newestFrozenContract();
fs.copyFileSync(frozen.file, path.join(OUT_DIR, 'shell-ui', 'index.d.ts'));

// shared: fresh rollup of the component barrel.
bundleShared(path.join(OUT_DIR, 'shared', 'index.d.ts'));

// Provenance manifest — lets tooling (and humans) see what a vendored copy
// was generated from.
fs.writeFileSync(path.join(OUT_DIR, 'app-types.json'), `${JSON.stringify({
	shellApiVersion: frozen.version,
	generated: new Date().toISOString(),
	generator: `dts-bundle-generator@${DBG.version}`,
}, null, '\t')}\n`);

console.log(`generate-app-types: shell-ui (frozen v${frozen.version}) + shared rollup -> ${OUT_DIR}`);
