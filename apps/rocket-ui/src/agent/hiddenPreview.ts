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
// HIDDEN PREVIEW — a preview of one app that only the agent's check sees
// =============================================================================

/**
 * check_app builds an app in a preview. When the user has none open, the agent host boots one here for the
 * length of one check: the same session, page and handshake as the App Builder's Design preview, in an
 * iframe the user never sees. The check disposes it, so nothing keeps running after it.
 */

import { ConnectionManager, type RocketRideClient } from 'shell';
import type { WatchStatus } from 'shared/tools/appdev';
import { createDevPreviewPage } from '../surfaces/preview/session/devPreviewPage';
import { WebDevSession } from '../surfaces/preview/session/devSession';
import { answerPreviewMessage } from '../surfaces/preview/session/previewHandshake';

/** How long boot plus the first build may take. Measured at 0.7 s locally; the rest is room for slow networks inside check_app's 60 s build wait. */
const BOOT_TIMEOUT_MS = 30_000;

/** Offscreen at full size rather than display:none, so an app that measures itself lays out as it would in view. */
const OFFSCREEN_STYLE = 'position:fixed;left:-20000px;top:0;width:1200px;height:800px;border:none;';

/**
 * Boots a hidden preview for one app: a new WebDevSession (open() loads its files as models), an offscreen
 * iframe on createDevPreviewPage(appId) with the legacy /?appid=<id>&rrdev=1 fallback, and the shared
 * handshake with the builder's own token (ConnectionManager.getInstance().loadToken()). Resolves once the first
 * build has run. Rejects, after cleaning up, on timeout, abort or open failure.
 *
 * @param client - The connected client the session builds with.
 * @param app - The app: its manifest id, its folder under apps/ and its display name.
 * @param opts - The run's stop signal, and how long the boot may take (default 30 s).
 * @returns The attached session, and dispose(), which removes the iframe and ends the session.
 */
export function bootHiddenPreview(client: RocketRideClient, app: { id: string; folder: string; name: string }, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ session: WebDevSession; dispose(): void }> {
	const { signal, timeoutMs = BOOT_TIMEOUT_MS } = opts;
	const session = new WebDevSession(client, app.id, app.folder, app.name);
	const frame = document.createElement('iframe');
	frame.style.cssText = OFFSCREEN_STYLE;
	frame.setAttribute('aria-hidden', 'true');
	frame.tabIndex = -1;
	let revokePage: (() => void) | undefined;
	let onMessage: ((e: MessageEvent) => void) | undefined;
	let disposed = false;

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		if (onMessage) window.removeEventListener('message', onMessage);
		frame.remove();
		revokePage?.();
		session.dispose();
	};

	const boot = async (): Promise<void> => {
		// step: open() reports a failure on the watch feed rather than by throwing
		let opened: WatchStatus = { state: 'idle' };
		const unwatch = session.subscribeWatch((status) => {
			opened = status;
		});
		await session.open();
		unwatch();
		if (opened.state === 'error') throw new Error(`the app could not be opened: ${opened.reason ?? 'no reason reported'}`);

		const page = await createDevPreviewPage(app.id).catch(() => null);
		// step: a boot given up on while the page was made has already cleaned up, so the page is the last thing to drop
		if (disposed) {
			page?.revoke();
			return;
		}
		revokePage = page?.revoke;

		// step: the listener stays until dispose(), because the check reads the console and errors it forwards
		const built = new Promise<void>((resolve, reject) => {
			onMessage = (e: MessageEvent): void => {
				const win = frame.contentWindow;
				if (!win || e.source !== win) return;
				void answerPreviewMessage(session, win, e.data, () => ConnectionManager.getInstance().loadToken())?.then(resolve, reject);
			};
			window.addEventListener('message', onMessage);
		});
		frame.src = page?.url ?? `${window.location.origin}/?appid=${encodeURIComponent(app.id)}&rrdev=1`;
		document.body.appendChild(frame);
		await built;
	};

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => fail(new Error(`the preview did not start within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
		const onAbort = (): void => fail(new Error('the run was stopped'));
		const stopWaiting = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
		};
		function fail(err: unknown): void {
			stopWaiting();
			dispose();
			reject(err);
		}
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener('abort', onAbort, { once: true });
		boot().then(() => {
			stopWaiting();
			if (!disposed) resolve({ session, dispose });
		}, fail);
	});
}
