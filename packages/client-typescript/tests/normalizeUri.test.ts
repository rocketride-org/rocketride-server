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

import { RocketRideClient } from '../src/client';
import { describe, it, expect } from '@jest/globals';

describe('RocketRideClient.normalizeUri', () => {
	describe('IPv4 and hostname inputs', () => {
		it('should add default port to bare localhost', () => {
			expect(RocketRideClient.normalizeUri('localhost')).toBe('http://localhost:5565');
		});

		it('should preserve an explicit port on localhost', () => {
			expect(RocketRideClient.normalizeUri('ws://localhost:8080')).toBe('ws://localhost:8080');
		});

		it('should add default port when no port is given', () => {
			expect(RocketRideClient.normalizeUri('wss://example.com')).toBe('wss://example.com:5565');
		});

		it('should preserve explicit port on an IP address', () => {
			expect(RocketRideClient.normalizeUri('ws://127.0.0.1:5565')).toBe('ws://127.0.0.1:5565');
		});

		it('should add default port to a bare IP address', () => {
			expect(RocketRideClient.normalizeUri('http://192.168.1.1')).toBe('http://192.168.1.1:5565');
		});

		it('should not add port for rocketride.ai cloud URIs', () => {
			expect(RocketRideClient.normalizeUri('https://app.rocketride.ai')).toBe('https://app.rocketride.ai');
		});
	});

	describe('IPv6 inputs', () => {
		it('should add default port to IPv6 address without a port', () => {
			expect(RocketRideClient.normalizeUri('wss://[2001:db8::1]')).toBe('wss://[2001:db8::1]:5565');
		});

		it('should preserve explicit port on IPv6 address', () => {
			expect(RocketRideClient.normalizeUri('wss://[2001:db8::1]:9090')).toBe('wss://[2001:db8::1]:9090');
		});

		it('should add default port to IPv6 loopback without a port', () => {
			expect(RocketRideClient.normalizeUri('http://[::1]')).toBe('http://[::1]:5565');
		});

		it('should preserve explicit port on IPv6 loopback', () => {
			expect(RocketRideClient.normalizeUri('http://[::1]:5565')).toBe('http://[::1]:5565');
		});

		it('should handle full IPv6 address without a port', () => {
			expect(RocketRideClient.normalizeUri('https://[2001:0db8:85a3:0000:0000:8a2e:0370:7334]')).toBe('https://[2001:db8:85a3::8a2e:370:7334]:5565');
		});
	});

	describe('scheme handling', () => {
		it('should prepend http:// to bare hostnames', () => {
			const result = RocketRideClient.normalizeUri('my-server:5565');
			expect(result).toBe('http://my-server:5565');
		});

		it('should preserve https scheme', () => {
			const result = RocketRideClient.normalizeUri('https://secure.example.com');
			expect(result).toBe('https://secure.example.com:5565');
		});

		it('should trim whitespace', () => {
			expect(RocketRideClient.normalizeUri('  localhost  ')).toBe('http://localhost:5565');
		});
	});

	describe('scheme-default ports (80/443)', () => {
		// When the user explicitly passes a scheme-default port (:443 on https,
		// :80 on http), the regex correctly detects the explicit port so the
		// default 5565 is NOT applied. The URL API then normalises the port
		// away (since it matches the scheme default), yielding a bare host.
		it('should not override explicit :443 on https', () => {
			expect(RocketRideClient.normalizeUri('https://example.com:443')).toBe('https://example.com');
		});

		it('should not override explicit :80 on http', () => {
			expect(RocketRideClient.normalizeUri('http://example.com:80')).toBe('http://example.com');
		});
	});
});
