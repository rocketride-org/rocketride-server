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
// REALM HARNESS — a real structured-clone channel between a root and a realm
// =============================================================================
//
// Node's global `MessageChannel`, so structured-clone semantics are real:
// `undefined` keys survive, cycles and `Map` survive, ports can be transferred.
// =============================================================================

/// <reference types="node" />

import type { DAPMessage } from 'rocketride';
import { attachRealmToRoot } from '../../ops/busBridge';
import type { IBusEndpoint, IRealmAttachment } from '../../ops/busBridge';
import { createOpBus } from '../../ops/busOps';
import type { IOpBus } from '../../ops/busOps';
import type { IRetainedPort } from '../../ops/retained';
import { isWireError, openEnvelope } from '../../connection/errorWire';
import type { IWireEnvelope } from '../../connection/errorWire';
import type { IAppRoot, IsolatedEntry } from '../types';

const ENVELOPE = '__rrbus';

/** Messages delivered on any test channel (both directions), for {@link settle}. */
let deliveries = 0;

/** One round of event-loop turns. */
async function turnRound(turns: number): Promise<void> {
	for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setTimeout(resolve, 5));
	for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Lets pending channel deliveries run: rounds of event-loop turns until no
 * channel delivered anything for two rounds in a row (at most 60 rounds).
 * Waiting on quiescence rather than a fixed number of turns keeps tests
 * that assert a delivery stable on a loaded machine.
 */
export async function settle(turns = 12): Promise<void> {
	let quiet = 0;
	for (let round = 0; round < 60 && quiet < 2; round++) {
		const before = deliveries;
		await turnRound(turns);
		quiet = deliveries === before ? quiet + 1 : 0;
	}
}

/** One structured-clone channel: endpoint `a` for the root, `b` for the realm. */
export interface IChannel {
	a: IBusEndpoint;
	b: IBusEndpoint;
	/** Every message the realm side (`b`) received, in arrival order. */
	received: unknown[];
	/** Posts straight onto the realm side's port (optionally transferring ports). */
	postRaw(message: unknown, transfer?: unknown[]): void;
	close(): void;
}

/** Opens a channel. */
export function createChannel(): IChannel {
	const { port1, port2 } = new MessageChannel();
	const received: unknown[] = [];
	// The tap records everything the realm side receives, subscribers or not.
	port2.addEventListener('message', (event: MessageEvent) => {
		deliveries++;
		received.push(event.data);
	});
	const wrap = (port: MessagePort): IBusEndpoint => ({
		post: (message) => port.postMessage(message),
		subscribe(cb) {
			const handler = (event: MessageEvent): void => {
				if (port === port1) deliveries++;
				cb(event.data);
			};
			port.addEventListener('message', handler);
			port.start();
			return () => port.removeEventListener('message', handler);
		},
	});
	port2.start();
	// A test that forgets to close must not hold the process open.
	(port1 as unknown as { unref(): void }).unref();
	(port2 as unknown as { unref(): void }).unref();
	return {
		a: wrap(port1),
		b: wrap(port2),
		received,
		postRaw: (message, transfer) => port2.postMessage(message, (transfer ?? []) as never),
		close() {
			port1.close();
			port2.close();
		},
	};
}

/** Options for {@link openRealm}. */
export interface IOpenRealmOptions {
	/** Expose `post`/`rawRequest` for crafted envelopes (the realm bus is not attached). */
	raw?: boolean;
	/** Capabilities granted (default `core`, `pipelines.run`, `fs.app`). */
	caps?: readonly string[];
	viewId?: string;
	version?: number;
}

/** What a test drives. */
export interface IOpenedRealm {
	realmId: string;
	/** The realm's local op bus (handlers a realm registers live here). */
	bus: IOpBus;
	retained: IRetainedPort;
	/** Every message the realm's port received (raw `__rrbus` envelopes). */
	received: unknown[];
	request(op: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
	emit(op: string, params?: unknown): void;
	/** Raw mode: post a crafted message to the root. */
	post(message: unknown, transfer?: unknown[]): void;
	/** Raw mode: post a crafted `request` envelope and return the root's `response` envelope. */
	rawRequest(op: string, params: unknown, transfer?: unknown[]): Promise<{ ok: boolean; result?: unknown; error?: string } | undefined>;
	detach(): void;
	close(): void;
}

let rawSeq = 0;

/** Attaches a realm for `entry` to `root` over a real structured-clone channel. */
export function openRealm(root: IAppRoot, entry: IsolatedEntry, options: IOpenRealmOptions = {}): IOpenedRealm {
	const channel = createChannel();
	const grant = { caps: options.caps ?? ['core', 'pipelines.run', 'fs.app'] };
	const realmId = root.attach(entry, channel.a, { capabilities: grant.caps, viewId: options.viewId ?? `view-${entry.id}`, version: options.version ?? entry.registryVersion ?? 1 });
	const bus = createOpBus();
	let attachment: IRealmAttachment | null = null;
	if (!options.raw) attachment = attachRealmToRoot(bus, channel.b);
	const noRetained: IRetainedPort = {
		publish() {},
		signal() {},
		subscribe: () => () => {},
		read: async () => undefined,
	};
	return {
		realmId,
		bus,
		retained: attachment?.retained ?? noRetained,
		received: channel.received,
		request: (op, params, timeoutMs) => bus.request(op, params, timeoutMs === undefined ? undefined : { timeoutMs }),
		emit: (op, params) => bus.emitOp(op, params),
		post: (message, transfer) => channel.postRaw(message, transfer),
		async rawRequest(op, params, transfer) {
			const id = `raw-${++rawSeq}`;
			channel.postRaw({ [ENVELOPE]: 'request', id, op, params, timeoutMs: 5000 }, transfer);
			// The channel's `b` endpoint is the realm side: the response lands in `received`.
			const started = Date.now();
			for (;;) {
				const hit = channel.received.find((m) => (m as Record<string, unknown>)?.[ENVELOPE] === 'response' && (m as Record<string, unknown>).id === id) as { ok: boolean; result?: unknown; error?: string } | undefined;
				if (hit) return hit;
				if (Date.now() - started > 4000) return undefined;
				await new Promise((resolve) => setImmediate(resolve));
			}
		},
		detach() {
			attachment?.detach();
			root.detach(realmId);
		},
		close() {
			attachment?.detach();
			channel.close();
		},
	};
}

// =============================================================================
// ENVELOPE HELPERS
// =============================================================================

/** Builds a DAP request: `{type: 'request', seq: 1, command, arguments, ...top}`. */
export function dap(command: string, args?: Record<string, unknown>, top: Record<string, unknown> = {}): DAPMessage {
	return { type: 'request', seq: 1, command, ...(args !== undefined ? { arguments: args } : {}), ...top } as DAPMessage;
}

/** Sends `client.request {message, timeout}` and returns the opened-as-data `IWireEnvelope`. */
export async function clientRequest(realm: IOpenedRealm, message: DAPMessage, timeout?: number): Promise<IWireEnvelope> {
	return (await realm.request('client.request', { message, ...(timeout !== undefined ? { timeout } : {}) })) as IWireEnvelope;
}

/** The DAP response body of an `ok` envelope (throws on a denial or failure). */
export function bodyOf(envelope: IWireEnvelope): Record<string, unknown> {
	const response = openEnvelope(envelope) as DAPMessage;
	return (response.body ?? {}) as Record<string, unknown>;
}

/** True when the value is an `IWireEnvelope` error. */
export function isErrorEnvelope(value: unknown): value is Extract<IWireEnvelope, { ok: false }> {
	return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false && isWireError((value as { error?: unknown }).error);
}
