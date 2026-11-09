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
import { adoptDeveloperIdInFolder, assertTargetFree, confirmedTargetOf, identityPathsOf } from '../appdev/adoptDeveloperId';

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
	for (const [rel, content] of Object.entries(after)) assert.doesNotMatch(content, /local\.brandy|local-brandy/, rel);
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
	for (const [rel, content] of Object.entries(snapshot(folder))) assert.doesNotMatch(content, /local\.brandy|local-brandy/, rel);
});

// Root ignores file modes, so the failed write cannot be staged there.
test('a write that fails part way leaves package.json on the old id', { skip: process.getuid?.() === 0 }, () => {
	const folder = scaffoldLocalApp();
	const descriptorPath = path.join(folder, 'src', 'AppDescriptor.ts');
	fs.chmodSync(descriptorPath, 0o444);
	try {
		assert.throws(() => adoptDeveloperIdInFolder(folder, 'local.brandy', 'acme'));
		assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')).appManifest.id, 'local.brandy');
	} finally {
		fs.chmodSync(descriptorPath, 0o644);
	}
	assert.equal(adoptDeveloperIdInFolder(folder, 'local.brandy', 'acme').appId, 'acme.brandy');
	for (const [rel, content] of Object.entries(snapshot(folder))) assert.doesNotMatch(content, /local\.brandy|local-brandy/, rel);
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
