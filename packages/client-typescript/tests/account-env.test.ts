// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * account.setEnv wire shape (saas#827): it sends update_env, values in `env`
 * and deletions in a `delete` list. A server with only the old full-replacement
 * set_env refuses update_env as unknown instead of wiping what it was not sent.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, jest } from '@jest/globals';
import { AccountApi } from '../src/client/account';
import { CONST_ENV_MASK } from '../src/client/constants';
import type { RocketRideClient } from '../src/client';

function fakeClient() {
	const call = jest.fn(async (_command: string, _args?: Record<string, unknown>) => ({}) as Record<string, unknown>);
	const client = { call } as unknown as RocketRideClient;
	return { client, call };
}

describe('AccountApi.setEnv', () => {
	it('exports the mask the server keeps a stored value for', () => {
		const base = readFileSync(join(__dirname, '../../ai/src/ai/account/base.py'), 'utf-8');
		expect(base).toContain(`ENV_MASK = '${CONST_ENV_MASK}'`);
	});

	it('splits null values into the delete list', async () => {
		const { client, call } = fakeClient();
		await new AccountApi(client).setEnv('user', { ROCKETRIDE_A: 'a', ROCKETRIDE_B: null, ROCKETRIDE_C: CONST_ENV_MASK });

		expect(call).toHaveBeenCalledTimes(1);
		expect(call.mock.calls[0][0]).toBe('rrext_account_me');
		expect(call.mock.calls[0][1]).toEqual({
			subcommand: 'update_env',
			env: { ROCKETRIDE_A: 'a', ROCKETRIDE_C: CONST_ENV_MASK },
			delete: ['ROCKETRIDE_B'],
		});
	});

	it('sends an empty delete list when nothing is removed', async () => {
		const { client, call } = fakeClient();
		await new AccountApi(client).setEnv('team', { ROCKETRIDE_A: 'a' }, 'team-1');

		expect(call.mock.calls[0][0]).toBe('rrext_account_teams');
		expect(call.mock.calls[0][1]).toEqual({ subcommand: 'update_env', env: { ROCKETRIDE_A: 'a' }, delete: [], teamId: 'team-1' });
	});
});
