// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SCAFFOLD: the app is a standard member of the Explorer app family
// =============================================================================
//
// Pins what the App Builder, `ui:audit` and the shell rely on: the manifest
// (the launcher card is built from it), the module federation remote, the dev
// port, the dependency ranges the family shares, the builder tasks and the
// README served with the app. `ui:audit` is red on the base for rows that are
// not this app's, so the rules it applies are mirrored here for vector-ui only.
// =============================================================================

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
// sql-ui: the other Explorer app in this checkout, the family member the shared rules are read from.
const sqlPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'apps', 'sql-ui', 'package.json'), 'utf8'));

/** Strip CR so the comparison is line-ending independent (matches uiAudit). */
function readLf(file: string): string {
	return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** Every app package.json of the family except this one. */
function familyPackages(): Array<{ name: string; pkg: Record<string, Record<string, string>> }> {
	const out: Array<{ name: string; pkg: Record<string, Record<string, string>> }> = [];
	for (const name of fs.readdirSync(path.join(REPO_ROOT, 'apps'))) {
		if (name === 'vector-ui') continue;
		const file = path.join(REPO_ROOT, 'apps', name, 'package.json');
		if (fs.existsSync(file)) out.push({ name, pkg: JSON.parse(fs.readFileSync(file, 'utf8')) });
	}
	return out;
}

test('manifest identity: id, name, publisher, description and the module federation container name', () => {
	const m = pkg.appManifest;
	assert.equal(pkg.name, '@rocketride/vector-ui');
	assert.equal(m.id, 'rocketride.vector');
	assert.equal(m.name, 'Vector Explorer');
	assert.equal(m.publisher, 'Aparavi Software AG');
	assert.equal(m.description, 'Manage and visualise the documents in a vector store through pipeline store nodes');
	assert.equal(m.id.replace(/[^a-zA-Z0-9_$]/g, '_'), 'rocketride_vector');
	// A version 4 uuid of its own: not any other app's.
	assert.match(m.projectId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	for (const other of familyPackages()) assert.notEqual(other.pkg.appManifest?.projectId, m.projectId, `projectId is also ${other.name}'s`);
});

test('the launcher card: categories, mode, sign-in, status bar, shared library include, README and icon', () => {
	const m = pkg.appManifest;
	// `devTool` lists it among the hosts' dev tools (VS Code, rocket-ui); `tools` keeps its launcher card.
	assert.deepEqual(m.categories, ['tools', 'devTool']);
	assert.equal(m.mode, 'free');
	assert.equal(m.authenticated, true);
	assert.equal(m.showStatusBar, true);
	assert.deepEqual(m.include, ['apps/shared']);
	// registerApp only copies the README when appManifest.readme is set.
	assert.equal(m.readme, './README.md');
	assert.equal(m.icon, './src/icon.svg');
	assert.ok(fs.existsSync(path.join(APP_ROOT, m.readme)), 'README.md must exist');
	const icon = fs.readFileSync(path.join(APP_ROOT, m.icon), 'utf8');
	assert.match(icon, /^<svg[^>]+viewBox="0 0 192 192"/, 'a 192px-grid svg like the other launcher icons');
	assert.doesNotMatch(icon, /<script|on[a-z]+=|href=/i, 'the icon carries no script, handler or link');
});

test('rsbuild.config.mts renders byte-for-byte from the canonical template, on port 3103', () => {
	const template = readLf(path.join(REPO_ROOT, 'scripts', 'assets', 'rsbuild-app-config.template'));
	const config = readLf(path.join(APP_ROOT, 'rsbuild.config.mts'));
	const title = config.match(/\n\/\/ =+\n\/\/ (.+)\n\/\/ =+\n/);
	const hint = config.match(/Run (\S+) for development/);
	const port = config.match(/port: (\d+)/);
	assert.ok(title && hint && port, 'header title, dev hint and port must be present');
	const rendered = template.split('{{TITLE}}').join(title[1]).split('{{DEVHINT}}').join(hint[1]).split('{{PORT}}').join(port[1]).split('{{DEVBLOCK}}').join('');
	assert.equal(config, rendered);
	assert.equal(port[1], '3103');
	assert.match(title[1], /^VECTOR-UI/);
});

test('dev port 3103 is claimed by no other app of the family', () => {
	const appsDir = path.join(REPO_ROOT, 'apps');
	for (const name of fs.readdirSync(appsDir)) {
		if (name === 'vector-ui') continue;
		const cfg = path.join(appsDir, name, 'rsbuild.config.mts');
		if (!fs.existsSync(cfg)) continue;
		assert.notEqual(readLf(cfg).match(/port: (\d+)/)?.[1], '3103', `${name} claims port 3103`);
	}
});

test('manifest hygiene matches the family contract: license, scripts, the canonical browser floor', () => {
	assert.equal(pkg.license, 'MIT');
	assert.equal(pkg.private, true);
	for (const script of ['build', 'build:prod', 'dev', 'typecheck', 'typecheck:tests']) assert.ok(pkg.scripts[script], `missing script ${script}`);
	assert.equal(pkg.scripts.typecheck, 'tsc --noEmit');
	assert.equal(pkg.scripts['typecheck:tests'], 'tsc -p tsconfig.test.json --noEmit');
	assert.deepEqual(pkg.browserslist, ['chrome >= 81', 'edge >= 83', 'firefox >= 76', 'safari >= 13']);
	assert.deepEqual(pkg.browserslist, sqlPkg.browserslist, 'browserslist equals the family floor (never changed per app)');
});

test('dependencies: exactly the Explorer set, no 3D or windowing library', () => {
	assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@module-federation/rsbuild-plugin', 'd3', 'd3-force', 'react', 'react-dom', 'rocketride', 'shell']);
	assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@rsbuild/core', '@rsbuild/plugin-react', '@types/d3', '@types/d3-force', '@types/react', '@types/react-dom', 'tsx', 'typescript']);
	assert.equal(pkg.dependencies.rocketride, 'workspace:*');
	assert.equal(pkg.dependencies.shell, 'file:../../.rocketride/shell/shell.tgz');
	assert.equal(pkg.dependencies.d3, '~7.9.0');
	assert.equal(pkg.devDependencies['@types/d3'], '~7.4.3');
	for (const banned of ['three', 'react-window', '@react-three/fiber', 'monaco-editor']) {
		assert.equal(pkg.dependencies[banned] ?? pkg.devDependencies[banned], undefined, `${banned} is not a dependency`);
	}
});

test('every dependency declares the same range as everywhere else in the family (the ui:audit rule)', () => {
	// ui:audit fails when one dependency has two ranges anywhere in the family.
	const ranges = new Map<string, Set<string>>();
	for (const { pkg: other } of familyPackages()) {
		for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
			for (const [dep, range] of Object.entries(other[section] ?? {})) {
				if (!ranges.has(dep)) ranges.set(dep, new Set());
				ranges.get(dep)!.add(range);
			}
		}
	}
	let compared = 0;
	for (const section of ['dependencies', 'devDependencies'] as const) {
		for (const [dep, range] of Object.entries(pkg[section] as Record<string, string>)) {
			const seen = ranges.get(dep);
			if (!seen) continue;
			compared += 1;
			assert.ok(seen.has(range), `${dep}: ${range}, the family declares ${[...seen].join(' / ')}`);
		}
	}
	assert.ok(compared >= 10, `the premise: the family declares most of these (${compared})`);
});

test('the remote exposes only the AppDescriptor and keeps the async boundary', () => {
	const config = readLf(path.join(APP_ROOT, 'rsbuild.config.mts'));
	assert.match(config, /'\.\/AppDescriptor': '\.\/src\/AppDescriptor\.ts'/);
	assert.equal((config.match(/exposes:/g) || []).length, 1);
	const index = readLf(path.join(APP_ROOT, 'src', 'index.ts'));
	assert.match(index, /import\('\.\/AppDescriptor'\)/);
});

test('the descriptor: id and name from the manifest, the app root, and a sidebar that opens collapsed', () => {
	const descriptor = readLf(path.join(APP_ROOT, 'src', 'AppDescriptor.ts'));
	assert.match(descriptor, /id: 'rocketride\.vector'/);
	assert.match(descriptor, /name: 'Vector Explorer'/);
	assert.match(descriptor, /app: VectorApp/);
	assert.match(descriptor, /sidebar: 'collapsed'/);
	assert.match(descriptor, /import VectorApp from '\.\/VectorApp'/);
});

test('the .rrapp marker is the contentless trigger file', () => {
	assert.equal(fs.readFileSync(path.join(APP_ROOT, 'vector.rrapp'), 'utf8').trim(), '{}');
});

test('tsconfig resolves shared/* to the shared library, and the test program adds tests/ with Node types', () => {
	const tsconfig = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'tsconfig.json'), 'utf8'));
	assert.deepEqual(tsconfig.compilerOptions.paths, { 'shared/*': ['../shared/src/*'] });
	assert.equal(tsconfig.compilerOptions.strict, true);
	const testConfig = readLf(path.join(APP_ROOT, 'tsconfig.test.json'));
	assert.match(testConfig, /"extends": "\.\/tsconfig\.json"/);
	assert.match(testConfig, /"tests\/\*\*\/\*\.ts"/);
	assert.match(testConfig, /"node"/);
});

