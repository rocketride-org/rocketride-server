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
// LAYOUT - THE WORKER ENTRY (bundled as its own chunk by Rspack)
// =============================================================================
//
// Receives layout requests, runs the force simulation in small steps, and posts
// the positions back. Between steps it yields to its message queue so a newer
// request (or a cancel) is noticed: a superseded job stops silently, and the
// client ignores any answer that is not for its current request anyway.
//
// This file imports d3-force (through layout.core) and nothing else of the app:
// no React, no shell, no wire types. It must stay that way, because the worker
// chunk carries the Module Federation runtime as well and every extra import
// makes it heavier (see README, "Layout worker").
// =============================================================================

import { createLayoutJob } from './layout.core';
import type { ILayoutRequest, LayoutWorkerIn, LayoutWorkerOut } from './protocol';

/** The slice of the worker global this file uses (the DOM lib types `self` as a Window). */
const scope = self as unknown as {
	onmessage: ((event: { data: LayoutWorkerIn }) => void) | null;
	postMessage(message: LayoutWorkerOut): void;
};

/** The request being served; anything else is superseded or cancelled. */
let current = -1;

/** Ticks per step between checks for a newer message and the deadline. */
const STEP_TICKS = 25;

/**
 * Let queued messages run.
 *
 * @returns A promise that resolves on the next turn of the event loop.
 */
function yieldToQueue(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Serve one request.
 *
 * @param request - The layout request.
 */
async function serve(request: ILayoutRequest): Promise<void> {
	const started = performance.now();
	try {
		const job = createLayoutJob(request);
		let timedOut = false;
		while (!job.done) {
			if (current !== request.requestId) return;
			if (performance.now() - started >= request.deadlineMs) {
				timedOut = true;
				break;
			}
			job.step(STEP_TICKS);
			await yieldToQueue();
		}
		if (current !== request.requestId) return;
		scope.postMessage({ type: 'result', requestId: request.requestId, positions: job.positions(), ticks: job.ticks, elapsedMs: performance.now() - started, timedOut });
	} catch (error) {
		if (current === request.requestId) scope.postMessage({ type: 'error', requestId: request.requestId, message: error instanceof Error ? error.message : String(error) });
	}
}

scope.onmessage = (event) => {
	const message = event.data;
	if (!message || typeof message !== 'object') return;
	if (message.type === 'cancel') {
		if (message.requestId === current) current = -1;
		return;
	}
	if (message.type === 'layout') {
		current = message.requestId;
		void serve(message);
	}
};
