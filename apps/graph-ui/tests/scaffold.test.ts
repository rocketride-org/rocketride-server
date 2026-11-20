// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// GRAPH-UI - SCAFFOLD CONTRACT
// =============================================================================
//
// What the app family's consistency audit (scripts/lib/uiAudit.js) and the
// registration step (scripts/lib/registerApp.js) require of an app, checked
// from inside the app's own suite so a drift fails graph-ui:test as well as
// ui:audit.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
const sqlPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'apps', 'sql-ui', 'package.json'), 'utf8'));

/** Strip CR so the comparison is line-ending independent (matches uiAudit). */
function readLf(file: string): string {
	return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

test('manifest identity: id, name, module federation container name', () => {
	assert.equal(pkg.appManifest.id, 'rocketride.graph');
	assert.equal(pkg.appManifest.name, 'Graph Explorer');
	// The MF container name is derived from the id exactly as rsbuild.config.mts does.
	assert.equal(pkg.appManifest.id.replace(/[^a-zA-Z0-9_$]/g, '_'), 'rocketride_graph');
	assert.match(pkg.appManifest.projectId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('manifest ships the README and the icon exists', () => {
	// registerApp only copies the README when appManifest.readme is set.
	assert.equal(pkg.appManifest.readme, './README.md');
	assert.ok(fs.existsSync(path.join(APP_ROOT, pkg.appManifest.readme)), 'README.md must exist');
	assert.ok(fs.existsSync(path.join(APP_ROOT, pkg.appManifest.icon)), 'icon must exist');
});

test('rsbuild.config.mts renders byte-for-byte from the canonical template', () => {
	const template = readLf(path.join(REPO_ROOT, 'scripts', 'assets', 'rsbuild-app-config.template'));
	const config = readLf(path.join(APP_ROOT, 'rsbuild.config.mts'));
	const title = config.match(/\n\/\/ =+\n\/\/ (.+)\n\/\/ =+\n/);
	const hint = config.match(/Run (\S+) for development/);
	const port = config.match(/port: (\d+)/);
	assert.ok(title && hint && port, 'header title, dev hint and port must be present');
	const rendered = template
		.split('{{TITLE}}')
		.join(title[1])
		.split('{{DEVHINT}}')
		.join(hint[1])
		.split('{{PORT}}')
		.join(port[1])
		.split('{{DEVBLOCK}}')
		.join('');
	assert.equal(config, rendered);
	assert.equal(port[1], '3102');
});

test('dev port is unique across the app family', () => {
	const appsDir = path.join(REPO_ROOT, 'apps');
	const claims: string[] = [];
	for (const name of fs.readdirSync(appsDir)) {
		if (name === 'graph-ui') continue;
		const cfg = path.join(appsDir, name, 'rsbuild.config.mts');
		if (!fs.existsSync(cfg)) continue;
		const m = readLf(cfg).match(/port: (\d+)/);
		if (m) claims.push(m[1]);
	}
	assert.ok(!claims.includes('3102'), 'port 3102 is already claimed by another app');
});

test('manifest hygiene matches the family contract', () => {
	assert.equal(pkg.license, 'MIT');
	for (const script of ['build', 'build:prod', 'dev', 'typecheck']) assert.ok(pkg.scripts[script], `missing script ${script}`);
	assert.deepEqual(pkg.browserslist, sqlPkg.browserslist, 'browserslist must equal the family floor (never changed per app)');
});

test('shared dependencies declare the same range as sql-ui', () => {
	// ui:audit fails when one dependency has two ranges anywhere in the family.
	for (const section of ['dependencies', 'devDependencies'] as const) {
		for (const [dep, range] of Object.entries(pkg[section] as Record<string, string>)) {
			for (const sqlSection of ['dependencies', 'devDependencies'] as const) {
				const other = sqlPkg[sqlSection]?.[dep];
				if (other !== undefined) assert.equal(range, other, `${dep}: ${range} vs sql-ui ${other}`);
			}
		}
	}
});

test('the remote exposes only the AppDescriptor and keeps the async boundary', () => {
	const config = readLf(path.join(APP_ROOT, 'rsbuild.config.mts'));
	assert.match(config, /'\.\/AppDescriptor': '\.\/src\/AppDescriptor\.ts'/);
	assert.equal((config.match(/exposes:/g) || []).length, 1);
	const index = readLf(path.join(APP_ROOT, 'src', 'index.ts'));
	assert.match(index, /import\('\.\/AppDescriptor'\)/);
});

test('the .rrapp marker is the contentless trigger file', () => {
	assert.equal(fs.readFileSync(path.join(APP_ROOT, 'graph.rrapp'), 'utf8').trim(), '{}');
});

// The app imports the shared Explorer library (`shared/*`, resolved through tsconfig paths). The App Builder
// and `rocketride app deploy` pack only the app folder plus the manifest's include roots, so without
// "include": ["apps/shared"] a server build cannot resolve 'shared/explorer'.
test('an app that imports shared/* declares apps/shared in appManifest.include, as explorer-ui does', () => {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const name of fs.readdirSync(dir)) {
			const full = path.join(dir, name);
			if (fs.statSync(full).isDirectory()) walk(full);
			else if (/\.(ts|tsx)$/.test(name)) files.push(full);
		}
	};
	walk(path.join(APP_ROOT, 'src'));
	const importsShared = files.some((file) => /from '(shared\/[^']+)'/.test(fs.readFileSync(file, 'utf8')));
	assert.ok(importsShared, 'the premise: src imports shared/*');
	assert.deepEqual(pkg.appManifest.include, ['apps/shared']);
	const explorer = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'apps', 'explorer-ui', 'package.json'), 'utf8'));
	assert.deepEqual(explorer.appManifest.include, ['apps/shared'], 'the format other apps use');
});

// README.md is the app's readme (appManifest.readme): registerApp serves it on its own, without
// the repository around it, so a repo-relative link (../../docs, ../../nodes, templates/, docs/contrast.md) is
// broken on the app's page, and the templates it described as shipping "with the app" are not served at all.
test('the README served with the app links only to absolute URLs or its own headings, and says how to get a template', () => {
	const readme = fs.readFileSync(path.join(APP_ROOT, 'README.md'), 'utf8');
	const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
	assert.ok(links.length > 0, 'the premise: the README links somewhere');
	const anchors = new Set([...readme.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1].trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')));
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
	assert.ok(links.includes(`${repo}tree/develop/apps/graph-ui/templates`), 'the templates are linked where they live');
	assert.ok(/not installed with the app/.test(readme), 'and the README says they do not come with it');
});
