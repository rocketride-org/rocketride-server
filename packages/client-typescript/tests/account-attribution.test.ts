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
import type { RocketRideClient } from '../src/client/client';

function makeApi() {
	const call = jest.fn(async (_command: string, _args: Record<string, unknown>) => undefined);
	const api = new AccountApi({ call } as unknown as RocketRideClient);
	return { api, call };
}

describe('AccountApi.setAttribution', () => {
	it('sends the provider blob on rrext_account_me set_attribution', async () => {
		const { api, call } = makeApi();
		const blob = { user_data: { grclid: 'abc' }, client_context: { ua: 'x' } };
		await api.setAttribution('gravity', blob);
		expect(call).toHaveBeenCalledWith('rrext_account_me', { subcommand: 'set_attribution', provider: 'gravity', data: blob });
	});

	it('sends null data to clear the stored context on consent withdrawal', async () => {
		const { api, call } = makeApi();
		await api.setAttribution('gravity', null);
		expect(call).toHaveBeenCalledWith('rrext_account_me', { subcommand: 'set_attribution', provider: 'gravity', data: null });
	});
});
