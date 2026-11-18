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
// Shell.tsx WIRING GUARD — T56 (the teardown ordering half)
// =============================================================================
//
// T56 in the plan reads "Shell.tsx awaits teardownAll before cm.logout() in
// handleLogout and handleBackToHome (DOM harness)". Rendering the whole
// 1,000-line Shell in a DOM needs providers and seams that do not exist on
// the base and are not specified in the plan, so this commit does NOT fake
// that render. It pins the ordering as a STRUCTURAL guard over the source
// (clearly weaker than a behavioural test) and the behaviour that matters is
// covered against the real app root in `src/isolation/pr2bRoot.test.ts`
// (teardownAll followed by shell:logout leaves no realm attached).
//
// A behavioural replacement belongs in PR2b once Shell gets a test seam; see
// "Questions for the lead" in .rr-sec/T1_PR2b.md.
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SOURCE = readFileSync(path.join(__dirname, 'Shell.tsx'), 'utf8');

/** The text of one `const <name> = useCallback(...)` handler (up to the next top-level `useCallback`/`useEffect`). */
function handler(name: string): string {
	const start = SOURCE.indexOf(`const ${name} = `);
	assert.ok(start >= 0, `${name} exists`);
	const rest = SOURCE.slice(start + 1);
	const next = rest.search(/\n\tconst [A-Za-z]+ = (?:useCallback|useMemo)|\n\tuseEffect\(/);
	return SOURCE.slice(start, next < 0 ? undefined : start + 1 + next);
}

test('T56 handleLogout awaits appRoot.teardownAll(3000) before EVERY cm.logout() (the session-locked branch and the home branch)', () => {
	const body = handler('handleLogout');
	const logouts = [...body.matchAll(/cm\.logout\(\)/g)].map((m) => m.index!);
	assert.equal(logouts.length, 2, 'the two cm.logout() calls');
	const teardowns = [...body.matchAll(/teardownAll\(\s*3000\s*\)/g)].map((m) => m.index!);
	assert.ok(teardowns.length >= 1, 'handleLogout calls teardownAll(3000)');
	assert.match(body, /await[^;]*teardownAll\(\s*3000\s*\)|teardownAll\(\s*3000\s*\)\s*\.then|teardownAll\(\s*3000\s*\)\s*\.finally/, 'and waits for it');
	for (const at of logouts) assert.ok(teardowns.some((t) => t < at), `a teardownAll(3000) precedes the cm.logout() at ${at}`);
});

test('T56 handleBackToHome is async and awaits teardownAll(1500) before cm.logout(), and only then navigates', () => {
	const body = handler('handleBackToHome');
	assert.match(body, /async/, 'handleBackToHome is async');
	const teardown = body.search(/await[^;]*teardownAll\(\s*1500\s*\)/);
	const logout = body.indexOf('cm.logout()');
	const navigate = body.indexOf('window.location.href');
	assert.ok(teardown >= 0, 'awaits teardownAll(1500)');
	assert.ok(logout > teardown, 'cm.logout() comes after it');
	assert.ok(navigate > logout, 'and the navigation after the logout');
});

test('T56 Shell creates the app root beside registerClientOps (the root owns the shell:logout listener for logouts that bypass both handlers)', () => {
	const create = SOURCE.indexOf('createAppRoot(');
	const register = SOURCE.indexOf('registerClientOps(');
	assert.ok(create >= 0, 'Shell.tsx calls createAppRoot');
	assert.ok(register >= 0 && Math.abs(create - register) < 1500, 'next to registerClientOps');
});
