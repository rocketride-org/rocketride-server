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
// LOGOUT CLEAR — T72 (plan section 4.7), the planner and the guest boot order
// =============================================================================
//
// Seams pinned here:
//
//   src/isolation/logoutClear.ts
//     planLogoutClear({ open: string[], visited: string[] }) -> {
//       navigate: string[];   // `<origin>/_rr/frame.html#clear` for each OPEN frame's origin
//       sweep: string[];      // hidden-frame origins: visited and not open (deduplicated)
//       sweepSandbox: string; // 'allow-scripts allow-same-origin'
//       parallel: 4; timeoutMs: 2000;
//       forgetVisited: true;  // `rr:isolation:visited` is cleared afterwards
//     }
//     visitedRecord(ownerHash, origins) -> { owner, origins }          // origins deduplicated, sorted
//     shouldSweepAtBoot({ record, signedIn, ownerHash }) -> boolean    // plan "Missed sweeps"
//
//   src/guest/bootPlan.ts
//     bootSteps(hash: string) -> readonly ('markGuestRealm' | 'navigateClear' | 'importIndex')[]
//
//   src/guest/boot.ts is the entry: a static-import guard keeps it free of
//   anything that could construct the ConnectionManager before the flag is set.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const A = 'https://a1111111111111111111111111.apps.example';
const B = 'https://a2222222222222222222222222.apps.example';
const C = 'https://a3333333333333333333333333.apps.example';

async function load(): Promise<typeof import('./logoutClear')> {
	return await import('./logoutClear');
}

test('T72 open frames navigate to <origin>/_rr/frame.html#clear; closed visited origins are swept; nothing is both', async () => {
	const { planLogoutClear } = await load();
	const plan = planLogoutClear({ open: [A], visited: [A, B, C, B] });
	assert.deepEqual(plan.navigate, [`${A}/_rr/frame.html#clear`]);
	assert.deepEqual([...plan.sweep].sort(), [B, C], 'the open origin is navigated, not also swept; duplicates collapse');
	assert.equal(plan.forgetVisited, true, 'the visited list is cleared afterwards');
});

test('T72 the sweep frames use the non-opaque sandbox, 4 at a time, 2 s each', async () => {
	const { planLogoutClear } = await load();
	const plan = planLogoutClear({ open: [], visited: [A, B] });
	assert.equal(plan.sweepSandbox, 'allow-scripts allow-same-origin');
	assert.equal(plan.parallel, 4);
	assert.equal(plan.timeoutMs, 2000);
});

test('T72 an origin that is not a plain http(s) origin is never navigated or swept (the list is shell localStorage, not trusted input)', async () => {
	const { planLogoutClear } = await load();
	const plan = planLogoutClear({ open: ['javascript:alert(1)', 'https://user:pw@evil.example', `${A}/path`], visited: ['data:text/html,x', 'file:///etc/passwd', '', `${B}?q=1`, C] });
	assert.deepEqual(plan.navigate, []);
	assert.deepEqual(plan.sweep, [C]);
});

test('T72 the visited record keeps an owner hash and the origins, deduplicated and sorted', async () => {
	const { visitedRecord } = await load();
	assert.deepEqual(visitedRecord('ab12', [B, A, B]), { owner: 'ab12', origins: [A, B] });
});

test('T72 missed sweeps: boot signed out, or as another user, sweeps the stored origins; the same user does not', async () => {
	const { shouldSweepAtBoot } = await load();
	const record = { owner: 'hash-a', origins: [A] };
	assert.equal(shouldSweepAtBoot({ record, signedIn: false, ownerHash: null }), true, 'signed out');
	assert.equal(shouldSweepAtBoot({ record, signedIn: true, ownerHash: 'hash-b' }), true, 'user B after user A');
	assert.equal(shouldSweepAtBoot({ record, signedIn: true, ownerHash: 'hash-a' }), false, 'same user');
	assert.equal(shouldSweepAtBoot({ record: null, signedIn: false, ownerHash: null }), false, 'nothing stored');
	assert.equal(shouldSweepAtBoot({ record: { owner: 'hash-a', origins: [] }, signedIn: false, ownerHash: null }), false, 'nothing to sweep');
	assert.equal(shouldSweepAtBoot({ record: { owner: 7, origins: 'x' } as never, signedIn: true, ownerHash: 'hash-a' }), true, 'a record that is not the record shape is swept (fail closed)');
});

test('T72 boot order: the flag first, then either the clear navigation (and stop) or the dynamic import of the guest', async () => {
	const { bootSteps } = await import('../guest/bootPlan');
	assert.deepEqual([...bootSteps('#clear')], ['markGuestRealm', 'navigateClear']);
	assert.deepEqual([...bootSteps('')], ['markGuestRealm', 'importIndex']);
	assert.deepEqual([...bootSteps('#other')], ['markGuestRealm', 'importIndex']);
	assert.deepEqual([...bootSteps('#clear2')], ['markGuestRealm', 'importIndex'], 'exactly #clear');
});

test('T72 boot.ts statically imports nothing that can build the ConnectionManager; the guest index is a dynamic import', async () => {
	const file = path.join(__dirname, '..', 'guest', 'boot.ts');
	let source: string;
	try {
		source = readFileSync(file, 'utf8');
	} catch {
		assert.fail('src/guest/boot.ts does not exist yet (PR2b)');
	}
	const staticImports = [...source.matchAll(/^\s*import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
	const sideEffect = [...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
	for (const spec of [...staticImports, ...sideEffect]) {
		assert.ok(/guestFlag|bootPlan/.test(spec), `boot.ts must not statically import ${spec}`);
	}
	assert.match(source, /import\(\s*['"]\.\/index['"]\s*\)/, 'the guest index is imported dynamically');
	assert.match(source, /_rr\/clear/, 'the clear navigation target');
	assert.ok(source.indexOf('markGuestRealm') < source.indexOf("import('./index')") || source.indexOf('markGuestRealm') < source.search(/import\(\s*['"]\.\/index/), 'the flag is set before the guest is imported');
});
