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
// APP PAGE — the agent's own copy of an app, for use_app
// =============================================================================

/**
 * One hidden preview the agent reads for a turn (AgentHost.openAppPage). The page jobs live here and in
 * pageDom.ts: waiting until the app shows the latest edit, taking turns, the outline and its refs, and
 * the errors the page raised. The agent gets an AppPage and sees only domain results.
 *
 * Lifetime: the page closes itself when `lifetime` aborts, also when that happens mid-boot or right
 * after it. close() runs once, however many times it is asked.
 */

import type { RocketRideClient } from 'shell';
import { PageGoneError, type ActionOutcome, type AppPage, type PageAction, type PageProblem, type PageUse, type PreviewApp } from 'shared/modules/agent/host';
import { BENIGN_ERROR } from 'shared/modules/agent/toolkits/appCheck';
import type { WebDevSession } from '../surfaces/preview/session/devSession';
import { bootHiddenPreview, type HiddenPreview } from './hiddenPreview';
import { readOutline, RefBook, untilQuiet } from './pageDom';
import { PAGE_TEXT } from './pageText';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The longest the page waits for the app to adopt an edit, build and load before it reads anyway (a not_ready problem). Covers the shell's 15 s descriptor timeout. */
const READY_LIMIT_MS = 20_000;

/** The page counts as settled after this long with no DOM change, capped at QUIET_CAP_MS. */
const QUIET_MS = 300;
const QUIET_CAP_MS = 3_000;

/** Console rows the builder writes into the same feed: they are about the build, not the app. */
const BUILD_LINE = /^\[(?:link|deps|hmr|types)\]/;

/** How the shell's error boundary reports a render crash (AppErrorBoundary.tsx). */
const CRASH_LINE = /App crashed:/;

const NOT_RUN: ActionOutcome = { status: 'not_run' };

// =============================================================================
// OPEN
// =============================================================================

/**
 * Opens the agent's copy of an app (AgentHost.openAppPage, after the host's team check).
 *
 * @throws When the preview did not start, or `lifetime` aborted before it did.
 */
export async function openAppPage(client: RocketRideClient, app: PreviewApp, opts: { lifetime: AbortSignal; conversationId: string }): Promise<AppPage> {
	// step: an abort during the boot disposes the preview and rejects inside bootHiddenPreview
	const hidden = await bootHiddenPreview(client, app, { signal: opts.lifetime });
	const page = new HostedPage(hidden);
	// step: the turn may have ended between the boot resolving and here
	if (opts.lifetime.aborted) {
		await page.close();
		throw new Error(PAGE_TEXT.turnEndedWhileStarting);
	}
	opts.lifetime.addEventListener('abort', () => void page.close(), { once: true });
	return page;
}

// =============================================================================
// THE PAGE
// =============================================================================

/** The AppPage behind openAppPage. Not exported: the agent reaches it only through the interface. */
class HostedPage implements AppPage {
	/** Uses take turns, in arrival order. */
	private readonly lock = new PageLock();
	/** Element refs for this page; they reset only with the page (the turn). */
	private readonly refs = new RefBook();
	private closing: Promise<void> | null = null;
	/** The app's address in the frame when it opened, without query and hash: any other address means the page left the app. */
	private readonly home: string | null;

	constructor(private readonly hidden: HiddenPreview) {
		this.home = addressOf(hidden.frame.contentWindow);
	}

	private get session(): WebDevSession {
		return this.hidden.session;
	}

	async use(actions: readonly PageAction[], signal: AbortSignal): Promise<PageUse> {
		if (actions.length > 0) throw new Error('AppPage.use: actions are not supported yet');
		const release = await this.lock.acquire(signal);
		// step: a call that runs out of time waiting for the page still ends as a result
		if (!release) return { outcomes: actions.map(() => NOT_RUN), outline: [], problems: [{ kind: 'not_ready', text: PAGE_TEXT.busy }] };
		try {
			// step: a page that closed or left the app is gone; the next copy needs a new open
			this.window();
			const feed = ProblemFeed.start(this.session);
			try {
				const problems = await this.ready(signal);
				const outline = readOutline(this.window(), this.refs);
				// step: console rows the preview posted during the last settle arrive a task later
				await nextTask();
				return { outcomes: [], outline, problems: [...problems, ...feed.take()] };
			} finally {
				feed.stop();
			}
		} finally {
			release();
		}
	}