// The stub is graph-ui's (feat/graph-explorer), byte for byte. graph-ui is not in every checkout, so its bytes
// are pinned here; sql-ui's stub is the same code under its own comments, and the code is held to it.
const FAMILY_STUB_SHA256 = '5013f9a1cd313f860c6285026db5e6acbaac552a42270e5960c2228b1b536ddd';

/** A script's code without its comments and blank lines. */
function codeOf(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((line) => line.trim() && !line.trim().startsWith('//'))
		.join('\n');
}

test("the platform stub the tests load is the Explorer family's, unchanged", () => {
	const stub = readLf(path.join(APP_ROOT, 'scripts', 'stub-shell.cjs'));
	assert.equal(createHash('sha256').update(stub).digest('hex'), FAMILY_STUB_SHA256, "graph-ui's stub, byte for byte");
	assert.equal(codeOf(stub), codeOf(readLf(path.join(REPO_ROOT, 'apps', 'sql-ui', 'scripts', 'stub-shell.cjs'))), "sql-ui's stub code");
});

// The app imports the shared Explorer library (`shared/*`, resolved through tsconfig paths). The App Builder and
// `rocketride app deploy` pack only the app folder plus the manifest's include roots, so without
// "include": ["apps/shared"] a server build cannot resolve 'shared/explorer'.
test('an app that imports shared/* declares apps/shared in appManifest.include', () => {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const name of fs.readdirSync(dir)) {
			const full = path.join(dir, name);
			if (fs.statSync(full).isDirectory()) walk(full);
			else if (/\.(ts|tsx)$/.test(name)) files.push(full);
		}
	};
	walk(path.join(APP_ROOT, 'src'));
	assert.ok(
		files.some((file) => /from '(shared\/[^']+)'/.test(fs.readFileSync(file, 'utf8'))),
		'the premise: src imports shared/*'
	);
	assert.deepEqual(pkg.appManifest.include, ['apps/shared']);
});

