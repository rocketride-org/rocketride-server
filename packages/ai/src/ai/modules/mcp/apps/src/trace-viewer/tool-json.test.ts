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
		const failed = { isError: true, content: [{ type: 'text', text: '{"error": "bridge failed"}' }] };
		expect(() => parseToolJson(failed)).toThrow('The trace could not be read. Try again.');
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
		expect((caught as ToolError).message).toMatch(/has expired/);
	});

	it('reads the plain message from an ok: false envelope that also has isError', () => {
		// The server sets isError on every in-band failure, so this is the shape the widget gets.
		const body = { ok: false, error_type: 'TraceExpired', message: 'trace 5 is below the retention horizon', hint: 'runs are evicted' };
		let caught: unknown;
		try {
			parseToolJson({ ...(textResult(body) as object), isError: true });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ToolError);
		expect((caught as ToolError).errorType).toBe('TraceExpired');
		expect((caught as ToolError).message).toBe(
			'This trace has expired. Run the pipeline again to record a new one.',
		);
		expect((caught as ToolError).message).not.toMatch(/[{}]/);
	});
});

describe('friendlyToolError', () => {
	it('translates TraceExpired', () => {
		expect(friendlyToolError({ error_type: 'TraceExpired' })).toBe('This trace has expired. Run the pipeline again to record a new one.');
	});
	it('translates NotFound', () => {
		expect(friendlyToolError({ error_type: 'NotFound' })).toMatch(/No recorded trace/);
	});
	it('says plainly that the engine timed out', () => {
		expect(friendlyToolError({ error_type: 'Timeout', message: 'log_trace timed out waiting for the engine' })).toBe(
			'The engine did not answer in time. Try again.',
		);
	});
	it('keeps server wording (tool names, arguments) out of other errors', () => {
		expect(friendlyToolError({ error_type: 'BadRequest', message: 'beginSeq is required' })).toBe('The trace could not be read. Try again.');
	});
});
