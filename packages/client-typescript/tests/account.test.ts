/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { AccountApi } from '../src/client/account';

const params = {
	email: 'ben@acme.test',
	givenName: 'Ben',
	familyName: 'Lee',
	role: 'member',
	teamAssignments: [{ teamId: 'team-1', permissions: ['task.control'] }],
	devTeamId: 'team-1',
};

const invited = { userId: 'user-1', displayName: 'Ben Lee', email: 'ben@acme.test', role: 'member', status: 'pending', devTeamId: 'team-1' };

function fakeClient() {
	return { call: jest.fn(async () => invited) } as any;
}

describe('AccountApi invites', () => {
	it('invite sends teamAssignments and devTeamId and returns the invited member', async () => {
		const client = fakeClient();
		const member = await new AccountApi(client).invite('org-1', params);
		expect(client.call).toHaveBeenCalledWith('rrext_account_members', { subcommand: 'invite', orgId: 'org-1', ...params });
		expect(member).toEqual(invited);
	});

	it('inviteMember sends the same request and still resolves to undefined', async () => {
		const client = fakeClient();
		const result = await new AccountApi(client).inviteMember('org-1', params);
		expect(client.call).toHaveBeenCalledWith('rrext_account_members', { subcommand: 'invite', orgId: 'org-1', ...params });
		expect(result).toBeUndefined();
	});
});
