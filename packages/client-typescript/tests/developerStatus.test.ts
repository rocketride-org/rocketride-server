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

import { describe, test, expect, jest } from '@jest/globals';
import { RocketRideClient } from '../src/client/client';

describe('RocketRideClient.developerStatus', () => {
	test('developerStatus forwards its timeout to the request', async () => {
		const client = new RocketRideClient();
		const call = jest.spyOn(client, 'call').mockResolvedValue({ developerId: 'acme', stripeAccountId: null, stripeAccountStatus: 'none' });
		await expect(client.developerStatus({ timeout: 10_000 })).resolves.toMatchObject({ developerId: 'acme' });
		expect(call).toHaveBeenCalledWith('rrext_deploy_app', { subcommand: 'developer_status' }, { timeout: 10_000 });
	});

	test('developerStatus without options keeps the default request timeout', async () => {
		const client = new RocketRideClient();
		const call = jest.spyOn(client, 'call').mockResolvedValue({ developerId: null, stripeAccountId: null, stripeAccountStatus: 'none' });
		await client.developerStatus();
		expect(call).toHaveBeenCalledWith('rrext_deploy_app', { subcommand: 'developer_status' }, undefined);
	});

	test('registerDeveloper forwards its timeout to the request', async () => {
		const client = new RocketRideClient();
		const call = jest.spyOn(client, 'call').mockResolvedValue({ developerId: 'acme' });
		await client.registerDeveloper('acme', { timeout: 30_000 });
		expect(call).toHaveBeenCalledWith('rrext_deploy_app', { subcommand: 'developer_register', developerId: 'acme' }, { timeout: 30_000 });
	});
});
