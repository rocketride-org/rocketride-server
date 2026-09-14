import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { RocketRide } from '../nodes/RocketRide/RocketRide.node.ts';

// A zero-dependency stub of the RocketRide HTTP gateway. Records each request so
// the test can assert the real method/path/headers/body the node put on the wire.
let server;
let baseUrl;
let received = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			const body = Buffer.concat(chunks);
			received.push({
				method: req.method,
				url: req.url,
				headers: req.headers,
				bodyText: body.toString('utf8'),
			});
			if (req.method === 'GET' && req.url === '/version') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ version: 'test' }));
				return;
			}
			if (req.method === 'POST' && req.url === '/webhook') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(
					JSON.stringify({
						status: 'OK',
						data: {
							objectsRequested: 1,
							objectsCompleted: 1,
							resultTypes: { out: 'text' },
							objects: { body: { status: 'OK', out: 'echoed' } },
						},
					}),
				);
				return;
			}
			res.writeHead(404);
			res.end();
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

// Faithful-enough IExecuteFunctions: httpRequestWithAuthentication applies the
// credential's Bearer header (as n8n does) and performs a REAL fetch.
function makeRealCtx({ params, apiKey = 'pk_test', binaries = {} }) {
	const credentials = { baseUrl, apiKey, ignoreSslIssues: false };
	return {
		getInputData: () => [{ json: {}, binary: {} }],
		getCredentials: async () => credentials,
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getNode: () => ({ name: 'RocketRide' }),
		continueOnFail: () => false,
		helpers: {
			assertBinaryData: (_i, name) => binaries[name].meta,
			getBinaryDataBuffer: async (_i, name) => binaries[name].buffer,
			httpRequestWithAuthentication: {
				call: async (_ctx, _credName, opts) => {
					const headers = { ...(opts.headers || {}), Authorization: `Bearer ${apiKey}` };
					const res = await fetch(opts.url, {
						method: opts.method,
						headers,
						body: opts.method === 'GET' ? undefined : opts.body,
					});
					return await res.text();
				},
			},
		},
	};
}

describe('integration — RocketRide node against a real HTTP stub', () => {
	it('Run (text) sends text/plain with Bearer auth and normalizes the result', async () => {
		received = [];
		const ctx = makeRealCtx({ params: { operation: 'run', payloadMode: 'text', text: 'hello' } });
		const out = await RocketRide.prototype.execute.call(ctx);
		const req = received.find((r) => r.url === '/webhook');
		expect(req.method).toBe('POST');
		expect(req.headers['content-type']).toContain('text/plain');
		expect(req.headers.authorization).toBe('Bearer pk_test');
		expect(req.bodyText).toBe('hello');
		expect(out[0][0].json.out).toBe('echoed');
		expect(out[0][0].json._rocketride.object).toBe('body');
	});

	it('Chat sends the rocketride-question content type and question text', async () => {
		received = [];
		const ctx = makeRealCtx({ params: { operation: 'chat', question: 'hi?', expectJson: false, role: '' } });
		await RocketRide.prototype.execute.call(ctx);
		const req = received.find((r) => r.url === '/webhook');
		expect(req.headers['content-type']).toContain('application/rocketride-question');
		expect(JSON.parse(req.bodyText).questions[0].text).toBe('hi?');
	});

	it('Upload sends real multipart/form-data containing the file', async () => {
		received = [];
		const ctx = makeRealCtx({
			params: { operation: 'uploadFiles', inputDataFieldName: 'data', uploadText: 'q' },
			binaries: { data: { meta: { fileName: 'f.txt', mimeType: 'text/plain' }, buffer: Buffer.from('filebytes') } },
		});
		await RocketRide.prototype.execute.call(ctx);
		const req = received.find((r) => r.url === '/webhook');
		expect(req.headers['content-type']).toContain('multipart/form-data');
		expect(req.bodyText).toContain('filebytes');
		expect(req.bodyText).toContain('f.txt');
	});
});
