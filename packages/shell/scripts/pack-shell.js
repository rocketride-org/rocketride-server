// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * pack-shell — builds the installable `shell.tgz` npm package.
 *
 * The tgz is the ONE artifact standalone consumers install: MF remote apps
 * use it types-only (runtime arrives as the host-served singleton), static
 * hosts (the vscode webviews, once out-of-repo) bundle its compiled code.
 *
 *   shell.tgz
 *     package.json   — name 'shell', version, exports map (barrel + the
 *                      sanctioned CSS entries — the enforcement travels)
 *     shell.d.ts     — the NEWEST FROZEN contract, verbatim (types entry)
 *     tokens.css     — the --rr-* design-token vocabulary
 *     dist/**        — per-file esbuild-transpiled ESM of src/** plus its
 *                      css/svg/asset files (consumers' bundlers resolve
 *                      extensionless relative imports; node never runs this)
 *
 * The filename is exactly `shell.tgz` (stable name, like shell.d.ts): the
 * version rides INSIDE the package, and identity is defined by the server
 * that serves it. The tgz lands in dist/server/static/clients/shell/ —
 * beside the python/typescript SDK packages — and the clients module
 * (ai/modules/clients) serves it at /client/shell.
 *
 * This script replaced generate-app-types outright: the tgz IS the type
 * bundle (shell.d.ts is its types entry), so no loose type files are
 * emitted or served anymore.
 *
 * Dependencies: real npm deps are copied through. 'shared' is dropped
 * (no longer imported by shell). 'rocketride' — the SDK the shell's
 * connection code wraps — is a BUNDLED dependency: the tgz carries the
 * in-repo build at node_modules/rocketride (npm's bundleDependencies),
 * so 'shell/client' always resolves to the SDK this server was built
 * with — the registry is never consulted. The SDK's own deps stay
 * ordinary registry deps. An app that wants a private SDK instance
 * declares its own 'rocketride' dependency and owns the divergence.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// =============================================================================
// PATHS + TOOLING
// =============================================================================

const APP_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(APP_ROOT, '..', '..');
const SRC_DIR = path.join(APP_ROOT, 'src');
const VERSIONS_DIR = path.join(APP_ROOT, 'contract', 'versions');
const BUILD_ROOT = process.env.ROCKETRIDE_BUILD_ROOT ?? path.join(REPO_ROOT, 'build');
const DIST_ROOT = process.env.ROCKETRIDE_DIST_ROOT ?? path.join(REPO_ROOT, 'dist');
const STAGE_DIR = path.join(BUILD_ROOT, 'shell-pkg');
// The tgz lands beside the other client SDK packages in the server's
// static tree; the clients module serves it at /client/shell.
const TGZ_DIR = path.join(DIST_ROOT, 'server', 'static', 'clients', 'shell');

// esbuild is a devDependency of the shell package itself, so it resolves
// through the normal module chain from this script's location.
const esbuild = require('esbuild');

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
	if (versions.length === 0) throw new Error(`pack-shell: no frozen shell-api versions in ${VERSIONS_DIR} — run ./builder shell:freeze first`);
	return { file: path.join(VERSIONS_DIR, `v${versions[0]}.d.ts`), version: versions[0] };
}

/**
 * Recursively lists every file under a directory.
 *
 * @param {string} dir - Directory to walk.
 * @param {string[]} [out] - Accumulator.
 * @returns {string[]} Absolute file paths.
 */
