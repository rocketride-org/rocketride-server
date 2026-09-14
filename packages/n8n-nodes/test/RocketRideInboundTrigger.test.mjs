import { timingSafeEqual } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
	const crypto = await importOriginal();
	return {
		...crypto,
		timingSafeEqual: vi.fn(crypto.timingSafeEqual),
	};
});

const { RocketRideInboundTrigger } = await import(
	'../nodes/RocketRideInboundTrigger/RocketRideInboundTrigger.node.ts'
);

function makeCtx({ params = {}, body = {}, headers = {}, query = {} }) {
	const state = { responded: null };
	const ctx = {
		getNodeParameter: (name, fb) => (name in params ? params[name] : fb),
		getBodyData: () => body,
		getHeaderData: () => headers,
		getQueryData: () => query,
		getResponseObject: () => ({
			status: (code) => ({
				json: (responseBody) => {
					state.responded = { code, body: responseBody };
				},
			}),
		}),
	};
	return { ctx, state };
}

describe('RocketRideInboundTrigger.webhook', () => {
	it('lifts the JSON payload to the top level and adds _rocketride meta', async () => {
		const { ctx } = makeCtx({
			body: { text: 'hi', documents: [] },
			headers: { 'x-test': '1' },
			query: { a: '2' },
		});
		const out = await RocketRideInboundTrigger.prototype.webhook.call(ctx);
		const item = out.workflowData[0][0].json;
		expect(item.text).toBe('hi');
		expect(item._rocketride.headers['x-test']).toBe('1');
		expect(item._rocketride.query.a).toBe('2');
	});

	it('wraps a non-object body under data', async () => {
		const { ctx } = makeCtx({ body: 'plain text' });
		const out = await RocketRideInboundTrigger.prototype.webhook.call(ctx);
		expect(out.workflowData[0][0].json.data).toBe('plain text');
	});

	it('passes the secret check when the Authorization header matches (Bearer stripped)', async () => {
		const { ctx } = makeCtx({
			params: { secret: 's3cr3t' },
			body: { ok: true },
			headers: { authorization: 'Bearer s3cr3t' },
		});
		const out = await RocketRideInboundTrigger.prototype.webhook.call(ctx);
		expect(out.workflowData[0][0].json.ok).toBe(true);
	});

	it('passes the secret check when the Authorization header matches without Bearer', async () => {
		const { ctx } = makeCtx({
			params: { secret: 's3cr3t' },
			body: { ok: true },
			headers: { authorization: 's3cr3t' },
		});
		const out = await RocketRideInboundTrigger.prototype.webhook.call(ctx);
		expect(out.workflowData[0][0].json.ok).toBe(true);
	});

	it('rejects with 401 when the secret is the wrong same-length value', async () => {
		const { ctx, state } = makeCtx({
			params: { secret: 's3cr3t' },
			body: {},
			headers: { authorization: 'Bearer x3cr3t' },
		});
		const out = await RocketRideInboundTrigger.prototype.webhook.call(ctx);
		expect(out.noWebhookResponse).toBe(true);
		expect(state.responded).toEqual({
			code: 401,
			body: { error: 'Unauthorized: invalid RocketRide secret' },
		});
	});

	it('rejects with 401 when the secret is the wrong different-length value', async () => {
		const { ctx, state } = makeCtx({
			params: { secret: 's3cr3t' },
			body: {},
			headers: { authorization: 'Bearer nope' },
		});
		const out = await RocketRideInboundTrigger.prototype.webhook.call(ctx);
		expect(out.noWebhookResponse).toBe(true);
		expect(state.responded).toEqual({
			code: 401,
			body: { error: 'Unauthorized: invalid RocketRide secret' },
		});
	});

	it('redacts Authorization/Cookie headers from _rocketride metadata', async () => {
		const { ctx } = makeCtx({
			params: { secret: 's3cr3t' },
			body: { ok: true },
			headers: { authorization: 'Bearer s3cr3t', cookie: 'sid=abc', 'x-keep': '1' },
		});
		const out = await RocketRideInboundTrigger.prototype.webhook.call(ctx);
		const headers = out.workflowData[0][0].json._rocketride.headers;
		expect(headers.authorization).toBeUndefined();
		expect(headers.cookie).toBeUndefined();
		expect(headers['x-keep']).toBe('1');
	});

	it('compares secrets with fixed-length SHA-256 digests and timingSafeEqual', async () => {
		vi.mocked(timingSafeEqual).mockClear();
		const { ctx } = makeCtx({
			params: { secret: 's3cr3t' },
			body: {},
			headers: { authorization: 'Bearer nope' },
		});
		await RocketRideInboundTrigger.prototype.webhook.call(ctx);

		expect(timingSafeEqual).toHaveBeenCalledTimes(1);
		const [[providedDigest, secretDigest]] = vi.mocked(timingSafeEqual).mock.calls;
		expect(providedDigest).toHaveLength(32);
		expect(secretDigest).toHaveLength(32);
	});
});
