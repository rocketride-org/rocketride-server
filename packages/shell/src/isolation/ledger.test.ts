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
// ALIAS TESTS — T105 (knownProjects, short ids, project-keyed maps and the N1-L flood case)
// =============================================================================

/// <reference types="node" />


// =============================================================================
// LEDGER QUOTAS — what counts toward a realm's limits
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPLETED_GRACE_MS, createLedger } from './ledger';

test('monitor keys of a run past its grace period no longer count toward the quota', () => {
	let now = 1_000_000;
	let seed = 0;
	const ledger = createLedger({ now: () => now, random: (n) => Uint8Array.from({ length: n }, (_, i) => (seed + i * 7) & 0xff) });
	const make = (source: string): string => {
		seed += 31;
		return ledger.addRun({ token: `tk_${seed}`, publicToken: `pk_${seed}`, projectId: `rrapp.k.${seed}`, source, taskId: `t${seed}.${source}` }).handle;
	};
	const ended = make('a');
	const kept = make('b');
	ledger.monitors.set(ended, new Map([['summary', 1], ['flow', 1]]));
	ledger.monitors.set(kept, new Map([['summary', 1]]));
	ledger.directMonitors.set(`${ended}:1`, { handle: ended, pipeId: 1, types: ['output'] });
	assert.equal(ledger.used('monitorKeys'), 4, 'all four keys count while both runs are live');

	ledger.complete(ended);
	now += COMPLETED_GRACE_MS - 1;
	assert.equal(ledger.used('monitorKeys'), 4, 'a completed run still counts inside its grace period');
	now += 2;
	assert.equal(ledger.used('monitorKeys'), 1, 'past the grace period only the live run keeps its monitor key');
	assert.equal(ledger.monitors.has(ended), false, 'the expired run was dropped with its monitors');
});
