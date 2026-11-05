/*
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { afterEach, describe, it, expect } from '@jest/globals';
import { createReporter, privacySignalOn, type SendOptions } from '../src/client/analytics';

describe('rocketride/analytics bound reporters', () => {
	it('stamps the bound app id on every event', () => {
		const seen: Array<[string, Record<string, unknown> | undefined]> = [];
		const report = createReporter('test-app', (event, props) => seen.push([event, props]));
		report('nav:click', { target: 'pricing' });
		expect(seen).toEqual([['nav:click', { app: 'test-app', target: 'pricing' }]]);
	});

	it('two reporters stamp independently — a late event from a backgrounded app names its true emitter', () => {
		const seen: Array<Record<string, unknown> | undefined> = [];
		const sink = (_event: string, props?: Record<string, unknown>) => seen.push(props);
		const homeReport = createReporter('home-ui', sink);
		const sqlReport = createReporter('sql-ui', sink);
		// sql-ui is now the active app; a straggling home-ui listener fires late.
		sqlReport('query:run');
		homeReport('page:engagement');
		expect(seen).toEqual([{ app: 'sql-ui' }, { app: 'home-ui' }]);
	});

	it('accepts any string event name (loose, no central taxonomy)', () => {
		const seen: string[] = [];
		const report = createReporter('test-app', (event) => seen.push(event));
		report('made:up_on_the_spot');
		expect(seen).toEqual(['made:up_on_the_spot']);
	});

	it('caller props cannot overwrite the app stamp', () => {
		const seen: Array<Record<string, unknown> | undefined> = [];
		const report = createReporter('test-app', (_event, props) => seen.push(props));
		report('store:app_view', { app: 'spoofed', app_id: 'some.catalog.app' });
		expect(seen).toEqual([{ app: 'test-app', app_id: 'some.catalog.app' }]);
	});

	it('passes capture options through to the sink untouched', () => {
		const seen: Array<SendOptions | undefined> = [];
		const report = createReporter('test-app', (_event, _props, options) => seen.push(options));
		const timestamp = new Date(1700000000000);
		report('cta:click', { intent: 'register' }, { transport: 'sendBeacon', timestamp, uuid: 'fact-1a2b' });
		report('nav:click');
		expect(seen).toEqual([{ transport: 'sendBeacon', timestamp, uuid: 'fact-1a2b' }, undefined]);
	});

	it('drops non-string and empty event names', () => {
		const seen: string[] = [];
		const report = createReporter('test-app', (event) => seen.push(event));
		report('');
		report(42 as unknown as string);
		expect(seen).toEqual([]);
	});

	it('never throws, even when the sink does', () => {
		const report = createReporter('test-app', () => {
			throw new Error('sink exploded');
		});
		expect(() => report('nav:click')).not.toThrow();
	});
});

describe('privacySignalOn', () => {
	const saved = {
		navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
		window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
	};

	/** Install a fake navigator and window on the global object (jest runs this suite in node). */
	const install = (nav: object, win: object = {}) => {
		Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
		Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
	};

	afterEach(() => {
		for (const key of ['navigator', 'window'] as const) {
			const descriptor = saved[key];
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	});

	it('is false outside a browser (no window)', () => {
		delete (globalThis as Record<string, unknown>).window;
		expect(privacySignalOn()).toBe(false);
	});

	it.each([['0'], [false], ['unspecified'], [null], [undefined], [0], ['no']])('treats %p as no signal', (value) => {
		install({ doNotTrack: value, msDoNotTrack: value, globalPrivacyControl: value }, { doNotTrack: value });
		expect(privacySignalOn()).toBe(false);
	});

	it.each([
		['navigator.doNotTrack "1"', { doNotTrack: '1' }, {}],
		['navigator.doNotTrack "yes"', { doNotTrack: 'yes' }, {}],
		['navigator.msDoNotTrack "1"', { msDoNotTrack: '1' }, {}],
		['window.doNotTrack "1"', {}, { doNotTrack: '1' }],
		['navigator.globalPrivacyControl true', { globalPrivacyControl: true }, {}],
		['navigator.globalPrivacyControl 1', { globalPrivacyControl: 1 }, {}],
	])('is true for %s', (_label, nav, win) => {
		install(nav, win);
		expect(privacySignalOn()).toBe(true);
	});

	it('is false when reading a signal throws', () => {
		const nav = {};
		Object.defineProperty(nav, 'doNotTrack', {
			get() {
				throw new Error('blocked');
			},
		});
		install(nav);
		expect(() => privacySignalOn()).not.toThrow();
		expect(privacySignalOn()).toBe(false);
	});

	it('still honors GPC when an earlier signal getter throws', () => {
		const nav = { globalPrivacyControl: true };
		Object.defineProperty(nav, 'doNotTrack', {
			get() {
				throw new Error('blocked');
			},
		});
		install(nav);
		expect(privacySignalOn()).toBe(true);
	});

	it('still honors DNT when the GPC getter throws', () => {
		const nav = { doNotTrack: '1' };
		Object.defineProperty(nav, 'globalPrivacyControl', {
			get() {
				throw new Error('blocked');
			},
		});
		install(nav);
		expect(privacySignalOn()).toBe(true);
	});
});
