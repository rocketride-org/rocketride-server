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
 * Monitor key scope tests — no server required.
 *
 * The scope IS the kind: a MonitorKey with teamId addresses the team's
 * DEPLOYED run; without it, the caller's own dev run. These tests pin the
 * wire arguments and, critically, the key-string ENCODE/DECODE round-trip:
 * reconnect replays subscriptions through that pair, so an encoder-only
 * change would silently drop the team scope after a reconnect.
 */

import { RocketRideClient, MonitorKey } from '../src/client';
import { describe, it, expect } from '@jest/globals';

/**
 * Build a detached client shell: prototype methods available, no socket.
 * Captures rrext_monitor calls instead of sending them.
 */
function makeClientShell(): { client: RocketRideClient; calls: Array<{ args?: unknown; opts?: unknown }> } {
	const calls: Array<{ args?: unknown; opts?: unknown }> = [];
	const client = Object.create(RocketRideClient.prototype) as RocketRideClient;
	(client as unknown as { isConnected: () => boolean }).isConnected = () => true;
	(client as unknown as { call: (cmd: string, args?: unknown, opts?: unknown) => Promise<void> }).call = async (_cmd: string, args?: unknown, opts?: unknown) => {
		calls.push({ args, opts });
	};
	(client as unknown as { _monitorKeys: Map<string, Map<string, number>> })._monitorKeys = new Map();
	return { client, calls };
}

/**
 * Register a minimal lifecycle operation as the client's current one.
 *
 * `_resubscribeAllMonitors` aborts when its operation is no longer current, so a
 * white-box caller has to supply the operation the reconnect would have owned.
 */
function makeCurrentOperation(client: RocketRideClient): unknown {
	const operation = { generation: 1, authRequestSent: true, settled: false, accepted: true };
	const internals = client as unknown as { _lifecycleOperation: unknown; _lifecycleGeneration: number };
	internals._lifecycleOperation = operation;
	internals._lifecycleGeneration = operation.generation;
	return operation;
}

/** Round-trip a key through the private encode/decode pair. */
function roundTrip(key: MonitorKey): MonitorKey | null {
	const proto = RocketRideClient.prototype as unknown as {
		_monitorKeyToString(key: MonitorKey): string;
		_monitorStringToKey(keyStr: string): MonitorKey | null;
	};
	return proto._monitorStringToKey(proto._monitorKeyToString(key));
}

describe('monitor key scope', () => {
	it('round-trips a dev key (no teamId)', () => {
		expect(roundTrip({ projectId: 'proj-1', source: 'src-1' })).toEqual({ projectId: 'proj-1', source: 'src-1' });
	});

	it('round-trips a team-scoped key', () => {
		expect(roundTrip({ projectId: 'proj-1', source: 'src-1', teamId: 'team-1' })).toEqual({
			projectId: 'proj-1',
			source: 'src-1',
			teamId: 'team-1',
		});
	});

	it('round-trips a team-scoped pipe key', () => {
		expect(roundTrip({ projectId: 'proj-1', source: 'src-1', pipeId: 42, teamId: 'team-1' })).toEqual({
			projectId: 'proj-1',
			source: 'src-1',
			pipeId: 42,
			teamId: 'team-1',
		});
	});

	it('round-trips a token key', () => {
		expect(roundTrip({ token: 'tk_abc' })).toEqual({ token: 'tk_abc' });
	});

	it('round-trips ids containing the former delimiters', () => {
		// '@' and '.' are free text in ids — a delimiter-joined encoding
		// decoded 'chat@legacy' as source 'chat' + teamId 'legacy', silently
		// rewriting the subscription scope on reconnect.
		expect(roundTrip({ projectId: 'proj.dotted', source: 'chat@legacy' })).toEqual({ projectId: 'proj.dotted', source: 'chat@legacy' });
		expect(roundTrip({ projectId: 'proj-1', source: 'a.b@c', pipeId: 7, teamId: 'team@x' })).toEqual({
			projectId: 'proj-1',
			source: 'a.b@c',
			pipeId: 7,
			teamId: 'team@x',
		});
	});

	it('dev and team keys of the same project/source are distinct entries', () => {
		const proto = RocketRideClient.prototype as unknown as { _monitorKeyToString(key: MonitorKey): string };
		const dev = proto._monitorKeyToString({ projectId: 'proj-1', source: 'src-1' });
		const team = proto._monitorKeyToString({ projectId: 'proj-1', source: 'src-1', teamId: 'team-1' });
		expect(dev).not.toEqual(team);
	});

	it('sends teamId on the wire only when present', async () => {
		const { client, calls } = makeClientShell();
		await client.addMonitor({ projectId: 'proj-1', source: 'src-1', teamId: 'team-1' }, ['all']);
		await client.addMonitor({ projectId: 'proj-1', source: 'src-1' }, ['all']);
		expect((calls[0].args as Record<string, unknown>).teamId).toBe('team-1');
		expect('teamId' in (calls[1].args as Record<string, unknown>)).toBe(false);
	});

	it('reconnect resubscribe keeps the team scope', async () => {
		const { client, calls } = makeClientShell();
		await client.addMonitor({ projectId: 'proj-1', source: 'src-1', teamId: 'team-1' }, ['summary']);
		calls.length = 0;
		await (client as unknown as { _resubscribeAllMonitors: (operation: unknown) => Promise<void> })._resubscribeAllMonitors(makeCurrentOperation(client));
		expect(calls).toHaveLength(1);
		expect((calls[0].args as Record<string, unknown>).teamId).toBe('team-1');
	});

	it('removeMonitor with the same team-scoped key releases the subscription', async () => {
		const { client, calls } = makeClientShell();
		const key: MonitorKey = { projectId: 'proj-1', source: 'src-1', teamId: 'team-1' };
		await client.addMonitor(key, ['all']);
		await client.removeMonitor(key, ['all']);
		// Second call is the empty-types unsubscribe for the SAME scoped key.
		expect(calls).toHaveLength(2);
		expect((calls[1].args as Record<string, unknown>).teamId).toBe('team-1');
		expect((calls[1].args as Record<string, unknown>).types).toEqual([]);
	});
});
