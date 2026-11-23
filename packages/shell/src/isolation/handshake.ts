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
// HANDSHAKE — the parent side of one frame's bridge (PR2b, plan §4.1)
// =============================================================================
//
// A pure state machine: `waiting` → `attached` → `detached`. It never touches
// a DOM; `IsolatedAppFrame` feeds it window messages, frame `load`s and the
// port's close, and supplies `admit` (attach the realm and build the init
// through the realm's outbound choke point) and `post`.
//
//   • a ready counts only from the frame window at the exact app origin, and
//     at most 5 of those are looked at per sliding minute (strangers do not use
//     up the frame's budget);
//   • the init is posted once, to that origin, with the guest port only;
//   • a second ready, any `load` after the first, a closed port, a refused
//     init or a failed post detaches, once; nothing ever re-attaches (a Reload
//     builds a new machine from a fresh `/apps/frame` grant).
// =============================================================================

import type { BridgeInit } from './types';

/** Why a realm was detached. */
export type HandshakeDetachReason = 'second-ready' | 'reload' | 'port-closed' | 'denied';

/** The protocol range a ready offers. */
export interface IProtoRange {
	protoMin: number;
	protoMax: number;
}

/** What the machine needs from its host. */
export interface IHandshakeDeps {
	/** The app origin the frame must post from. */
	origin: string;
	/** `source === iframe.contentWindow`. */
	isFrameSource(source: unknown): boolean;
	/** Epoch ms. */
	now(): number;
	/** Attaches the realm and builds the init through the choke point; throws on denial. */
	admit(range: IProtoRange): { init: BridgeInit; port: unknown };
	post(init: BridgeInit, targetOrigin: string, transfer: unknown[]): void;
	detach(reason: HandshakeDetachReason): void;
}

/** A window message as the machine sees it. */
export interface IHandshakeMessage {
	source: unknown;
	origin: string;
	data: unknown;
}

export interface IHandshake {
	onWindowMessage(ev: IHandshakeMessage): void;
	onFrameLoad(): void;
	onPortClosed(): void;
	state(): 'waiting' | 'attached' | 'detached';
}

/** The only protocol version this shell speaks. */
export const BRIDGE_PROTO = 1;

const READY_BUDGET = 5;
const READY_WINDOW_MS = 60_000;

function readyRange(data: unknown): IProtoRange | null {
	if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
	const d = data as Record<string, unknown>;
	if (d.type !== 'rr:frame:ready') return null;
	const { protoMin, protoMax } = d;
	if (!Number.isSafeInteger(protoMin) || !Number.isSafeInteger(protoMax)) return null;
	if ((protoMin as number) < 1 || (protoMax as number) < (protoMin as number)) return null;
	return { protoMin: protoMin as number, protoMax: protoMax as number };
}

/** Builds the machine for one frame document. */
export function createHandshake(deps: IHandshakeDeps): IHandshake {
	let state: 'waiting' | 'attached' | 'detached' = 'waiting';
	let loads = 0;
	const readies: number[] = [];

	const detach = (reason: HandshakeDetachReason): void => {
		if (state === 'detached') return;
		state = 'detached';
		deps.detach(reason);
	};

	return {
		onWindowMessage(ev: IHandshakeMessage): void {
			if (state === 'detached') return;
			if (!ev || typeof ev.origin !== 'string' || ev.origin !== deps.origin) return;
			if (!deps.isFrameSource(ev.source)) return;
			// The budget counts every message from the frame at its origin.
			const t = deps.now();
			while (readies.length && t - readies[0] >= READY_WINDOW_MS) readies.shift();
			if (readies.length >= READY_BUDGET) return;
			readies.push(t);
			const range = readyRange(ev.data);
			if (!range) return;
			if (state === 'attached') {
				detach('second-ready');
				return;
			}
			if (range.protoMin > BRIDGE_PROTO || range.protoMax < BRIDGE_PROTO) return;
			let admitted: { init: BridgeInit; port: unknown };
			try {
				admitted = deps.admit(range);
			} catch {
				detach('denied');
				return;
			}
			state = 'attached';
			try {
				deps.post(admitted.init, deps.origin, [admitted.port]);
			} catch {
				detach('denied');
			}
		},
		onFrameLoad(): void {
			loads += 1;
			if (loads > 1) detach('reload');
		},
		onPortClosed(): void {
			if (state === 'attached') detach('port-closed');
		},
		state: () => state,
	};
}
