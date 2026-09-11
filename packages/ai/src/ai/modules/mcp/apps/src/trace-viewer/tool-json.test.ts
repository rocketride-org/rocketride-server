/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */
import { describe, expect, it } from 'vitest';

import { friendlyToolError, parseToolJson, ToolError } from './tool-json';

function textResult(payload: unknown): unknown {
	return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

describe('parseToolJson', () => {
	it('returns the payload on ok: true', () => {
		expect(parseToolJson(textResult({ ok: true, traces: [] }))).toEqual({ ok: true, traces: [] });
	});

	it('throws on host-level isError', () => {
		expect(() => parseToolJson({ isError: true, content: [{ type: 'text', text: 'boom' }] })).toThrow('boom');
	});

	it('throws on missing text content', () => {
		expect(() => parseToolJson({ content: [] })).toThrow(/missing text/);
	});

	it('throws on non-JSON text', () => {
		expect(() => parseToolJson({ content: [{ type: 'text', text: 'not json' }] })).toThrow(/not JSON/);
	});

	it('maps ok: false envelopes to a ToolError carrying error_type', () => {
		let caught: unknown;
		try {
			parseToolJson(textResult({ ok: false, error_type: 'TraceExpired', message: 'trace 5 is below the retention horizon' }));
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ToolError);
		expect((caught as ToolError).errorType).toBe('TraceExpired');
		expect((caught as ToolError).message).toMatch(/retention window/);
	});
});

describe('friendlyToolError', () => {
	it('translates TraceExpired', () => {
		expect(friendlyToolError({ error_type: 'TraceExpired' })).toMatch(/retention window \(7 days dev \/ 30 days deploy\)/);
	});
	it('translates NotFound', () => {
		expect(friendlyToolError({ error_type: 'NotFound' })).toMatch(/No recorded trace/);
	});
	it('falls back to the payload message', () => {
		expect(friendlyToolError({ error_type: 'BadRequest', message: 'beginSeq is required' })).toBe('beginSeq is required');
	});
});