function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
	// step: fresh staging directory
	fs.rmSync(STAGE_DIR, { recursive: true, force: true });
	fs.mkdirSync(path.join(STAGE_DIR, 'dist'), { recursive: true });

	// step: split the source tree into transpile set (.ts/.tsx, not .d.ts)
	// and copy-through assets (css/svg/json/fonts/ambient d.ts)
	const files = walk(SRC_DIR);
	const toTranspile = files.filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'));
	const toCopy = files.filter((f) => !/\.tsx?$/.test(f) || f.endsWith('.d.ts'));

	// step: per-file ESM transpile (bundle:false keeps every import specifier
	// intact — the CONSUMER'S bundler resolves them, exactly like publishing
	// a compiled React component library)
	await esbuild.build({
		entryPoints: toTranspile,
		outdir: path.join(STAGE_DIR, 'dist'),
		outbase: SRC_DIR,
		format: 'esm',
		target: 'es2022',
		jsx: 'automatic',
		bundle: false,
		sourcemap: false,
		logLevel: 'error',
	});

	// step: copy assets preserving structure so the transpiled imports resolve
	for (const f of toCopy) {
		const rel = path.relative(SRC_DIR, f);
		const dest = path.join(STAGE_DIR, 'dist', rel);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(f, dest);
	}

	// step: the frozen contract IS the package's type surface; tokens.css is
	// its visual counterpart
	const frozen = newestFrozenContract();
	fs.copyFileSync(frozen.file, path.join(STAGE_DIR, 'shell.d.ts'));
	fs.copyFileSync(path.join(SRC_DIR, 'themes', 'rocketride-default.css'), path.join(STAGE_DIR, 'tokens.css'));

	// step: the shell/client subpath types — the SDK surface rides the
	// bundled rocketride package's own types, so the declaration is a
	// bare star re-export resolved against the copy vendored below
	fs.writeFileSync(path.join(STAGE_DIR, 'client.d.ts'), "export * from 'rocketride';\n");

	// step: vendor the in-repo SDK at node_modules/rocketride — its publish
	// file set (manifest + dist), exactly what `npm pack` would ship. The
	// bundleDependencies entry in the manifest below makes npm pack carry
	// this directory inside the tgz.
	const sdkRoot = path.join(REPO_ROOT, 'packages', 'client-typescript');
	if (!fs.existsSync(path.join(sdkRoot, 'dist', 'types', 'index.d.ts'))) throw new Error('pack-shell: packages/client-typescript/dist is missing — run ./builder client-typescript:build first');
	const sdkPkg = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
	const vendorDir = path.join(STAGE_DIR, 'node_modules', 'rocketride');
	fs.mkdirSync(vendorDir, { recursive: true });
	for (const f of ['package.json', 'README.md', 'LICENSE']) {
		if (fs.existsSync(path.join(sdkRoot, f))) fs.copyFileSync(path.join(sdkRoot, f), path.join(vendorDir, f));
	}
	fs.cpSync(path.join(sdkRoot, 'dist'), path.join(vendorDir, 'dist'), { recursive: true });

	// step: craft the published manifest from the workspace one — same name
	// and version, real deps only, exports locked to the barrel + sanctioned
	// CSS entries so barrel-only enforcement travels with the package
	const workspacePkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
	const dependencies = {};
	for (const [name, spec] of Object.entries(workspacePkg.dependencies ?? {})) {
		if (name === 'rocketride' || name === 'shared') continue;
		dependencies[name] = spec;
	}
	// The rocketride SDK is an implementation detail of the shell (the
	// connection code wraps it). It ships BUNDLED — the exact in-repo
	// build vendored above rides inside the tgz, so the guaranteed
	// shell/client surface can never drift from the serving server —
	// apps themselves never import 'rocketride'; the shell barrel is the
	// only door.
	dependencies['rocketride'] = sdkPkg.version;
	const manifest = {
		name: 'shell',
		version: workspacePkg.version,
		description: 'RocketRide shell — the frozen platform contract (types) + compiled stock library (static hosts)',
		license: 'MIT',
		main: './dist/index.js',
		module: './dist/index.js',
		types: './shell.d.ts',
		exports: {
			'.': { types: './shell.d.ts', default: './dist/index.js' },
			// The SDK surface, mediated by the shell — apps import runtime
			// values (Question, PROJECT_DIR, ...) from here, never from a
			// 'rocketride' dependency of their own.
			'./client': { types: './client.d.ts', default: './dist/client.js' },
			'./themes/rocketride-default.css': './dist/themes/rocketride-default.css',
			'./tokens.css': './tokens.css',
			'./package.json': './package.json',
		},
		dependencies,
		bundleDependencies: ['rocketride'],
		rocketride: {
			shellApiVersion: frozen.version,
			generated: new Date().toISOString(),
		},
	};
	fs.writeFileSync(path.join(STAGE_DIR, 'package.json'), `${JSON.stringify(manifest, null, '\t')}\n`);

	// step: pack under the STABLE name into the server's static clients
	// tree (served at /client/shell by the clients module). npm (not pnpm)
	// does the packing — its packlist is the reference implementation of
	// bundleDependencies, which carries node_modules/rocketride into the tgz.
	fs.mkdirSync(TGZ_DIR, { recursive: true });
	execFileSync('npm', ['pack', '--pack-destination', TGZ_DIR], { cwd: STAGE_DIR, stdio: 'pipe', shell: process.platform === 'win32' });
	const packed = fs.readdirSync(TGZ_DIR).find((f) => /^shell-.*\.tgz$/.test(f));
	if (!packed) throw new Error('pack-shell: npm pack produced no shell tarball');
	fs.rmSync(path.join(TGZ_DIR, 'shell.tgz'), { force: true });
	fs.renameSync(path.join(TGZ_DIR, packed), path.join(TGZ_DIR, 'shell.tgz'));

	const size = (fs.statSync(path.join(TGZ_DIR, 'shell.tgz')).size / 1024).toFixed(0);
	console.log(`pack-shell: shell.tgz (v${manifest.version}, contract v${frozen.version}, ${size} KB) -> ${TGZ_DIR}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