// README.md is the app's readme (appManifest.readme): registerApp serves it on its own, without the repository
// around it, so a repo-relative link is broken on the app's page.
test('the README served with the app links only to absolute URLs or its own headings, and says how to get a template', () => {
	const readme = fs.readFileSync(path.join(APP_ROOT, 'README.md'), 'utf8');
	const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
	assert.ok(links.length > 0, 'the premise: the README links somewhere');
	const anchors = new Set(
		[...readme.matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
			m[1]
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9 -]/g, '')
				.replace(/ /g, '-')
		)
	);
	const repo = 'https://github.com/rocketride-org/rocketride-server/';
	for (const link of links) {
		if (link.startsWith('#')) {
			assert.ok(anchors.has(link.slice(1)), `${link} names a heading of the README`);
			continue;
		}
		assert.ok(/^https:\/\//.test(link), `${link} is not an absolute URL`);
		if (link.startsWith(repo)) {
			const file = link.slice(repo.length).replace(/^(blob|tree)\/develop\//, '');
			assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), `${link} names ${file}, which is not in the repository`);
		}
	}
	assert.ok(links.includes(`${repo}tree/develop/apps/vector-ui/templates`), 'the templates are linked where they live');
	assert.ok(/not installed with the app/.test(readme), 'and the README says they do not come with it');
});

