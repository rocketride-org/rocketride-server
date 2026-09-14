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

/**
 * BYO agent inference key tests — no server required.
 *
 * Pins the wire idiom for `rrext_account_agent_keys` (copied verbatim from
 * listKeys/createKey/revokeKey) and, critically, that the raw key string
 * never survives into protocol trace/debug output — it exists only on the
 * single outbound `set` request.
 */

import { RocketRideClient } from '../src/client';
import type { AgentKeyStatus } from '../src/client/types/account';
import { redactProtocolMessage } from '../src/client/core/TransportBase';
import { describe, it, expect } from '@jest/globals';

/**
 * Build a detached client shell: prototype methods available, no socket.
 * Captures `rrext_account_agent_keys` calls instead of sending them.
 */
function makeClientShell(
	handler?: (command: string, args?: Record<string, unknown>) => unknown,
): { client: RocketRideClient; calls: Array<{ command: string; args?: Record<string, unknown> }> } {
	const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
	const client = Object.create(RocketRideClient.prototype) as RocketRideClient;
	(client as unknown as { call: (command: string, args?: Record<string, unknown>) => Promise<unknown> }).call = async (
		command: string,
		args?: Record<string, unknown>,
	) => {
		calls.push({ command, args });
		return handler ? handler(command, args) : undefined;
	};
	return { client, calls };
}

describe('AccountApi agent keys', () => {
	it('agentKeyStatus() sends the status subcommand and unwraps body.keys', async () => {
		const keys: AgentKeyStatus[] = [{ provider: 'anthropic', last4: '1234' }];
		const { client, calls } = makeClientShell(() => ({ keys }));

		const result = await client.account.agentKeyStatus();

		expect(calls).toEqual([{ command: 'rrext_account_agent_keys', args: { subcommand: 'status' } }]);
		expect(result).toBe(keys);
	});

	it('agentKeyStatus() defaults to an empty array when body.keys is absent', async () => {
		const { client } = makeClientShell(() => ({}));

		const result = await client.account.agentKeyStatus();

		expect(result).toEqual([]);
	});

	it('setAgentKey() sends the set subcommand with provider + key and returns provider/last4', async () => {
		const { client, calls } = makeClientShell(() => ({ provider: 'anthropic', last4: '5678' }));

		const result = await client.account.setAgentKey('anthropic', 'sk-ant-super-secret');

		expect(calls).toEqual([
			{
				command: 'rrext_account_agent_keys',
				args: { subcommand: 'set', provider: 'anthropic', key: 'sk-ant-super-secret' },
			},
		]);
		expect(result).toEqual({ provider: 'anthropic', last4: '5678' });
	});

	it('setAgentKey() propagates server validation errors without echoing the key', async () => {
		// The real wire shape is a full sentence carrying a parenthesized
		// machine token, never the bare code alone — pin that shape here so
		// consumers matching by substring (e.g. AgentKeysPanel) keep working.
		const { client } = makeClientShell(() => {
			throw new Error('The provided key was rejected by the provider (invalid_key)');
		});

		await expect(client.account.setAgentKey('openai', 'sk-bad-key')).rejects.toThrow('invalid_key');
	});

	it('setAgentKey() propagates a provider_unreachable failure as a full sentence carrying the token', async () => {
		const { client } = makeClientShell(() => {
			throw new Error('Could not reach the provider to validate the key (provider_unreachable)');
		});

		await expect(client.account.setAgentKey('anthropic', 'sk-ant-good-key')).rejects.toThrow('provider_unreachable');
	});

	it('clearAgentKey() sends the clear subcommand and resolves void', async () => {
		const { client, calls } = makeClientShell(() => ({ cleared: true }));

		const result = await client.account.clearAgentKey('openai');

		expect(calls).toEqual([{ command: 'rrext_account_agent_keys', args: { subcommand: 'clear', provider: 'openai' } }]);
		expect(result).toBeUndefined();
	});

	it('redacts the raw key from protocol trace/debug output', () => {
		const message = {
			type: 'request',
			seq: 1,
			command: 'rrext_account_agent_keys',
			arguments: { subcommand: 'set', provider: 'anthropic', key: 'sk-ant-do-not-log' },
		};

		const redacted = redactProtocolMessage(message);

		expect((redacted.arguments as Record<string, unknown>).key).toBe('<redacted>');
		expect(JSON.stringify(redacted)).not.toContain('sk-ant-do-not-log');
	});

	it('also redacts key on the matching rrext_account_agent_keys response', () => {
		const response = {
			type: 'response',
			seq: 2,
			request_seq: 1,
			command: 'rrext_account_agent_keys',
			success: true,
			body: { provider: 'anthropic', last4: '1234', key: 'sk-ant-do-not-log' },
		};

		const redacted = redactProtocolMessage(response);

		expect((redacted.body as Record<string, unknown>).key).toBe('<redacted>');
	});

	it('does NOT redact an unrelated command\'s "key" field, e.g. rrext_dashboard monitors', () => {
		const dashboardResponse = {
			type: 'response',
			seq: 3,
			request_seq: 2,
			command: 'rrext_dashboard',
			success: true,
			body: { monitors: [{ key: 'mon-1', flags: [] }] },
		};

		const redacted = redactProtocolMessage(dashboardResponse);

		const monitors = (redacted.body as Record<string, unknown>).monitors as Array<Record<string, unknown>>;
		expect(monitors[0].key).toBe('mon-1');
	});
});
