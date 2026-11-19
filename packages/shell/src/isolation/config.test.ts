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
// ISOLATION CONFIG, THE v14 CONTRACT AND SHELL_CAPS — T77 and the stamp rule (T62, T68)
// =============================================================================
//
// Seams pinned here (plan sections 3.3, 3.6, 4.6):
//
//   src/isolation/shellCaps.ts   `export const SHELL_CAPS = ['appIsolation:1'] as const`, a leaf (no imports)
//   src/isolation/config.ts
//     installIsolation(info: IAppIsolationInfo | undefined, options?: { probeFailed?: boolean }): void
//       info = { mode: 'optin' | 'enforce'; originTemplate: string; protoMin: number; protoMax: number }
//       `undefined` with `probeFailed: true` records the UNKNOWN state (plan 4.6).
//     getIsolation() -> { mode: 'optin' | 'enforce' | 'unknown'; originTemplate: string | null;
//                         isFirstParty(appId: string): boolean } | null
//         `null` under `off` (nothing installed); `unknown` has no template and no first party.
//     isIsolatedEntry(entry: { id; isolated?; firstParty? }): boolean      the stamp rule
//     isFirstPartyId(appId: string): boolean
//     noteFirstParty(appId: string): void    called by registerAndMapApps for firstParty-stamped entries
//   src/api.ts: `getIsolation`, `SHELL_CAPS`, `CapabilityDeniedError` as named exports and shellApi members
//   src/apiver.ts: SHELL_API_VERSION = 13; contract/versions/v13.d.ts frozen
//
// The install state is module-level and node:test runs each FILE in its own
// process, so the tests are ordered: the state only moves forward
// (nothing, unknown, optin, enforce).
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CapabilityDeniedError } from './capabilityDenied';

const SHELL_ROOT = path.join(__dirname, '..', '..');
const TEMPLATE = 'https://{label}.apps.example';

async function cfg(): Promise<typeof import('./config')> {
	return await import('./config');
}

test('T68 nothing installed: getIsolation() is null and no entry is isolated unless it says so', async () => {
	const c = await cfg();
	assert.equal(c.getIsolation(), null);
	assert.equal(c.isIsolatedEntry({ id: 'acme.a' }), false);
	assert.equal(c.isIsolatedEntry({ id: 'acme.a', firstParty: false }), false, 'without a mode nothing is isolated by default');
	assert.equal(c.isIsolatedEntry({ id: 'acme.a', isolated: true }), true, 'an isolated:true entry is honoured without the probe (fail closed)');
	c.installIsolation(undefined);
	assert.equal(c.getIsolation(), null, 'installIsolation(undefined) keeps the base behaviour');
});

test('T62 the unknown state (probe failed): no template, no first party, isolated entries still isolated', async () => {
	const c = await cfg();
	c.installIsolation(undefined, { probeFailed: true });
	const iso = c.getIsolation();
	assert.ok(iso);
	assert.equal(iso.mode, 'unknown');
	assert.equal(iso.originTemplate, null);
	assert.equal(iso.isFirstParty('rocketride.home'), false, 'E6/E13/E14 and dev registration are denied');
	assert.equal(c.isIsolatedEntry({ id: 'acme.a', isolated: true }), true);
	assert.equal(c.isIsolatedEntry({ id: 'rocketride.home', firstParty: true }), false);
});

test('T62 optin isolates only what is stamped isolated; first party is whatever the stamps said', async () => {
	const c = await cfg();
	c.installIsolation({ mode: 'optin', originTemplate: TEMPLATE, protoMin: 1, protoMax: 1 });
	const iso = c.getIsolation()!;
	assert.equal(iso.mode, 'optin');
	assert.equal(iso.originTemplate, TEMPLATE);
	assert.equal(c.isIsolatedEntry({ id: 'acme.a' }), false);
	assert.equal(c.isIsolatedEntry({ id: 'acme.a', isolated: true }), true);
	assert.equal(iso.isFirstParty('rocketride.home'), false, 'no stamp seen yet');
	c.noteFirstParty('rocketride.home');
	assert.equal(c.getIsolation()!.isFirstParty('rocketride.home'), true);
	assert.equal(c.isFirstPartyId('rocketride.home'), true);
	assert.equal(c.getIsolation()!.isFirstParty('acme.brandnew'), false, 'a brand-new id has no stamp');
});

