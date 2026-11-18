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
// PR2b G4 ROUND 1 — guards outside the root: enterGuestMode needs a guest
// realm (DA LOW 3), open-link chips are capped (DA LOW 6), the boot-sweep gate
// cannot hang (DA LOW 7). Not a guest realm: the flag is never set here.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ConnectionManager } from '../connection/connection';

test('G4 enterGuestMode throws outside a guest realm (it is frozen in v13)', () => {
	const cm = Reflect.construct(ConnectionManager, []) as ConnectionManager & { enterGuestMode(i: unknown): void };
	assert.throws(() => cm.enterGuestMode({ type: 'rr:bridge:init', proto: 1, entryPrefix: '/_t/x/v1/', expiresAt: 1, theme: {}, identity: null, props: { isConnected: true, activeView: '', activeActivity: null, sidePanelOpen: false, theme: '' }, capabilities: [], appId: 'a.b', appKey: 'a', moduleId: 'a_b', viewId: '', engineHttpUrl: 'http://x' }));
	assert.equal(Reflect.get(cm, 'mirrorConnected'), null, 'nothing was seeded');
});

test('G4 open-link chips are capped: extras are dropped and answered false', async () => {
	const mod = (await import('./IsolatedAppFrame')) as unknown as { OPEN_CHIP_CAP?: number; addChip?: <T extends { open?: { resolve(v: boolean): void } }>(list: T[], chip: T) => T[] };
	assert.equal(typeof mod.addChip, 'function', 'addChip does not exist yet');
	assert.equal(mod.OPEN_CHIP_CAP, 3);
	const answers: boolean[] = [];
	let list: Array<{ id: number; open?: { resolve(v: boolean): void } }> = [];
	for (let i = 0; i < 5; i++) list = mod.addChip!(list, { id: i, open: { resolve: (v) => void answers.push(v) } });
	assert.equal(list.filter((c) => c.open).length, 3, 'three open-link chips at most');
	assert.deepEqual(answers, [false, false], 'the two extras were answered false at once');
	list = mod.addChip!(list, { id: 9 });
	assert.equal(list.length, 4, 'notify chips are not open-link chips');
});

test('G4 the boot-sweep gate resolves when the root appears after auth resolved (it re-runs on root creation)', () => {
	const source = readFileSync(path.join(__dirname, '..', 'components', 'layout', 'Shell.tsx'), 'utf8');
	const at = source.indexOf('sweepAtBoot(');
	assert.ok(at > 0);
	const effect = source.slice(source.lastIndexOf('useEffect(', at), source.indexOf('});', at) + 60);
	assert.match(effect, /\[[^\]]*rootReady[^\]]*\]/, 'the sweep effect depends on the root being created (state), not only on authResolved');
});
