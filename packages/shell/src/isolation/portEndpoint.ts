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
// PORT ENDPOINT — a MessagePort as a bus endpoint (PR2b, plan §3.3)
// =============================================================================
//
// Used on both sides of an isolated app's bridge: the shell keeps `port1` for
// the realm, the guest receives `port2` with `rr:bridge:init`.
// =============================================================================

import type { IBusEndpoint } from '../ops/busBridge';

/** The slice of `MessagePort` the endpoint uses. */
export interface IPortLike {
	postMessage(message: unknown): void;
	addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
	removeEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
	start?(): void;
	close?(): void;
}

/**
 * Wraps a port.
 *
 * @param port - A `MessagePort` (or a look-alike).
 * @param onClosed - Called once when the port reports `close` (where the runtime supports it).
 * @returns The endpoint, plus `close()`.
 */
export function portEndpoint(port: IPortLike, onClosed?: () => void): IBusEndpoint & { close(): void } {
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		try {
			port.close?.();
		} catch {
			/* already closed */
		}
	};
	if (onClosed) {
		(port as unknown as { addEventListener(t: string, l: () => void): void }).addEventListener('close', () => {
			if (!closed) onClosed();
		});
	}
	return {
		post(message: unknown): void {
			if (!closed) port.postMessage(message);
		},
		subscribe(cb: (message: unknown) => void): () => void {
			const listener = (ev: { data: unknown }): void => cb(ev.data);
			port.addEventListener('message', listener);
			port.start?.();
			return () => port.removeEventListener('message', listener);
		},
		close,
	};
}
