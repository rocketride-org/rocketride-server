/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 */

import { describe, it, expect, jest } from '@jest/globals';
import { RocketRideClient } from '../src/client';

function makeMinimalPipeline() {
	return {
		project_id: '11111111-1111-1111-1111-111111111111',
		source: 'src_1',
		components: [
			{
				id: 'src_1',
				provider: 'webhook',
				config: { mode: 'Source', type: 'webhook' },
			},
		],
	};
}

describe('Runtime env forwarding', () => {
	it('forwards only ROCKETRIDE_* env vars on use()', async () => {
		const client = new RocketRideClient({
			auth: 'MYAPIKEY',
			uri: 'http://localhost:5565',
			env: {
				ROCKETRIDE_ALLOWED: 'yes',
				PATH: '/usr/bin',
				AWS_SECRET_ACCESS_KEY: 'blocked',
			},
		});

		const requestSpy = jest.spyOn(client as unknown as { request: (msg: unknown) => Promise<unknown> }, 'request').mockResolvedValue({
			success: true,
			body: { token: 'tk_test' },
		});

		await client.use({ pipeline: makeMinimalPipeline() });

		expect(requestSpy).toHaveBeenCalledTimes(1);
		const req = requestSpy.mock.calls[0][0] as { arguments?: { env?: Record<string, string> } };
		expect(req.arguments?.env).toEqual({ ROCKETRIDE_ALLOWED: 'yes' });
	});

	it('forwards only ROCKETRIDE_* env vars on restart()', async () => {
		const client = new RocketRideClient({
			auth: 'MYAPIKEY',
			uri: 'http://localhost:5565',
			env: {
				ROCKETRIDE_ALLOWED: 'yes',
				HOME: '/Users/test',
			},
		});

		const dapSpy = jest.spyOn(client as unknown as { dapRequest: (...args: unknown[]) => Promise<unknown> }, 'dapRequest').mockResolvedValue({
			success: true,
		});

		await client.restart({
			token: 'tk_test',
			projectId: '11111111-1111-1111-1111-111111111111',
			source: 'src_1',
			pipeline: makeMinimalPipeline(),
		});

		expect(dapSpy).toHaveBeenCalledTimes(1);
		const callArgs = dapSpy.mock.calls[0] as [string, { env?: Record<string, string> }, string];
		expect(callArgs[0]).toBe('restart');
		expect(callArgs[1].env).toEqual({ ROCKETRIDE_ALLOWED: 'yes' });
	});

	it('sends empty env on restart when no ROCKETRIDE_* vars are present', async () => {
		const client = new RocketRideClient({
			auth: 'MYAPIKEY',
			uri: 'http://localhost:5565',
			env: {
				HOME: '/Users/test',
			},
		});

		const dapSpy = jest.spyOn(client as unknown as { dapRequest: (...args: unknown[]) => Promise<unknown> }, 'dapRequest').mockResolvedValue({
			success: true,
		});

		await client.restart({
			token: 'tk_test',
			projectId: '11111111-1111-1111-1111-111111111111',
			source: 'src_1',
			pipeline: makeMinimalPipeline(),
		});

		const callArgs = dapSpy.mock.calls[0] as [string, { env?: Record<string, string> }, string];
		expect(callArgs[0]).toBe('restart');
		expect(callArgs[1].env).toEqual({});
	});
});
