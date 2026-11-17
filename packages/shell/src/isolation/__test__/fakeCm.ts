// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// =============================================================================
// FAKE CONNECTION MANAGER — the IAppRootCm the isolation tests pass
// =============================================================================

/// <reference types="node" />

import { randomBytes } from 'node:crypto';
import { createOpBus } from '../../ops/busOps';
import type { IOpBus } from '../../ops/busOps';
import { createRetainedRegistry } from '../../ops/retained';
import type { IRetainedRegistry } from '../../ops/retained';
import { ConnectionState } from '../../types/connection';
import type { ConnectionStatus } from '../../types/connection';
import type { IAppRootCm } from '../types';
import { createFakeEngine } from './fakeEngine';
import type { IFakeEngine, IFakeEngineOptions } from './fakeEngine';
import type { DAPMessage } from 'rocketride';

/** Retained topics seeded into the fake root's registry, with their markers. */
export const SEEDED_TOPICS = {
	account: 'shell:account',
	telemetry: 'shell:telemetry',
	mirror: 'mirror.x',
	hostConnection: 'host:connection',
	prefsOwn: 'shell:prefs:app:acme.alpha',
	prefsOther: 'shell:prefs:app:other',
} as const;

/** The fake manager plus its test controls. */
export interface IFakeCm extends IAppRootCm {
	engine: IFakeEngine;
	/** Every `emit` the root made, in order. */
	emitted: Array<{ event: string; payload: unknown }>;
	/** Every `emitOp` made on `ops()`, in order. */
	opsEmitted: Array<{ op: string; params: unknown }>;
	/** The fixed session token (while signed in). */
	sessionToken: string;
	/** The shell API key (default `rr_` + 40 random chars). Settable. */
	apiKey: string;
	/** Which of the two sources answer with the key: `getClient().getApiKey()` and the `host.apiKey` op (both on by default). */
	apiKeySources: { client: boolean; host: boolean };
	/** Holds `host.apiKey` answers until the returned release function runs. */
	holdApiKey(): () => void;
	/** `emit('shell:event', {event})`: an engine event the root's connection received (`types/shell.ts:150`). */
	emitEngineEvent(event: DAPMessage): void;
	setConnected(connected: boolean): void;
	/** Signed out: no token, not connected, state DISCONNECTED. */
	setSignedIn(signedIn: boolean): void;
	setConnectionStatus(status: Partial<ConnectionStatus>): void;
}

/** Creates a fake manager with a seeded retained registry. */
export function createFakeCm(options: IFakeEngineOptions = {}): IFakeCm {
	const engine = createFakeEngine(options);
	const bus = createOpBus();
	const key = { value: `rr_${randomBytes(20).toString('hex')}`, sources: { client: true, host: true } };
	// The SDK accessor (`client.ts:3420`) and the shell's own op (`hostOps.ts:122`).
	engine.client.getApiKey = () => (key.sources.client ? key.value : undefined);
	let apiKeyHold: Promise<void> | null = null;
	bus.handle('host.apiKey', async () => {
		if (apiKeyHold) await apiKeyHold;
		return { apiKey: key.sources.host ? key.value : null };
	});
	const opsEmitted: Array<{ op: string; params: unknown }> = [];
	const rawEmitOp = bus.emitOp;
	const ops: IOpBus = {
		...bus,
		emitOp(op, params) {
			opsEmitted.push({ op, params });
			rawEmitOp(op, params);
		},
	};
	const registry: IRetainedRegistry = createRetainedRegistry();
	registry.publish(SEEDED_TOPICS.account, { marker: 'account-snapshot', email: 'secret@example.test' });
	registry.publish(SEEDED_TOPICS.telemetry, { marker: 'telemetry-snapshot' });
	registry.publish(SEEDED_TOPICS.mirror, { marker: 'mirror-snapshot' });
	registry.publish(SEEDED_TOPICS.hostConnection, { marker: 'host-connection-snapshot' });
	registry.publish(SEEDED_TOPICS.prefsOwn, { marker: 'own-prefs' });
	registry.publish(SEEDED_TOPICS.prefsOther, { marker: 'other-prefs' });

	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const emitted: Array<{ event: string; payload: unknown }> = [];
	const sessionToken = `sess-${randomBytes(20).toString('hex')}`;
	let connected = true;
	let signedIn = true;
	let status = { state: ConnectionState.CONNECTED, connectionMode: 'cloud', lastError: 'secret' } as unknown as ConnectionStatus;

	return {
		engine,
		emitted,
		opsEmitted,
		sessionToken,
		getClient: () => engine.client,
		isConnected: () => connected && signedIn,
		ops: () => ops,
		on(event, handler) {
			const set = listeners.get(event) ?? new Set();
			set.add(handler as (payload: unknown) => void);
			listeners.set(event, set);
			return () => set.delete(handler as (payload: unknown) => void);
		},
		emit(event, payload) {
			emitted.push({ event, payload });
			for (const cb of [...(listeners.get(event) ?? [])]) cb(payload);
		},
		loadToken: () => (signedIn ? sessionToken : ''),
		getConnectionStatus: () => ({ ...status }),
		retained: () => registry,
		get apiKey() {
			return key.value;
		},
		set apiKey(value: string) {
			key.value = value;
		},
		apiKeySources: key.sources,
		holdApiKey() {
			let release!: () => void;
			apiKeyHold = new Promise<void>((resolve) => {
				release = () => {
					apiKeyHold = null;
					resolve();
				};
			});
			return release;
		},
		emitEngineEvent(event) {
			this.emit('shell:event', { event });
		},
		setConnected(value) {
			connected = value;
		},
		setSignedIn(value) {
			signedIn = value;
			status = { ...status, state: value ? ConnectionState.CONNECTED : ConnectionState.DISCONNECTED } as ConnectionStatus;
		},
		setConnectionStatus(next) {
			status = { ...status, ...next } as ConnectionStatus;
		},
	};
}
