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
// PREVIEW ISOLATION GATE — T75 (E13/E14 helpers) and the structural half of T74 (E6)
// =============================================================================
//
// Seam pinned here (plan section 3.6, `surfaces/preview/isolationGate.ts`):
//
//   previewAllowed(appId: string, iso: IIsolationView | null): boolean
//     iso = `getIsolation()` from the shell API:
//       null                                   -> isolation is off: the preview works as before
//                                                 (ONLY null means off: undefined or any other shape is denied)
//       { mode: 'unknown', ... }               -> denied (probe failed: E6/E13/E14 and dev registration)
//       { mode: 'optin' | 'enforce', isFirstParty(appId) } -> allowed only for a first-party id
//
// The three call sites are `AppBuilderProvider` (E6: no iframe or token posts),
// `devSession` (E13: `registerLocalApp` skipped) and `devPreviewPage` (E14: no
// blob page). Rendering them needs a DOM harness and the rocket-ui dependency
// tree, neither of which this workspace has installed, so T74 is pinned here
// as a STRUCTURAL guard only (the behaviour of the helper is the real test).
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

async function gate(): Promise<{ previewAllowed(appId: string, iso: unknown): boolean }> {
	return (await import('./isolationGate')) as never;
}

const view = (mode: 'optin' | 'enforce' | 'unknown', firstParty: string[] = []) => ({
	mode,
	originTemplate: mode === 'unknown' ? null : 'https://{label}.apps.example',
	isFirstParty: (id: string) => mode !== 'unknown' && firstParty.includes(id),
});

test('T75 isolation off (null): every preview is allowed, as before PR2', async () => {
	const { previewAllowed } = await gate();
	assert.equal(previewAllowed('acme.new', null), true);
	assert.equal(previewAllowed('rocketride.home', null), true);
});

test('T75 isolation installed: only a first-party stamped id may be previewed in-realm (a brand-new id has no stamp)', async () => {
	const { previewAllowed } = await gate();
	for (const mode of ['optin', 'enforce'] as const) {
		assert.equal(previewAllowed('rocketride.home', view(mode, ['rocketride.home'])), true, `${mode}: first party`);
		assert.equal(previewAllowed('acme.brandnew', view(mode, ['rocketride.home'])), false, `${mode}: no stamp`);
		assert.equal(previewAllowed('rocketride.evil', view(mode, [])), false, `${mode}: rocketride.* spelling is not a stamp`);
	}
});

test('T75 the unknown state (probe failed) denies even a first-party id', async () => {
	const { previewAllowed } = await gate();
	assert.equal(previewAllowed('rocketride.home', view('unknown', ['rocketride.home'])), false);
});

test('T75 a view that is not the getIsolation shape is denied (fail closed)', async () => {
	const { previewAllowed } = await gate();
	for (const iso of [undefined, {}, { mode: 'enforce' }, { mode: 'enforce', isFirstParty: 'yes' }, 'enforce', 7, { mode: 'off', isFirstParty: () => true }]) {
		assert.equal(previewAllowed('rocketride.home', iso), false, JSON.stringify(iso) ?? 'undefined');
	}
});

test('T75 a throwing isFirstParty denies instead of allowing', async () => {
	const { previewAllowed } = await gate();
	assert.equal(
		previewAllowed('rocketride.home', {
			mode: 'enforce',
			originTemplate: 'https://{label}.apps.example',
			isFirstParty: () => {
				throw new Error('boom');
			},
		}),
		false
	);
});

// ── structural guards (see the header) ────────────────────────────────────────

const read = (rel: string): string => readFileSync(path.join(__dirname, rel), 'utf8');

test('T74 E6 AppBuilderProvider asks previewAllowed before it frames the preview or posts a token', () => {
	const source = read('AppBuilderProvider.tsx');
	assert.match(source, /isolationGate/, 'imports the gate');
	assert.match(source, /previewAllowed\(/, 'and calls it');
	assert.match(source, /getIsolation/, 'with the shell API view');
});

test('T75 E13 devSession skips registerLocalApp unless the gate allows', () => {
	const source = read('session/devSession.ts');
	assert.match(source, /previewAllowed\(/);
	assert.ok(source.indexOf('previewAllowed(') < source.indexOf('api.registerLocalApp('), 'the check comes before the registration');
});

test('T75 E14 devPreviewPage builds no blob page unless the gate allows', () => {
	const source = read('session/devPreviewPage.ts');
	assert.match(source, /previewAllowed\(/);
});

test('T76 E7 WebviewProvider hands the origin template to isAllowedWebviewUrl', () => {
	const source = readFileSync(path.join(__dirname, '..', 'pages', 'WebviewProvider.tsx'), 'utf8');
	assert.match(source, /getIsolation\(\)/);
	assert.match(source, /isAllowedWebviewUrl\(\s*url\s*,\s*window\.location\.origin\s*,/);
});