test("the README and the user guide give Qdrant's own neighbour graph the driver's sample limit", () => {
	const driver = fs.readFileSync(path.join(REPO_ROOT, 'nodes', 'src', 'nodes', 'store_qdrant', 'qdrant.py'), 'utf8');
	const max = /^\s*NATIVE_KNN_MAX = (\d+)\s*$/m.exec(driver);
	assert.ok(max, 'the premise: the driver names its limit');
	const limit = `up to ${Number(max[1]).toLocaleString('en-US')} points`;
	for (const doc of ['apps/vector-ui/README.md', 'docs/public/product/guides/apps/vector-explorer.md']) {
		const paragraphs = fs
			.readFileSync(path.join(REPO_ROOT, doc), 'utf8')
			.split(/\n\s*\n/)
			.map((paragraph) => paragraph.replace(/\s+/g, ' '));
		const about = paragraphs.filter((paragraph) => /computed by Qdrant/.test(paragraph));
		assert.ok(about.length > 0, `${doc} says when Qdrant computes the neighbour graph`);
		for (const paragraph of about) {
			assert.ok(paragraph.includes(limit), `${doc}: "${paragraph.slice(0, 120)}…" names the limit (${limit})`);
			assert.match(paragraph, /store node/, `${doc}: and that a larger sample gets the store node's graph`);
		}
	}
});

test('the labeler tags a change under apps/vector-ui as a UI change', () => {
	const labeler = readLf(path.join(REPO_ROOT, '.github', 'labeler.yml'));
	const ui = labeler.slice(labeler.indexOf('module:ui:'), labeler.indexOf('\n\n', labeler.indexOf('module:ui:')));
	assert.match(ui, /"apps\/vector-ui\/\*\*"/);
});

/**
 * The importer block of one workspace package in pnpm-lock.yaml, as section -> dependency -> specifier.
 *
 * @param lock - The lockfile text.
 * @param importer - The importer path, e.g. 'apps/vector-ui'.
 * @returns The specifiers, or null when the lockfile has no such importer.
 */
function importerSpecifiers(lock: string, importer: string): Record<string, Record<string, string>> | null {
	const start = lock.indexOf(`\n  ${importer}:\n`);
	if (start < 0) return null;
	const end = lock.indexOf('\n\n', start + 1);
	const out: Record<string, Record<string, string>> = {};
	let section = '';
	let dep = '';
	for (const line of lock
		.slice(start + 1, end < 0 ? undefined : end)
		.split('\n')
		.slice(1)) {
		const sectionMatch = /^ {4}([a-zA-Z]+):$/.exec(line);
		if (sectionMatch) {
			section = sectionMatch[1];
			out[section] = {};
			continue;
		}
		const depMatch = /^ {6}'?([^':]+)'?:$/.exec(line);
		if (depMatch) {
			dep = depMatch[1];
			continue;
		}
		const specMatch = /^ {8}specifier: (.+)$/.exec(line);
		if (specMatch && section && dep) out[section][dep] = specMatch[1].replace(/^'|'$/g, '');
	}
	return out;
}

test("the lockfile has an importer for apps/vector-ui with exactly the manifest's specifiers", () => {
	const lock = readLf(path.join(REPO_ROOT, 'pnpm-lock.yaml'));
	const importer = importerSpecifiers(lock, 'apps/vector-ui');
	assert.ok(importer, 'pnpm-lock.yaml lists apps/vector-ui (pnpm install adds it)');
	// pnpm-workspace.yaml overrides shell and rocketride to the in-tree workspace packages.
	const overridden = new Set(['shell', 'rocketride']);
	for (const section of ['dependencies', 'devDependencies'] as const) {
		const expected = Object.fromEntries(Object.entries(pkg[section] as Record<string, string>).map(([dep, range]) => [dep, overridden.has(dep) ? 'workspace:*' : range]));
		assert.deepEqual(importer[section], expected, section);
	}
	assert.deepEqual(importerSpecifiers(lock, 'apps/sql-ui')?.dependencies?.shell, 'workspace:*', 'the premise: sql-ui reads the same way');
});
