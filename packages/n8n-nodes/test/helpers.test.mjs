import { describe, it, expect } from 'vitest';
import {
	buildRunBody,
	coerceJsonObject,
	declaredBinaryBytes,
	parseRocketRideResponse,
} from '../nodes/RocketRide/helpers.ts';

describe('buildRunBody', () => {
	it('text mode -> raw text/plain', () => {
		expect(buildRunBody('text', { text: 'hi' })).toEqual({ body: 'hi', contentType: 'text/plain' });
	});

	it('json mode with object -> stringified application/json', () => {
		const built = buildRunBody('json', { jsonBody: { a: 1 } });
		expect(built.contentType).toBe('application/json');
		expect(JSON.parse(built.body)).toEqual({ a: 1 });
	});

	it('json mode with string -> passed through unchanged', () => {
		expect(buildRunBody('json', { jsonBody: '{"a":1}' }).body).toBe('{"a":1}');
	});

	it('structured mode -> { text, documents }', () => {
		const built = buildRunBody('structured', {
			text: 't',
			documents: [{ content: 'c', metadata: { p: 1 } }],
		});
		expect(built.contentType).toBe('application/json');
		expect(JSON.parse(built.body)).toEqual({ text: 't', documents: [{ content: 'c', metadata: { p: 1 } }] });
	});
});

describe('coerceJsonObject', () => {
	it('parses JSON object strings', () => {
		expect(coerceJsonObject('{"x":1}')).toEqual({ x: 1 });
	});
	it('passes objects through', () => {
		expect(coerceJsonObject({ y: 2 })).toEqual({ y: 2 });
	});
	it('returns {} for junk, empty, or nullish', () => {
		expect(coerceJsonObject('not json')).toEqual({});
		expect(coerceJsonObject('')).toEqual({});
		expect(coerceJsonObject(undefined)).toEqual({});
		expect(coerceJsonObject(42)).toEqual({});
	});
	it('rejects arrays — plain objects only', () => {
		expect(coerceJsonObject([1, 2])).toEqual({});
		expect(coerceJsonObject('[1,2]')).toEqual({});
	});
});

describe('parseRocketRideResponse', () => {
	it('unwraps the { status, data } envelope', () => {
		expect(parseRocketRideResponse({ status: 'OK', data: { a: 1 } })).toEqual({ a: 1 });
	});
	it('parses a JSON string then unwraps', () => {
		expect(parseRocketRideResponse('{"status":"OK","data":{"a":1}}')).toEqual({ a: 1 });
	});
	it('returns an object without a data envelope as-is', () => {
		expect(parseRocketRideResponse({ a: 1 })).toEqual({ a: 1 });
	});
	it('wraps non-JSON strings under result', () => {
		expect(parseRocketRideResponse('plain text')).toEqual({ result: 'plain text' });
	});
});

describe('declaredBinaryBytes', () => {
	it('prefers the numeric bytes field when present', async () => {
		expect(await declaredBinaryBytes({ data: '', mimeType: 'x', bytes: 42 })).toBe(42);
	});

	it('falls back to getBinaryMetadata for externally-stored binaries', async () => {
		const size = await declaredBinaryBytes({ data: '', mimeType: 'x', id: 'bin-1' }, async () => ({
			fileSize: 1234,
		}));
		expect(size).toBe(1234);
	});

	it('returns the exact decoded length for in-memory base64 data', async () => {
		const payload = Buffer.from('hello!!');
		const b64 = payload.toString('base64');
		expect(await declaredBinaryBytes({ data: b64, mimeType: 'x' })).toBe(payload.length);
	});

	it('returns undefined when no reliable size is available', async () => {
		// External binary, no metadata helper — and a metadata helper that throws.
		expect(await declaredBinaryBytes({ data: '', mimeType: 'x', id: 'bin-1' })).toBeUndefined();
		expect(
			await declaredBinaryBytes({ data: '', mimeType: 'x', id: 'bin-1' }, async () => {
				throw new Error('gone');
			}),
		).toBeUndefined();
	});
});
