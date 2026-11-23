// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// GUEST SHELL MODULE — T57 (and T71, the MF plugin pin)
// =============================================================================
//
// Plan section 3.4: `src/guest/shellModule.ts` is `export * from '../api'` plus
// shadowing exports. The Appendix A names throw `CapabilityDeniedError`;
// `getIsolation()` returns `null`; `getClient`/`ConnectionManager` are the
// guest objects. The `ShellApiShape` conformance (`const _check: ShellApiShape
// = shellApi`) is a compile-time check owned by `tsc`; here the runtime half is
// asserted: every public name still exists.
//
// `src/guest/mfPlugin.ts` (T71): the chunk-URL rewrite and the lockfile pin.
//   rewriteChunkUrl(url: string, entryPrefix: string) -> string
//   assertRuntimeVersion(lockfileText: string, installed: string) -> void  (throws on a mismatch)
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { installDom } from '../test/domHarness';
import { CapabilityDeniedError } from '../isolation/capabilityDenied';

/** Appendix A: the names a guest must not be able to use. */
const DENIED = ['CloudAuthProvider', 'ApiKeyAuthProvider', 'AccountProvider', 'useShellApiKey', 'CheckoutFlow', 'AccountView', 'useIframeBridge', 'createBusRouter', 'attachRealmToRoot', 'registerClientOps', 'applyAppVersionOverride'];

/** True when touching `name` of `mod` (reading it, calling it, constructing it) throws CapabilityDeniedError and never yields a working value. */
function deniedAnyWay(mod: Record<string, unknown>, name: string): boolean {
	let value: unknown;
	try {
		value = mod[name];
	} catch (err) {
		return err instanceof CapabilityDeniedError;
	}
	if (typeof value !== 'function') return false;
	let denied = 0;
	for (const use of [() => (value as () => unknown)(), () => Reflect.construct(value as new () => unknown, [])]) {
		try {
			use();
			return false;
		} catch (err) {
			if (err instanceof CapabilityDeniedError) denied++;
		}
	}
	return denied >= 1;
}

async function loadModules(): Promise<{ guest: Record<string, unknown>; api: Record<string, unknown> }> {
	installDom();
	const api = (await import('../api')) as unknown as Record<string, unknown>;
	const guest = (await import('./shellModule')) as unknown as Record<string, unknown>;
	return { guest, api };
}

test('T57 every Appendix A name throws CapabilityDeniedError in the guest module (and still exists in the real one)', async () => {
	const { guest, api } = await loadModules();
	for (const name of DENIED) {
		assert.ok(name in api, `${name} is part of the shell API`);
		assert.ok(deniedAnyWay(guest, name), `${name} must throw CapabilityDeniedError in a guest`);
	}
});

test('T57 the guest module keeps the rest of the public surface: every other api export is there', async () => {
	const { guest, api } = await loadModules();
	const missing = Object.keys(api).filter((k) => !(k in guest));
	assert.deepEqual(missing, [], 'a guest app that links against any other shell API name must still resolve it');
});

test('T57 getIsolation() is null in a guest, whatever the shell installed', async () => {
	const { guest } = await loadModules();
	assert.equal(typeof guest.getIsolation, 'function');
	assert.equal((guest.getIsolation as () => unknown)(), null);
});

test('T57 getClient and ConnectionManager are the guest objects (the same module the guest runtime configured)', async () => {
	const { guest } = await loadModules();
	const cmModule = await import('../connection/connection');
	assert.equal(guest.ConnectionManager, cmModule.ConnectionManager);
	assert.equal(typeof guest.getClient, 'function');
});

test('T57 the guest module is a real file with shadowing exports (not a re-export alone)', () => {
	const source = readFileSync(path.join(__dirname, 'shellModule.ts'), 'utf8');
	assert.match(source, /export \* from ['"]\.\.\/api['"]/);
	for (const name of DENIED) assert.ok(source.includes(name), `${name} is shadowed`);
	assert.match(source, /ShellApiShape/, 'the type conformance check is in the file');
});

// ─────────────────────────────────────────────────────────────────────────────
// T71 MF plugin and the runtime pin
// ─────────────────────────────────────────────────────────────────────────────

test('T71 the chunk-URL rewrite re-bases a remote chunk onto the CURRENT entryPrefix only', async () => {
	const { rewriteChunkUrl } = await import('./mfPlugin');
	const prefix = '/_t/NEW/v3/';
	assert.equal(rewriteChunkUrl('/_t/OLD/v3/static/js/chunk.js', prefix), '/_t/NEW/v3/static/js/chunk.js');
	assert.equal(rewriteChunkUrl('/_t/NEW/v3/remoteEntry.js', prefix), '/_t/NEW/v3/remoteEntry.js');
	assert.equal(rewriteChunkUrl('https://cdn.evil.example/x.js', prefix), 'https://cdn.evil.example/x.js', 'a foreign URL is not rewritten onto the app origin');
	assert.equal(rewriteChunkUrl('/_t/OLD/v3/../../_p/other/v1/x.js', prefix), '/_t/OLD/v3/../../_p/other/v1/x.js', 'a traversal is not normalised into the prefix');
});

test('T71 the MF runtime version the plugin was written for is asserted against the lockfile', async () => {
	const { assertRuntimeVersion } = await import('./mfPlugin');
	const lock = "'@module-federation/runtime@2.5.1':\n  resolution: {integrity: sha512-x}\n";
	assert.doesNotThrow(() => assertRuntimeVersion(lock, '2.5.1'));
	assert.throws(() => assertRuntimeVersion(lock, '2.6.0'), /module-federation/);
	assert.throws(() => assertRuntimeVersion('', '2.5.1'), /module-federation/, 'a lockfile that does not name the runtime fails closed');
});
