// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// PING WORKER — Runs ping in a dedicated Web Worker thread
// =============================================================================
//
// Opens its own WebSocket to the server, authenticates, and pings every 100ms.
// Completely isolated from the main thread — if the main thread is blocked
// processing 32 use() responses, this worker keeps pinging independently.
//
// Messages:
//   Main → Worker: { type: 'start', uri, apiKey } | { type: 'stop' }
//   Worker → Main: { type: 'ping', latency, timestamp }
//                | { type: 'error', message }
//                | { type: 'connected' }
//                | { type: 'stopped' }
// =============================================================================

let ws: WebSocket | null = null;
let running = false;
let seq = 1;
let pendingPing: { seq: number; t0: number } | null = null;

/**
 * Convert an HTTP/HTTPS URI to a WebSocket URI.
 * The URI from getConnectionInfo() already includes the full path.
 */
function toWsUri(uri: string): string {
	return uri.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}

/**
 * Send a DAP message as JSON over the WebSocket.
 */
function send(msg: Record<string, unknown>) {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

/**
 * Handle incoming WebSocket messages from the server.
 */
function onMessage(event: MessageEvent) {
	try {
		const msg = JSON.parse(event.data);

		// Auth response
		if (msg.type === 'response' && msg.command === 'auth') {
			if (msg.success === false) {
				self.postMessage({ type: 'error', message: `Auth failed: ${msg.message}` });
				return;
			}
			// Identify this connection so the dashboard shows a meaningful name
			send({ type: 'request', seq: seq++, command: 'rrext_identify', arguments: { appName: 'Test - ping', clientName: 'Test - ping' } });
			self.postMessage({ type: 'connected' });
			// Start ping loop
			pingLoop();
			return;
		}

		// Ping response
		if (msg.type === 'response' && msg.command === 'rrext_ping' && pendingPing && msg.request_seq === pendingPing.seq) {
			const latency = performance.now() - pendingPing.t0;
			pendingPing = null;
			self.postMessage({ type: 'ping', latency, timestamp: Date.now() });
			return;
		}
	} catch {
		// Ignore parse errors
	}
}

/**
 * Ping loop — sends a ping, waits for response, sleeps 100ms, repeats.
 * Keeps retrying as long as ``running`` is true, even if the WebSocket
 * temporarily leaves the OPEN state (e.g. server backpressure).
 */
async function pingLoop() {
	while (running) {
		// Wait for WebSocket to be open before sending
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			self.postMessage({ type: 'error', message: `Ping WebSocket not open (readyState=${ws?.readyState ?? 'null'})` });
			await new Promise((r) => setTimeout(r, 100));
			continue;
		}

		// Send ping
		const pingSeq = seq++;
		pendingPing = { seq: pingSeq, t0: performance.now() };
		send({
			type: 'request',
			seq: pingSeq,
			command: 'rrext_ping',
			arguments: {},
		});

		// Wait for response (with 5s timeout)
		const waitStart = performance.now();
		while (pendingPing && running && performance.now() - waitStart < 5000) {
			await new Promise((r) => setTimeout(r, 10));
		}

		if (pendingPing) {
			// Timed out — record the timeout latency and report as error
			const latency = performance.now() - pendingPing.t0;
			pendingPing = null;
			self.postMessage({ type: 'ping', latency, timestamp: Date.now() });
			self.postMessage({ type: 'error', message: `Ping timeout: ${latency.toFixed(0)}ms (>${5000}ms)` });
		}

		// Sleep 100ms between pings
		if (running) {
			await new Promise((r) => setTimeout(r, 100));
		}
	}
}

/**
 * Handle messages from the main thread.
 */
self.onmessage = (event: MessageEvent) => {
	const data = event.data;

	if (data.type === 'start') {
		running = true;
		seq = 1;
		pendingPing = null;

		const wsUri = toWsUri(data.uri);
		ws = new WebSocket(wsUri);

		ws.onopen = () => {
			// Authenticate
			send({
				type: 'request',
				seq: seq++,
				command: 'auth',
				arguments: { auth: data.apiKey || '' },
			});
		};

		ws.onmessage = onMessage;

		ws.onerror = () => {
			self.postMessage({ type: 'error', message: 'WebSocket error' });
		};

		ws.onclose = () => {
			running = false;
			self.postMessage({ type: 'stopped' });
		};
	}

	if (data.type === 'stop') {
		running = false;
		if (ws) {
			ws.close();
			ws = null;
		}
		self.postMessage({ type: 'stopped' });
	}
};
