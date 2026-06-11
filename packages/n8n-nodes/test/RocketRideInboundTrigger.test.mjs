import { describe, it, expect } from 'vitest';
import { RocketRideInboundTrigger } from '../nodes/RocketRideInboundTrigger/RocketRideInboundTrigger.node.ts';

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

	it('rejects with 401 when the secret is wrong', async () => {
		const { ctx, state } = makeCtx({
			params: { secret: 's3cr3t' },
			body: {},
			headers: { authorization: 'Bearer nope' },
		});
		const out = await RocketRideInboundTrigger.prototype.webhook.call(ctx);
		expect(out.noWebhookResponse).toBe(true);
		expect(state.responded.code).toBe(401);
	});
});