test('T62 enforce isolates every entry without firstParty: true (P3), and an isolated:true entry always', async () => {
	const c = await cfg();
	c.installIsolation({ mode: 'enforce', originTemplate: TEMPLATE, protoMin: 1, protoMax: 1 });
	assert.equal(c.getIsolation()!.mode, 'enforce');
	assert.equal(c.isIsolatedEntry({ id: 'acme.a' }), true, 'a missing stamp isolates (fail closed)');
	assert.equal(c.isIsolatedEntry({ id: 'acme.a', firstParty: false }), true);
	assert.equal(c.isIsolatedEntry({ id: 'rocketride.home', firstParty: true }), false);
	assert.equal(c.isIsolatedEntry({ id: 'rocketride.home', firstParty: true, isolated: true }), true, 'isolated:true wins over a first-party stamp');
});

test('T77 SHELL_CAPS lives in a leaf module and says appIsolation:1', async () => {
	const file = path.join(__dirname, 'shellCaps.ts');
	assert.ok(existsSync(file), 'src/isolation/shellCaps.ts does not exist yet (PR2b)');
	assert.doesNotMatch(readFileSync(file, 'utf8'), /^\s*import\s/m, 'a leaf: connection.ts (also in the guest bundle) must not pull in config.ts');
	const { SHELL_CAPS } = await import('./shellCaps');
	assert.deepEqual([...SHELL_CAPS], ['appIsolation:1']);
	const c = await cfg();
	assert.deepEqual([...c.SHELL_CAPS], ['appIsolation:1'], 'config.ts re-exports it');
});

test('T77 the shell API exposes getIsolation, SHELL_CAPS and CapabilityDeniedError as named exports AND shellApi members, and the contract moves to v14', async () => {
	const { installDom } = await import('../test/domHarness');
	installDom();
	const api = (await import('../api')) as unknown as Record<string, unknown> & { shellApi: Record<string, unknown> };
	for (const name of ['getIsolation', 'SHELL_CAPS', 'CapabilityDeniedError']) {
		assert.ok(name in api, `named export ${name} (the _exportsComplete guard needs it)`);
		assert.ok(name in api.shellApi, `shellApi.${name}`);
	}
	assert.equal(api.CapabilityDeniedError, CapabilityDeniedError);
	assert.deepEqual([...(api.SHELL_CAPS as readonly string[])], ['appIsolation:1']);
	assert.equal(typeof api.getIsolation, 'function');

	const apiver = readFileSync(path.join(SHELL_ROOT, 'src', 'apiver.ts'), 'utf8');
	assert.match(apiver, /SHELL_API_VERSION\s*=\s*14\s+as const/);
	const v14 = path.join(SHELL_ROOT, 'contract', 'versions', 'v14.d.ts');
	assert.ok(existsSync(v14), 'contract/versions/v14.d.ts is written by shell:freeze');
	const frozen = readFileSync(v14, 'utf8');
	for (const name of ['getIsolation', 'SHELL_CAPS', 'CapabilityDeniedError']) assert.ok(frozen.includes(name), `${name} is in the frozen v14`);
	assert.ok(existsSync(path.join(SHELL_ROOT, 'contract', 'versions', 'v13.d.ts')), 'additive: v13 stays');
	const check = readFileSync(path.join(SHELL_ROOT, 'src', 'contract-check.generated.ts'), 'utf8');
	assert.match(check, /ShellApiV14/, 'the conformance file checks v14 (shell:contract-check)');
});
