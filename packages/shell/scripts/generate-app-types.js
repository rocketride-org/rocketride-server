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
 * App-types generator — the SHIPPED type surface for standalone
 * (third-party) RocketRide apps: ONE file.
 *
 * A standalone app repo has no rocketride-server checkout: at runtime and at
 * build time the platform arrives from the shell's Module Federation share
 * scope (consume-only, `import: false`), so the ONLY thing such a repo needs
 * from us is TYPES. Since the shell unification there is exactly one surface
 * and therefore exactly one artifact:
 *
 *   build/app-types/
 *     shell.d.ts       — the NEWEST FROZEN shell contract, verbatim. The
 *                        frozen bundle IS the whole app-facing surface
 *                        (stock components included); there is no separate
 *                        shared rollup — non-surface library components are
 *                        first-party-only and never reach standalone apps.
 *     app-types.json   — provenance: shell-api version, commit, date.
 *
 * The App Builder vendors this into app folders as `types/rocketride-shell/`
 * (scaffold + refresh on open, server-first); the scaffolded tsconfig maps
 * the 'shell' specifier onto shell.d.ts via `paths`. Servers publish the
 * same two files at /dev/types/.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// =============================================================================
// PATHS + TOOLING
// =============================================================================

const APP_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(APP_ROOT, '..', '..');
const VERSIONS_DIR = path.join(APP_ROOT, 'contract', 'versions');
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

// =============================================================================
// MAIN
// =============================================================================

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// The newest frozen contract, verbatim (already a module-shaped rollup —
// tsconfig `paths` maps the 'shell' specifier straight onto it).
const frozen = newestFrozenContract();
fs.copyFileSync(frozen.file, path.join(OUT_DIR, 'shell.d.ts'));

// Provenance manifest — lets tooling (and humans) see what a vendored copy
// was generated from.
fs.writeFileSync(path.join(OUT_DIR, 'app-types.json'), `${JSON.stringify({
	shellApiVersion: frozen.version,
	generated: new Date().toISOString(),
	generator: `dts-bundle-generator@${DBG.version}`,
}, null, '\t')}\n`);

console.log(`generate-app-types: shell.d.ts (frozen v${frozen.version}) -> ${OUT_DIR}`);
