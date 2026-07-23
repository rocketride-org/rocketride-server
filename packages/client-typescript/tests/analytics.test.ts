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

import { describe, it, expect } from '@jest/globals';
import { initReport, report } from '../src/client/analytics';

describe('rocketride/analytics report core', () => {
	it('stamps the app id from initReport on every event', () => {
		const seen: Array<[string, Record<string, unknown> | undefined]> = [];
		initReport('test-app', (event, props) => seen.push([event, props]));
		report('nav:click', { target: 'pricing' });
		expect(seen).toEqual([['nav:click', { app: 'test-app', target: 'pricing' }]]);
	});

	it('accepts any string event name (loose, no central taxonomy)', () => {
		const seen: string[] = [];
		initReport('test-app', (event) => seen.push(event));
		report('made:up_on_the_spot');
		expect(seen).toEqual(['made:up_on_the_spot']);
	});

	it('caller props cannot overwrite the app stamp', () => {
		const seen: Array<Record<string, unknown> | undefined> = [];
		initReport('test-app', (_event, props) => seen.push(props));
		report('store:app_view', { app: 'spoofed', app_id: 'some.catalog.app' });
		expect(seen).toEqual([{ app: 'test-app', app_id: 'some.catalog.app' }]);
	});

	it('drops non-string and empty event names', () => {
		const seen: string[] = [];
		initReport('test-app', (event) => seen.push(event));
		report('');
		report(42 as unknown as string);
		expect(seen).toEqual([]);
	});

	it('never throws, even when the sink does', () => {
		initReport('test-app', () => {
			throw new Error('sink exploded');
		});
		expect(() => report('nav:click')).not.toThrow();
	});
});
