// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adoptedAppId, rewriteAppIdentity } from './namespaceAdoption';

/** package.json as the scaffold writes it for `local.brandy` (two-space indent). */
const scaffoldPkg = `${JSON.stringify(
	{
		name: 'local-brandy',
		version: '0.1.0',
		private: true,
		appManifest: { id: 'local.brandy', publisher: 'local', name: 'Brandy', projectId: 'p-1', icon: './icon.svg' },
		scripts: { dev: 'rsbuild dev' },
	},
	null,
	2
)}\n`;

const descriptor = "const descriptor: AppDescriptor = {\n\tid: 'local.brandy',\n\tname: 'Brandy',\n\tapp: App,\n};\n";

test('adoptedAppId: a local app moves to the developer namespace, keeping its name', () => {
	assert.equal(adoptedAppId('local.brandy', 'acme'), 'acme.brandy');
	assert.equal(adoptedAppId('local.s3-explorer', 'acme_labs'), 'acme_labs.s3-explorer');
});

test('adoptedAppId: nothing to move outside local, or without a usable developer id', () => {
	assert.equal(adoptedAppId('other.brandy', 'acme'), null);
	assert.equal(adoptedAppId('localx.brandy', 'acme'), null);
	assert.equal(adoptedAppId('local.', 'acme'), null);
	assert.equal(adoptedAppId('local', 'acme'), null);
	assert.equal(adoptedAppId('local.brandy', ''), null);
	assert.equal(adoptedAppId('local.brandy', null), null);
	assert.equal(adoptedAppId('local.brandy', 'local'), null);
	assert.equal(adoptedAppId('local.brandy', 'Acme'), null);
});

test('rewriteAppIdentity: a scaffolded app gets the new id, publisher and package name, nothing else', () => {
	const result = rewriteAppIdentity({ packageJson: scaffoldPkg, trigger: '{\n  "id": "local.brandy"\n}\n', descriptor }, 'local.brandy', 'acme.brandy');
	const pkg = JSON.parse(result.files.packageJson as string);
	assert.equal(pkg.name, 'acme-brandy');
	assert.deepEqual(pkg.appManifest, { id: 'acme.brandy', publisher: 'acme', name: 'Brandy', projectId: 'p-1', icon: './icon.svg' });
	assert.deepEqual(Object.keys(pkg), ['name', 'version', 'private', 'appManifest', 'scripts']);
	assert.equal(result.files.packageJson, scaffoldPkg.replace('local-brandy', 'acme-brandy').replace('"local.brandy"', '"acme.brandy"').replace('"publisher": "local"', '"publisher": "acme"'));
	assert.equal(result.files.trigger, '{\n  "id": "acme.brandy"\n}\n');
	assert.equal(result.files.descriptor, descriptor.replace("'local.brandy'", "'acme.brandy'"));
	assert.equal(result.changes.length, 5);
});

test('rewriteAppIdentity: a hand-picked publisher and package name stay, tab indent and no final newline are kept', () => {
	const pkg = JSON.stringify({ name: 'brandy-app', appManifest: { id: 'local.brandy', publisher: 'Brandy Co' } }, null, '\t');
	const result = rewriteAppIdentity({ packageJson: pkg }, 'local.brandy', 'acme.brandy');
	assert.equal(result.files.packageJson, JSON.stringify({ name: 'brandy-app', appManifest: { id: 'acme.brandy', publisher: 'Brandy Co' } }, null, '\t'));
	assert.deepEqual(result.changes, ['package.json: app id local.brandy -> acme.brandy']);
});

test('rewriteAppIdentity: a contentless or non-JSON trigger and a descriptor without the id are left alone', () => {
	const other = 'export default { id: \'local.brandy2\', note: "local.brandy is the old id" };\n';
	for (const trigger of ['{}\n', '', 'not json']) {
		const result = rewriteAppIdentity({ packageJson: scaffoldPkg, trigger, descriptor: other }, 'local.brandy', 'acme.brandy');
		assert.equal(result.files.trigger, undefined);
		assert.equal(result.files.descriptor, undefined);
	}
});

test('rewriteAppIdentity: every quote style of the id literal is rewritten', () => {
	const text = 'a = "local.brandy"; b = `local.brandy`; c = \'local.brandy\';\n';
	const result = rewriteAppIdentity({ packageJson: scaffoldPkg, descriptor: text }, 'local.brandy', 'acme.brandy');
	assert.equal(result.files.descriptor, 'a = "acme.brandy"; b = `acme.brandy`; c = \'acme.brandy\';\n');
});

test('rewriteAppIdentity: refuses when package.json no longer names the app', () => {
	const moved = scaffoldPkg.replace('"local.brandy"', '"acme.brandy"');
	assert.throws(() => rewriteAppIdentity({ packageJson: moved }, 'local.brandy', 'acme.brandy'), /no longer names this app "local.brandy"/);
	assert.throws(() => rewriteAppIdentity({ packageJson: '{"name":"x"}' }, 'local.brandy', 'acme.brandy'), /no longer names/);
});

test('rewriteAppIdentity: a package.json that is not JSON gets a plain reason, not a parser error', () => {
	assert.throws(() => rewriteAppIdentity({ packageJson: '{ "name": ' }, 'local.brandy', 'acme.brandy'), /^Error: package\.json is not valid JSON, so the app id cannot be changed/);
});

test("rewriteAppIdentity: CRLF line endings and the trigger's own indentation are kept", () => {
	const crlfPkg = scaffoldPkg.replace(/\n/g, '\r\n');
	const trigger = '{\r\n\t"id": "local.brandy"\r\n}\r\n';
	const result = rewriteAppIdentity({ packageJson: crlfPkg, trigger }, 'local.brandy', 'acme.brandy');
	assert.equal(result.files.packageJson?.includes('\n'), true);
	assert.doesNotMatch(result.files.packageJson as string, /[^\r]\n/);
	assert.match(result.files.packageJson as string, /\r\n$/);
	assert.equal(result.files.trigger, '{\r\n\t"id": "acme.brandy"\r\n}\r\n');
});
