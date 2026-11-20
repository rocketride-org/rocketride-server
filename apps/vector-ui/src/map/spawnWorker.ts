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
// MAP - STARTING THE LAYOUT WORKER (the one file that talks to the bundler)
// =============================================================================
//
// `new Worker(new URL('./layout.worker.ts', import.meta.url))` must appear
// LITERALLY: Rspack only bundles a worker when the constructor call carries the
// URL expression inline (the same rule as Graph Explorer's layout worker).
//
// The literal call is made once with `Worker` temporarily replaced by a
// recorder, to learn the URL the bundler rewrote it to without starting
// anything; the real worker is then started from that URL by the strategy in
// workerStrategy.ts. The swap is synchronous and restored in a `finally`.
//
// Not imported by any test: it needs a bundler and a browser. Its decisions are
// tested through workerStrategy.ts; the built output runs in the browser lanes.
// =============================================================================

import type { ILayoutWorkerLike } from './workerClient';
import { LayoutUnavailableError, chooseWorkerStrategy, devShimSource } from './workerStrategy';

/** The worker's name in the browser's tools. */
const WORKER_NAME = 'vector-map-layout';

/**
 * Learn the URL the bundler gives the worker chunk.
 *
 * @returns The worker script URL as a string.
 */
function captureWorkerUrl(): string {
	const native = globalThis.Worker;
	let seen = '';
	(globalThis as unknown as { Worker: unknown }).Worker = class {
		constructor(url: string | URL) {
			seen = String(url);
		}
	};
	try {
		new Worker(new URL('./layout.worker.ts', import.meta.url), { name: 'vector-map-layout' });
	} finally {
		(globalThis as unknown as { Worker: unknown }).Worker = native;
	}
	return seen;
}

/**
 * Start the layout worker, or throw {@link LayoutUnavailableError} saying why not.
 *
 * @returns A running worker.
 */
export function spawnLayoutWorker(): ILayoutWorkerLike {
	if (typeof globalThis.Worker !== 'function') throw new LayoutUnavailableError('This browser does not support Web Workers.');
	const url = captureWorkerUrl();
	const strategy = chooseWorkerStrategy({ workerUrl: url, pageHref: globalThis.location.href, production: process.env.NODE_ENV === 'production', hasWorker: true });
	if (strategy.kind === 'unavailable') throw new LayoutUnavailableError(strategy.reason);
	const absolute = new URL(url, globalThis.location.href).href;
	if (strategy.kind === 'direct') return new globalThis.Worker(absolute, { name: WORKER_NAME }) as unknown as ILayoutWorkerLike;
	// Development, two origins: see workerStrategy.ts for why this wrapper exists.
	console.info('[vector-ui] development build: starting the map layout worker through a location-shadowing wrapper (the app is served from another origin than the shell)');
	const blob = new Blob([devShimSource(absolute)], { type: 'text/javascript' });
	return new globalThis.Worker(URL.createObjectURL(blob), { name: WORKER_NAME }) as unknown as ILayoutWorkerLike;
}