	/** Takes the preview down. Runs once; later calls get the same promise. */
	close(): Promise<void> {
		if (!this.closing) {
			this.hidden.dispose();
			this.closing = Promise.resolve();
		}
		return this.closing;
	}

	/**
	 * Waits until the app shows the latest work, then for the DOM to go quiet.
	 *
	 * @returns not_ready problems: a failed build, or an app that had not loaded in time.
	 */
	private async ready(signal: AbortSignal): Promise<PageProblem[]> {
		const started = Date.now();
		const settled = await this.session.settled({ signal, limitMs: READY_LIMIT_MS });
		const problems: PageProblem[] = [];
		if (settled.watch.state === 'error') problems.push({ kind: 'not_ready', text: PAGE_TEXT.buildFailed(settled.watch.reason) });
		else if (!settled.loaded) problems.push({ kind: 'not_ready', text: PAGE_TEXT.notLoaded(Math.round((Date.now() - started) / 1000)) });
		await untilQuiet(this.window(), { quietMs: QUIET_MS, capMs: QUIET_CAP_MS, signal });
		return problems;
	}

	/**
	 * The preview's window while the page still shows the app. Re-read on every call: only the frame is
	 * kept, because a reload replaces the document behind it.
	 *
	 * @throws PageGoneError, after closing the page, once it closed, lost its frame or left the app.
	 */
	private window(): Window {
		const win = this.closing ? null : this.hidden.frame.contentWindow;
		const at = addressOf(win);
		if (win && at !== null && at === this.home) return win;
		const why = this.closing ? PAGE_TEXT.closed : win ? PAGE_TEXT.leftApp : PAGE_TEXT.previewGone;
		void this.close();
		throw new PageGoneError(why);
	}
}

/** The window's address without query and hash, which an app's own routing changes; null when there is none to read. */
function addressOf(win: Window | null): string | null {
	try {
		return win ? win.location.href.split(/[?#]/, 1)[0] : null;
	} catch {
		// a cross-origin page refuses to say where it is
		return null;
	}
}

// =============================================================================
// TAKING TURNS
// =============================================================================

/** A first-come lock: one use holds the page at a time. */
class PageLock {
	private tail: Promise<void> = Promise.resolve();

	/**
	 * Waits for the page, behind everyone already waiting.
	 *
	 * @returns The release, to call once the page is free again; null when `signal` aborted first, and
	 *   then the waiter has left the line without holding up the next one.
	 */
	acquire(signal?: AbortSignal): Promise<(() => void) | null> {
		let leave!: () => void;
		const left = new Promise<void>((resolve) => (leave = resolve));
		const ahead = this.tail;
		this.tail = ahead.then(() => left);
		return new Promise((resolve) => {
			const onAbort = (): void => {
				leave();
				resolve(null);
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener('abort', onAbort, { once: true });
			void ahead.then(() => {
				signal?.removeEventListener('abort', onAbort);
				if (!signal?.aborted) resolve(leave);
			});
		});
	}
}

// =============================================================================
// ERRORS DURING A USE
// =============================================================================

/**
 * The page's console errors, uncaught errors and crashes from the moment a use starts. The session's
 * feeds replay their backlog on subscribe (as check_app's build evidence handles), so rows delivered
 * while subscribing are dropped.
 */
class ProblemFeed {
	private readonly rows: PageProblem[] = [];
	private readonly stops: Array<() => void> = [];

	static start(session: WebDevSession): ProblemFeed {
		const feed = new ProblemFeed();
		let replaying = true;
		feed.stops.push(
			session.subscribeConsole((row) => {
				if (!replaying && row.level === 'error' && fromApp(row.text)) feed.rows.push({ kind: CRASH_LINE.test(row.text) ? 'crash' : 'console', text: row.text });
			}),
			session.subscribeErrors((row) => {
				if (!replaying && fromApp(row.message)) feed.rows.push({ kind: 'error', text: row.message });
			})
		);
		replaying = false;
		return feed;
	}

	/** The rows so far, in order. */
	take(): readonly PageProblem[] {
		return this.rows;
	}

	stop(): void {
		for (const stop of this.stops) stop();
	}
}

/** Whether a feed row is the app's own: build lines and the browser's ResizeObserver notice (BENIGN_ERROR, shared with check_app) are not. */
function fromApp(text: string): boolean {
	return !BUILD_LINE.test(text) && !BENIGN_ERROR.test(text);
}

/** Resolves on the next macrotask, after posted messages queued before it. */
function nextTask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
