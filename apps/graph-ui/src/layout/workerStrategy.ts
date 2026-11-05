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
// LAYOUT - WORKER LOADING STRATEGY (pure decision logic)
// =============================================================================
//
// Where the layout worker's script comes from decides whether the browser lets
// the page start it. A Worker's script must be same-origin with the page, and:
//
//   - PRODUCTION: the engine serves the shell and every app from one origin, so
//     the worker script is same-origin and is started directly. If it ever is
//     not (a CDN-hosted remote), that is reported, not worked around: the layout
//     falls back to the grid and the Table stays available.
//   - DEVELOPMENT: `shell:dev` plus an app dev server is two origins. There the
//     worker is started through a small blob wrapper that shadows `self.location`
//     with the real script URL and then `importScripts` it. The shadowing is
//     needed because Rspack's automatic public path reads `self.location`, which
//     inside a blob worker is a `blob:` URL, so every later chunk would be
//     fetched from the wrong place (checked against the real build). This
//     path exists only when the build is not a production build; it is never
//     taken silently in production.
//
// Nothing here touches the DOM, so the decision and the wrapper source are
// tested in Node.
// =============================================================================

/** How the worker will be started. */
export type WorkerStrategy = { kind: 'direct' } | { kind: 'dev-shim' } | { kind: 'unavailable'; reason: string };

/** Inputs of the decision. */
export interface IWorkerStrategyInput {
	/** The worker script's URL as the bundler rewrote it (absolute, or relative to the page). */
	workerUrl: string;
	/** The page's URL. */
	pageHref: string;
	/** True for a production build. */
	production: boolean;
	/** Whether `Worker` exists at all. */
	hasWorker: boolean;
}

/** Raised when no layout worker can be started. */
export class LayoutUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LayoutUnavailableError';
	}
}

/**
 * Decide how to start the layout worker.
 *
 * @param input - The worker URL, the page URL and the build mode.
 * @returns The strategy.
 */
export function chooseWorkerStrategy(input: IWorkerStrategyInput): WorkerStrategy {
	if (!input.hasWorker) return { kind: 'unavailable', reason: 'This browser does not support Web Workers.' };
	let worker: URL;
	let page: URL;
	try {
		page = new URL(input.pageHref);
		worker = new URL(input.workerUrl, page);
	} catch {
		return { kind: 'unavailable', reason: 'The layout worker address could not be resolved.' };
	}
	if (worker.origin === page.origin && worker.origin !== 'null') return { kind: 'direct' };
	if (input.production) {
		return { kind: 'unavailable', reason: `The layout worker is served from ${worker.origin}, not from the page's origin ${page.origin}, and browsers only start same-origin workers.` };
	}
	return { kind: 'dev-shim' };
}

/**
 * The source of the dev-only wrapper worker: shadow `self.location` with the
 * real script's URL, then load the script.
 *
 * @param workerUrl - The worker script URL (made absolute by the caller).
 * @returns Script text for a `Blob`.
 */
export function devShimSource(workerUrl: string): string {
	const url = JSON.stringify(workerUrl);
	return [
		'var __graphLayoutUrl = ' + url + ';',
		"try { Object.defineProperty(self, 'location', { value: { href: __graphLayoutUrl, toString: function () { return __graphLayoutUrl; } }, configurable: true }); } catch (e) { postMessage({ type: 'error', requestId: -1, message: 'location shim failed: ' + e }); }",
		'importScripts(__graphLayoutUrl);',
	].join('\n');
}
