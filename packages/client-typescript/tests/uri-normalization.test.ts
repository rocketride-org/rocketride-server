/**
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
import { RocketRideClient } from '../src/client';

describe('RocketRideClient URI normalization', () => {
	it('preserves secure websocket scheme for wss input', () => {
		const client = new RocketRideClient({ auth: 'test-key', uri: 'wss://cloud.rocketride.ai' });
		expect((client as any)._uri).toBe('wss://cloud.rocketride.ai/task/service');
	});

	it('maps https input to wss', () => {
		const client = new RocketRideClient({ auth: 'test-key', uri: 'https://cloud.rocketride.ai' });
		expect((client as any)._uri).toBe('wss://cloud.rocketride.ai/task/service');
	});

	it('preserves non-secure websocket scheme for ws input', () => {
		const client = new RocketRideClient({ auth: 'test-key', uri: 'ws://localhost:5565' });
		expect((client as any)._uri).toBe('ws://localhost:5565/task/service');
	});

	it('maps http input to ws', () => {
		const client = new RocketRideClient({ auth: 'test-key', uri: 'http://localhost:5565' });
		expect((client as any)._uri).toBe('ws://localhost:5565/task/service');
	});
});
