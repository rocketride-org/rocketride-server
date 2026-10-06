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

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';
import { init } from '@module-federation/runtime';
import { devPreviewHoldRemainingMs, isDevPreviewPending, registerDevRemote, registerLocalApp, setDescriptorInvalidator } from './appLoader';
import type { AppDescriptor } from '../components/workspace/types';

// In the browser the rsbuild MF plugin creates the host instance; stand one
// up so registerDevRemote's registerRemotes has a runtime to register into.
init({ name: 'shell_test', remotes: [] });

/**
 * Points the loader at a shell page: its query string and whether it is
 * framed (an embedded App Builder preview) or the top-level window.
 */
function stubPage(search: string, framed: boolean): void {
	const self = {};
	const store = new Map<string, string>();
	Reflect.set(globalThis, 'window', { self, top: framed ? {} : self, location: { search } });
	Reflect.set(globalThis, 'sessionStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	});
}

/** Pins the page clock (ms since navigation start) the hold is measured on. */
function stubClock(ms: number): void {
	mock.method(performance, 'now', () => ms);
}

afterEach(() => {
	mock.restoreAll();
	setDescriptorInvalidator(null);
});

test('an embedded dev preview holds its locked app while the registration is pending', () => {
	stubPage('?appid=org.held&rrdev=1', true);
	stubClock(1_000);
	assert.equal(isDevPreviewPending('org.held'), true);
});

test('the hold ends once the dev-remote deadline has passed', () => {
	stubPage('?appid=org.held&rrdev=1', true);
	stubClock(31_000);
	assert.equal(isDevPreviewPending('org.held'), false);
});

test('the hold applies only to the app the preview is locked to', () => {
	stubPage('?appid=org.held&rrdev=1', true);
	stubClock(1_000);
	assert.equal(isDevPreviewPending('org.other'), false);
});

test('a top-level page never holds', () => {
	stubPage('?appid=org.held&rrdev=1', false);
	stubClock(1_000);
	assert.equal(isDevPreviewPending('org.held'), false);
});

test('the hold ends once the locked app registers', () => {
	stubPage('?appid=org.registered&rrdev=1', true);
	stubClock(1_000);
	registerLocalApp('org.registered', () => Promise.resolve({} as AppDescriptor));
	assert.equal(isDevPreviewPending('org.registered'), false);
});

test('the remaining hold time counts down to zero and is zero outside a dev preview', () => {
	stubPage('?appid=org.held&rrdev=1', true);
	stubClock(1_000);
	assert.equal(devPreviewHoldRemainingMs(), 29_000);
	mock.restoreAll();
	stubClock(31_000);
	assert.equal(devPreviewHoldRemainingMs(), 0);
	stubPage('?appid=org.held&rrdev=1', false);
	mock.restoreAll();
	stubClock(1_000);
	assert.equal(devPreviewHoldRemainingMs(), 0);
});

test('a dev registration for a different app than the locked one is reported', () => {
	stubPage('?appid=org.locked&rrdev=1', true);
	setDescriptorInvalidator(() => {});
	const warn = mock.method(console, 'warn', () => {});
	registerDevRemote('org.typo', 'org_typo', 'Typo', 'http://localhost:1/remoteEntry.js');
	const mentionsBoth = warn.mock.calls.some((call) => {
		const text = call.arguments.map(String).join(' ');
		return text.includes('"org.typo"') && text.includes('"org.locked"');
	});
	assert.equal(mentionsBoth, true);
});

test('a dev registration for the locked app is not reported as a mismatch', () => {
	stubPage('?appid=org.match&rrdev=1', true);
	setDescriptorInvalidator(() => {});
	const warn = mock.method(console, 'warn', () => {});
	registerDevRemote('org.match', 'org_match', 'Match', 'http://localhost:1/remoteEntry.js');
	assert.equal(warn.mock.callCount(), 0);
});
