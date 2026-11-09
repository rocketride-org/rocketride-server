// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { renderTemplate } from 'rocketride/app-scaffold';
import { adoptDeveloperId, adoptDeveloperIdInFolder, assertTargetFree, confirmedTargetOf, identityPathsOf } from '../appdev/adoptDeveloperId';
import type { AdoptDeveloperIdDeps } from '../appdev/adoptDeveloperId';

/** Writes the scaffold's real Blank template for `local.brandy` into a temp folder. */
function scaffoldLocalApp(): string {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-devid-'));
	const files = renderTemplate('Blank', {
		appId: 'local.brandy',
		appName: 'Brandy',
		publisher: 'local',
		moduleId: 'local_brandy',
		port: 3701,
		previewUrl: 'http://localhost:5565/?appid=local.brandy&rrdev=1',
	});
	for (const file of files) {
		const abs = path.join(folder, ...file.path.split('/'));
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, file.content);
	}
	return folder;
}

/** Every file under a folder, relative POSIX path to content. */
function snapshot(folder: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rel of fs.readdirSync(folder, { recursive: true }) as string[]) {
		const abs = path.join(folder, rel);
		if (fs.statSync(abs).isFile()) out[rel.split(path.sep).join('/')] = fs.readFileSync(abs, 'utf8');
	}
	return out;
}

/** Every form the old id takes in a scaffold: the id, the package name, the module id. */
const OLD_ID_RE = /local[._-]brandy/;

test('a freshly scaffolded local app moves into the namespace everywhere it names its id', () => {
	const folder = scaffoldLocalApp();
	const before = snapshot(folder);

	const result = adoptDeveloperIdInFolder(folder, 'local.brandy', 'acme');

	assert.equal(result.appId, 'acme.brandy');
	const after = snapshot(folder);
	const pkg = JSON.parse(after['package.json']);
	assert.equal(pkg.name, 'acme-brandy');
	assert.equal(pkg.appManifest.id, 'acme.brandy');
	assert.equal(pkg.appManifest.publisher, 'acme');
	assert.match(after['src/AppDescriptor.ts'], /id: 'acme\.brandy'/);
	assert.equal(JSON.parse(after['brandy.rrapp']).id, 'acme.brandy');
	// No file still names the old id, and only the three id carriers changed.
	for (const [rel, content] of Object.entries(after)) assert.doesNotMatch(content, OLD_ID_RE, rel);
	const changed = Object.keys(after)
		.filter((rel) => after[rel] !== before[rel])
		.sort();
	assert.deepEqual(changed, ['brandy.rrapp', 'package.json', 'src/AppDescriptor.ts']);
	assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
});

test('an app outside local is refused and nothing is written', () => {
	const folder = scaffoldLocalApp();
	const pkgPath = path.join(folder, 'package.json');
	fs.writeFileSync(pkgPath, fs.readFileSync(pkgPath, 'utf8').replace('"local.brandy"', '"other.brandy"'));
	const before = snapshot(folder);
	assert.throws(() => adoptDeveloperIdInFolder(folder, 'other.brandy', 'acme'), /Only an app under "local"/);
	assert.deepEqual(snapshot(folder), before);
});

test('a stale id is refused before any file is written', () => {
	const folder = scaffoldLocalApp();
	const pkgPath = path.join(folder, 'package.json');
	fs.writeFileSync(pkgPath, fs.readFileSync(pkgPath, 'utf8').replace('"local.brandy"', '"acme.brandy"'));
	const before = snapshot(folder);
	assert.throws(() => adoptDeveloperIdInFolder(folder, 'local.brandy', 'acme'), /no longer names this app/);
	assert.deepEqual(snapshot(folder), before);
});

test('a retry after a move that stopped before package.json finishes it', () => {
	const folder = scaffoldLocalApp();
	// The trigger and descriptor were rewritten, package.json was not.
	fs.writeFileSync(path.join(folder, 'brandy.rrapp'), '{\n  "id": "acme.brandy"\n}\n');
	const descriptorPath = path.join(folder, 'src', 'AppDescriptor.ts');
	fs.writeFileSync(descriptorPath, fs.readFileSync(descriptorPath, 'utf8').replace("'local.brandy'", "'acme.brandy'"));

	const result = adoptDeveloperIdInFolder(folder, 'local.brandy', 'acme');

	assert.deepEqual(result.changes, ['package.json: app id local.brandy -> acme.brandy', 'package.json: publisher local -> acme', 'package.json: package name local-brandy -> acme-brandy']);
	for (const [rel, content] of Object.entries(snapshot(folder))) assert.doesNotMatch(content, OLD_ID_RE, rel);
});

// Root ignores file modes, and Windows ignores directory modes, so the failed write cannot be staged there.
test('a write that fails part way leaves package.json on the old id and no temp file', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
	const folder = scaffoldLocalApp();
	const src = path.join(folder, 'src');
	fs.chmodSync(src, 0o555);
	try {
		assert.throws(() => adoptDeveloperIdInFolder(folder, 'local.brandy', 'acme'));
		assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')).appManifest.id, 'local.brandy');
		assert.deepEqual(
			Object.keys(snapshot(folder)).filter((rel) => rel.endsWith('.tmp')),
			[]
		);
	} finally {
		fs.chmodSync(src, 0o755);
	}
	assert.equal(adoptDeveloperIdInFolder(folder, 'local.brandy', 'acme').appId, 'acme.brandy');
	for (const [rel, content] of Object.entries(snapshot(folder))) assert.doesNotMatch(content, OLD_ID_RE, rel);
});

