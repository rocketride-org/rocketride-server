// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * account.setEnv wire shape (saas#809): values go in `env`, deletions in a
 * `delete` list. A server with the old full-replacement contract ignores the
 * list instead of storing null as a value; the write-only server applies it.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { AccountApi } from '../src/client/account';
import type { RocketRideClient } from '../src/client';

function fakeClient() {
	const call = jest.fn(async (_command: string, _args?: Record<string, unknown>) => ({}) as Record<string, unknown>);
	const client = { call } as unknown as RocketRideClient;
	return { client, call };
}

describe('AccountApi.setEnv', () => {
	it('splits null values into the delete list', async () => {
		const { client, call } = fakeClient();
		await new AccountApi(client).setEnv('user', { ROCKETRIDE_A: 'a', ROCKETRIDE_B: null, ROCKETRIDE_C: '••••••••' });

		expect(call).toHaveBeenCalledTimes(1);
		expect(call.mock.calls[0][0]).toBe('rrext_account_me');
		expect(call.mock.calls[0][1]).toEqual({
			subcommand: 'set_env',
			env: { ROCKETRIDE_A: 'a', ROCKETRIDE_C: '••••••••' },
			delete: ['ROCKETRIDE_B'],
		});
	});

	it('sends an empty delete list when nothing is removed', async () => {
		const { client, call } = fakeClient();
		await new AccountApi(client).setEnv('team', { ROCKETRIDE_A: 'a' }, 'team-1');

		expect(call.mock.calls[0][0]).toBe('rrext_account_teams');
		expect(call.mock.calls[0][1]).toEqual({ subcommand: 'set_env', env: { ROCKETRIDE_A: 'a' }, delete: [], teamId: 'team-1' });
	});
});
