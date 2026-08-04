import { describe, it, expect } from 'vitest';
import { RocketRide } from '../nodes/RocketRide/RocketRide.node.ts';

function makeContext({ params, credentials, httpMock, binaries = {}, continueOnFail = false }) {
	const calls = [];
	return {
		calls,
		getInputData: () => [{ json: {}, binary: {} }],
		getCredentials: async () => credentials,
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getNode: () => ({ name: 'RocketRide' }),
		continueOnFail: () => continueOnFail,
		helpers: {
			assertBinaryData: (_i, name) => binaries[name].meta,
			getBinaryDataBuffer: async (_i, name) => binaries[name].buffer,
			httpRequestWithAuthentication: {
				call: async (_ctx, _credName, opts) => {
					calls.push(opts);
					return httpMock(opts);
				},
			},
		},
	};
}

describe('RocketRide.execute — Upload Files', () => {
	it('builds multipart form-data with the binary file and optional text', async () => {
		const ctx = makeContext({
			params: { operation: 'uploadFiles', inputDataFieldName: 'data', uploadText: 'summarize this' },
			credentials: { baseUrl: 'http://localhost:5567', apiKey: 'pk', ignoreSslIssues: false },
			binaries: {
				data: { meta: { fileName: 'doc.pdf', mimeType: 'application/pdf' }, buffer: Buffer.from('hello pdf') },
			},
			httpMock: () => ({ status: 'OK', data: { objects: { data: { status: 'OK' } } } }),
		});

		await RocketRide.prototype.execute.call(ctx);
		const opts = ctx.calls[0];

		expect(opts.method).toBe('POST');
		expect(opts.url).toBe('http://localhost:5567/webhook');
		expect(opts.body instanceof FormData).toBe(true);

		const filePart = opts.body.get('data');
		expect(filePart).toBeTruthy();
		expect(filePart.name).toBe('doc.pdf');
		expect(filePart.type).toBe('application/pdf');
		expect(opts.body.get('text')).toBe('summarize this');
	});

	it('supports multiple comma-separated binary fields', async () => {
		const ctx = makeContext({
			params: { operation: 'uploadFiles', inputDataFieldName: 'data, second' },
			credentials: { baseUrl: 'http://localhost:5567', apiKey: 'pk', ignoreSslIssues: false },
			binaries: {
				data: { meta: { fileName: 'a.txt', mimeType: 'text/plain' }, buffer: Buffer.from('a') },
				second: { meta: { fileName: 'b.txt', mimeType: 'text/plain' }, buffer: Buffer.from('b') },
			},
			httpMock: () => ({ status: 'OK', data: {} }),
		});

		await RocketRide.prototype.execute.call(ctx);
		const opts = ctx.calls[0];
		expect(opts.body.get('data').name).toBe('a.txt');
		expect(opts.body.get('second').name).toBe('b.txt');
	});

	it('rejects uploads over the 16 MB limit before sending', async () => {
		const big = Buffer.alloc(17 * 1024 * 1024);
		const ctx = makeContext({
			params: { operation: 'uploadFiles', inputDataFieldName: 'data' },
			credentials: { baseUrl: 'http://localhost:5567', apiKey: 'pk', ignoreSslIssues: false },
			binaries: {
				data: { meta: { fileName: 'big.bin', mimeType: 'application/octet-stream' }, buffer: big },
			},
			httpMock: () => ({ status: 'OK', data: {} }),
			continueOnFail: true,
		});

		const result = await RocketRide.prototype.execute.call(ctx);
		expect(ctx.calls.length).toBe(0);
		expect(result[0][0].json.error).toMatch(/exceeds the 16/);
	});

	it('rejects oversized uploads from declared metadata bytes without buffering', async () => {
		let buffered = false;
		const ctx = makeContext({
			params: { operation: 'uploadFiles', inputDataFieldName: 'data' },
			credentials: { baseUrl: 'http://localhost:5567', apiKey: 'pk', ignoreSslIssues: false },
			binaries: {
				data: {
					meta: { fileName: 'big.bin', mimeType: 'application/octet-stream', bytes: 17 * 1024 * 1024 },
					buffer: Buffer.alloc(0),
				},
			},
			httpMock: () => ({ status: 'OK', data: {} }),
			continueOnFail: true,
		});
		ctx.helpers.getBinaryDataBuffer = async () => {
			buffered = true;
			return Buffer.alloc(0);
		};

		const result = await RocketRide.prototype.execute.call(ctx);
		expect(buffered).toBe(false);
		expect(ctx.calls.length).toBe(0);
		expect(result[0][0].json.error).toMatch(/exceeds the 16/);
	});

	it('rejects oversized externally-stored binaries via getBinaryMetadata without buffering', async () => {
		let buffered = false;
		const ctx = makeContext({
			params: { operation: 'uploadFiles', inputDataFieldName: 'data' },
			credentials: { baseUrl: 'http://localhost:5567', apiKey: 'pk', ignoreSslIssues: false },
			binaries: {
				data: {
					meta: { fileName: 'big.bin', mimeType: 'application/octet-stream', id: 'bin-1' },
					buffer: Buffer.alloc(0),
				},
			},
			httpMock: () => ({ status: 'OK', data: {} }),
			continueOnFail: true,
		});
		ctx.helpers.getBinaryMetadata = async () => ({ fileSize: 20 * 1024 * 1024 });
		ctx.helpers.getBinaryDataBuffer = async () => {
			buffered = true;
			return Buffer.alloc(0);
		};

		const result = await RocketRide.prototype.execute.call(ctx);
		expect(buffered).toBe(false);
		expect(ctx.calls.length).toBe(0);
		expect(result[0][0].json.error).toMatch(/exceeds the 16/);
	});

	it('uploads normally when the declared size is under the limit', async () => {
		const ctx = makeContext({
			params: { operation: 'uploadFiles', inputDataFieldName: 'data' },
			credentials: { baseUrl: 'http://localhost:5567', apiKey: 'pk', ignoreSslIssues: false },
			binaries: {
				data: {
					meta: { fileName: 'ok.txt', mimeType: 'text/plain', bytes: 5 },
					buffer: Buffer.from('hello'),
				},
			},
			httpMock: () => ({ status: 'OK', data: {} }),
		});

		await RocketRide.prototype.execute.call(ctx);
		expect(ctx.calls.length).toBe(1);
		expect(ctx.calls[0].body.get('data').name).toBe('ok.txt');
	});
});