test('package.json is replaced in one step, keeping its mode', { skip: process.platform === 'win32' }, () => {
	const folder = scaffoldLocalApp();
	const pkgPath = path.join(folder, 'package.json');
	fs.chmodSync(pkgPath, 0o640);
	const inode = fs.statSync(pkgPath).ino;
	adoptDeveloperIdInFolder(folder, 'local.brandy', 'acme');
	assert.notEqual(fs.statSync(pkgPath).ino, inode, 'a rename puts a new file in place');
	assert.equal(fs.statSync(pkgPath).mode & 0o777, 0o640);
});

test('the move goes only to the developer id the user confirmed and the server still reports', () => {
	assert.equal(confirmedTargetOf('local.brandy', 'acme', 'acme'), 'acme.brandy');
	assert.throws(() => confirmedTargetOf('local.brandy', 'acme', ''), /has no developer id yet/);
	assert.throws(() => confirmedTargetOf('local.brandy', 'acme', 'acme_labs'), /is now "acme_labs", not "acme"/);
	assert.throws(() => confirmedTargetOf('other.brandy', 'acme', 'acme'), /Only an app under "local"/);
});

test('the move is refused onto an id in use in the workspace or on the server, or over unsaved edits', () => {
	const free = { workspaceIds: ['local.brandy', 'acme.other'], deployedVersions: 0, dirtyFiles: [] };
	assert.doesNotThrow(() => assertTargetFree('acme.brandy', free));
	assert.throws(() => assertTargetFree('acme.brandy', { ...free, workspaceIds: ['local.brandy', 'acme.brandy'] }), /Another app in this workspace already has the id "acme\.brandy"/);
	assert.throws(() => assertTargetFree('acme.brandy', { ...free, deployedVersions: 2 }), /already has an app "acme\.brandy" on the server/);
	assert.throws(() => assertTargetFree('acme.brandy', { ...free, dirtyFiles: [path.join('x', 'package.json')] }), /Save or revert your changes to package\.json first/);
});

test('identityPathsOf names the files a move may rewrite', () => {
	const folder = path.join(os.tmpdir(), 'brandy-ui');
	assert.deepEqual(identityPathsOf(folder, 'local.brandy'), {
		packageJson: path.join(folder, 'package.json'),
		trigger: path.join(folder, 'brandy.rrapp'),
		descriptor: path.join(folder, 'src', 'AppDescriptor.ts'),
	});
});

/** Host stand-ins for {@link adoptDeveloperId}: a free target by default. */
function deps(folder: string, over: Partial<AdoptDeveloperIdDeps> = {}): AdoptDeveloperIdDeps {
	return {
		developerStatus: async () => 'acme',
		versionsOf: async () => 0,
		scan: async () => [{ id: 'local.brandy', folder }],
		dirtyPaths: () => [],
		...over,
	};
}

test('adoptDeveloperId moves the app once every check passes', async () => {
	const folder = scaffoldLocalApp();
	const asked: string[] = [];
	const result = await adoptDeveloperId('local.brandy', 'acme', deps(folder, { versionsOf: async (id) => (asked.push(id), 0) }));
	assert.equal(result.appId, 'acme.brandy');
	assert.equal(result.folder, folder);
	assert.deepEqual(asked, ['acme.brandy']);
	for (const [rel, content] of Object.entries(snapshot(folder))) assert.doesNotMatch(content, OLD_ID_RE, rel);
});

test('adoptDeveloperId: every refusal leaves the app folder byte for byte as it was', async () => {
	const cases: Array<[string, (folder: string) => Partial<AdoptDeveloperIdDeps>, RegExp]> = [
		['no developer id on the server', () => ({ developerStatus: async () => '' }), /has no developer id yet/],
		['a different developer id on the server', () => ({ developerStatus: async () => 'acme_labs' }), /is now "acme_labs"/],
		['the app is not in the workspace', () => ({ scan: async () => [] }), /has no bound folder/],
		[
			'another workspace app has the new id',
			(folder) => ({
				scan: async () => [
					{ id: 'local.brandy', folder },
					{ id: 'acme.brandy', folder: path.join(folder, 'x') },
				],
			}),
			/Another app in this workspace/,
		],
		['the server holds versions under the new id', () => ({ versionsOf: async () => 3 }), /already has an app "acme\.brandy" on the server/],
		['package.json has unsaved edits', () => ({ dirtyPaths: (paths) => paths.filter((p) => p.endsWith('package.json')) }), /Save or revert your changes to package\.json/],
		['src/AppDescriptor.ts has unsaved edits', () => ({ dirtyPaths: (paths) => paths.filter((p) => p.endsWith('AppDescriptor.ts')) }), /AppDescriptor\.ts first/],
		[
			'the server check times out',
			() => ({
				versionsOf: async () => {
					throw new Error('Request timed out');
				},
			}),
			/timed out/,
		],
	];
	for (const [name, over, reason] of cases) {
		const folder = scaffoldLocalApp();
		const before = snapshot(folder);
		await assert.rejects(() => adoptDeveloperId('local.brandy', 'acme', deps(folder, over(folder))), reason, name);
		assert.deepEqual(snapshot(folder), before, name);
	}
});
