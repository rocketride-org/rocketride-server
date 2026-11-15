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
 * One hidden preview the agent reads and acts on for a turn (AgentHost.openAppPage). The page jobs live
 * here and in pageDom.ts: waiting until the app shows the latest edit, taking turns (check_app borrows
 * the page through lend), the actions, the outline and its refs, the errors and dialogs the page raised,
 * the pipelines the app started, and the copy the user watches (watch.ts). The agent gets an AppPage and
 * sees only domain results.
 *
 * Lifetime: the page closes itself when `lifetime` aborts, also when that happens mid-boot or right
 * after it, and when an action takes it off the app. Closing takes the copy out of the user's view,
 * stops the pipelines the app started, then disposes the preview. close() runs once, however many times
 * it is asked.
 */

import type { RocketRideClient } from 'shell';
import { PageGoneError, type ActionOutcome, type AppPage, type PageAction, type PageProblem, type PageUse, type PreviewApp, type PreviewLease } from 'shared/modules/agent/host';
import { BENIGN_ERROR } from 'shared/modules/agent/toolkits/appCheck';
import { messageOf, sleep } from 'shared/modules/agent/toolkits/common';
import type { WebDevSession } from '../surfaces/preview/session/devSession';
import { agentDevSession } from './agentHost';
import { bootHiddenPreview, type HiddenPreview } from './hiddenPreview';
import { accessibleName, act, answerDialogs, fieldState, findText, holdNewTabs, readOutline, RefBook, untilQuiet, type ElementAction } from './pageDom';
import { PAGE_TEXT } from './pageText';
import { publishWatch, type WatchHandle } from './watch';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The longest the page waits for the app to adopt an edit, build and load before it reads anyway (a not_ready problem). Covers the shell's 15 s descriptor timeout. */
const READY_LIMIT_MS = 20_000;

/** The page counts as settled after this long with no DOM change, capped at QUIET_CAP_MS. */
const QUIET_MS = 300;
const QUIET_CAP_MS = 3_000;

/** How often wait_for looks for its text. */
const WAIT_POLL_MS = 100;

/** How long closing may spend stopping the app's pipelines before it takes the preview down anyway. */
const STOP_RUNS_LIMIT_MS = 3_000;

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
	// step: the shell announces its dev hooks before any app code runs, on the first load and after every
	// reload, so a pipeline the app starts as it mounts is recorded too, and a dialog it raises then is answered
	const runs = new RunRecorder();
	const dialogs = new DialogLog();
	const onDevReady = (win: Window): void => {
		runs.watch(win);
		dialogs.watch(win);
	};
	// step: an abort during the boot disposes the preview and rejects inside bootHiddenPreview
	const hidden = await bootHiddenPreview(client, app, { signal: opts.lifetime, onDevReady });
	const page = new HostedPage(client, hidden, runs, dialogs, publishWatch({ conversationId: opts.conversationId, appId: app.id, appName: app.name, frame: hidden.frame }));
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
	/** Uses, and checks the page is lent to, take turns in arrival order. */
	private readonly lock = new PageLock();
	/** Element refs for this page; they reset only with the page (the turn). */
	private readonly refs = new RefBook();
	private closing: Promise<void> | null = null;
	/** The app's address in the frame when it opened, without query and hash: any other address means the page left the app. */
	private readonly home: string | null;

	/**
	 * @param client - The builder's client, which stops the app's runs that the preview's own client can't.
	 * @param hidden - The booted preview.
	 * @param runs - The pipelines the app started in it.
	 * @param dialogs - What the page's dialogs said, answered for its whole life.
	 * @param watch - The copy as the user watches it.
	 */
	constructor(
		private readonly client: RocketRideClient,
		private readonly hidden: HiddenPreview,
		private readonly runs: RunRecorder,
		private readonly dialogs: DialogLog,
		private readonly watch: WatchHandle
	) {
		this.home = addressOf(hidden.frame.contentWindow);
	}

	private get session(): WebDevSession {
		return this.hidden.session;
	}

	async use(actions: readonly PageAction[], signal: AbortSignal): Promise<PageUse> {
		const release = await this.lock.acquire(signal);
		// step: a call that runs out of time waiting for the page still ends as a result
		if (!release) return { outcomes: actions.map(() => NOT_RUN), outline: [], problems: [{ kind: 'not_ready', text: PAGE_TEXT.busy }] };
		try {
			// step: a page that closed or left the app is gone. Only this throws, before anything ran, because
			// the agent then runs the same actions on a fresh copy
			const win = this.window();
			this.runs.watch(win);
			this.dialogs.watch(win);
			// step: this page is now the one its chat and its app's Design area show
			this.watch.touch();
			const feed = ProblemFeed.start(this.session);
			try {
				const before = await this.ready(win, signal);
				const problems = [...before.problems];
				// step: a failed build leaves a stale or broken page, so nothing is acted on
				const outcomes = before.built ? await this.steps(win, actions, signal) : actions.map(() => NOT_RUN);
				// step: an edit planned after this call in the same wave may have rebuilt the app under the actions
				if (outcomes.some((outcome) => outcome.status !== 'not_run') && !this.leftApp()) problems.push(...(await this.ready(win, signal)).problems);
				const left = this.leftApp();
				const outline = left ? [] : readOutline(win, this.refs);
				// step: console rows the preview posted during the last settle arrive a task later
				await nextTask();
				// step: a dialog no action raised (on load, between actions or uses, during a check) is told here
				const dialogs = this.dialogs.take().map((text): PageProblem => ({ kind: 'dialog', text }));
				const use: PageUse = { outcomes, outline, problems: [...problems, ...feed.take(), ...dialogs] };
				// step: a page off the app can't be used again; the next call opens a fresh copy
				if (left) void this.close();
				return use;
			} finally {
				feed.stop();
			}
		} finally {
			release();
		}
	}

	async lend(signal?: AbortSignal): Promise<PreviewLease> {
		const release = await this.lock.acquire(signal);
		if (!release) return { ok: false, why: PAGE_TEXT.checkStopped };
		try {
			// step: the same gone check as a use: a page that closed or left the app while the check waited has nothing to lend
			this.window();
		} catch (err) {
			release();
			return { ok: false, why: messageOf(err) };
		}
		return { ok: true, session: agentDevSession(this.session), release };
	}

	/** Takes the copy out of view, stops the pipelines the app started, then takes the preview down. Runs once; later calls get the same promise. */
	close(): Promise<void> {
		this.closing ??= (async () => {
			// step: the user stops seeing it at once, before the pipelines are stopped
			this.watch.retract();
			try {
				// step: before the frame goes, so the preview's own connection can stop what it started
				await this.runs.stopAll(this.hidden.frame.contentWindow, this.client, STOP_RUNS_LIMIT_MS);
			} finally {
				this.hidden.dispose();
			}
		})();
		return this.closing;
	}

	/**
	 * Waits until the app shows the latest work, then for the DOM to go quiet.
	 *
	 * @returns Whether the latest build worked, and the not_ready problems: a failed build, or an app that
	 *   had not loaded in time.
	 */
	private async ready(win: Window, signal: AbortSignal): Promise<{ built: boolean; problems: PageProblem[] }> {
		const started = Date.now();
		const settled = await this.session.settled({ signal, limitMs: READY_LIMIT_MS });
		const problems: PageProblem[] = [];
		if (settled.watch.state === 'error') problems.push({ kind: 'not_ready', text: PAGE_TEXT.buildFailed(settled.watch.reason) });
		else if (!settled.loaded) problems.push({ kind: 'not_ready', text: PAGE_TEXT.notLoaded(Math.round((Date.now() - started) / 1000)) });
		await untilQuiet(win, { quietMs: QUIET_MS, capMs: QUIET_CAP_MS, signal });
		return { built: settled.watch.state !== 'error', problems };
	}

	/** The actions in order, up to the first that doesn't finish. Once the call's deadline passes, the next action fails as out of time. */
	private async steps(win: Window, actions: readonly PageAction[], signal: AbortSignal): Promise<ActionOutcome[]> {
		const outcomes: ActionOutcome[] = [];
		for (const action of actions) {
			const last = outcomes.at(-1);
			if (last && last.status !== 'done') outcomes.push(NOT_RUN);
			else if (signal.aborted) outcomes.push({ status: 'failed', why: PAGE_TEXT.outOfTime });
			// step: a failed action is an outcome, never a throw
			else outcomes.push(await this.step(win, action, signal).catch((err: unknown): ActionOutcome => ({ status: 'failed', why: messageOf(err) })));
		}
		return outcomes;
	}

	/**
	 * One action: find its element, outline it where the user watches, act with the page's new tabs held,
	 * then wait for quiet. It takes the notes of the dialogs raised meanwhile.
	 */
	private async step(win: Window, action: PageAction, signal: AbortSignal): Promise<ActionOutcome> {
		if (action.kind === 'wait_for') return this.waitFor(win, action.text, action.timeoutMs, signal);
		let el = this.aim(win.document, action);
		// step: the user sees the target first, and the page can change meanwhile, so it is found again.
		// A key with no ref goes to the focus, which is no target of its own
		if (typeof el !== 'string' && action.ref) {
			await this.watch.highlight(el);
			el = this.aim(win.document, action);
		}
		if (typeof el === 'string') return { status: 'failed', why: el };
		// step: named as it was before the action; a key with no ref has no element of its own to name
		const target = action.ref ? accessibleName(el) || undefined : undefined;
		const doc = win.document;
		const revision = this.session.revision;
		const field = fieldState(el);
		const dialogsFrom = this.dialogs.mark();
		const tabs = holdNewTabs(win);
		try {
			// step: watched from before the action, because a plain handler changes the DOM while the event runs
			const quieting = untilQuiet(win, { quietMs: QUIET_MS, capMs: QUIET_CAP_MS, signal });
			const refused = act(win, el, action);
			if (refused) return { status: 'failed', target, why: refused };
			const quiet = await quieting;
			// step: a plain link or a form post takes the frame off the app's page, and the dev hooks with it
			if (this.leftApp()) return { status: 'failed', target, why: PAGE_TEXT.leftApp };
			const notes = [...this.dialogs.take(dialogsFrom), ...tabs.said()];
			const reloaded = win.document !== doc;
			if (reloaded) notes.push(PAGE_TEXT.reloaded);
			// a reload links the app again too, so only a new link in the same document means a file changed
			else if (this.session.revision !== revision) notes.push(PAGE_TEXT.rebuilt);
			// step: a typed value or a chosen option is a property, which the DOM watch never sees change
			const changed = quiet.changed || reloaded || fieldState(el) !== field;
			return { status: 'done', target, changed, notes };
		} finally {
			tabs.restore();
		}
	}

	/** The element an action aims at, or why there is none. A key with no ref goes where the page has put its focus, as a person's would. */
	private aim(doc: Document, action: ElementAction): Element | string {
		if (!action.ref) return doc.activeElement ?? doc.documentElement;
		const el = this.refs.find(action.ref, doc);
		if (el === 'gone') return PAGE_TEXT.refGone(action.ref);
		if (el === 'unknown') return PAGE_TEXT.refUnknown(action.ref);
		return el;
	}

	/** Looks for the text every WAIT_POLL_MS until it shows, its time is up, or the call's deadline passes. */
	private async waitFor(win: Window, text: string, timeoutMs: number, signal: AbortSignal): Promise<ActionOutcome> {
		const until = Date.now() + timeoutMs;
		for (let looks = 0; ; looks++) {
			// step: a page off the app has no document of the app's to read
			if (this.leftApp()) return { status: 'failed', why: PAGE_TEXT.leftApp };
			if (findText(win.document, text)) return { status: 'done', changed: looks > 0, notes: [] };
			if (signal.aborted) return { status: 'failed', why: PAGE_TEXT.outOfTime };
			if (Date.now() >= until) return { status: 'failed', why: PAGE_TEXT.notFound(Math.round(timeoutMs / 1000)) };
			await sleep(WAIT_POLL_MS, signal);
		}
	}

	/** Whether the frame is off the app's page: a link or a form took it elsewhere, or it is gone. */
	private leftApp(): boolean {
		return addressOf(this.hidden.frame.contentWindow) !== this.home;
	}

	/**
	 * The preview's window while the page still shows the app. Re-read on every use: only the frame is
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

// =============================================================================
// THE PAGE'S DIALOGS
// =============================================================================

/**
 * The page's dialogs, answered for its whole life (pageDom answerDialogs), and what each said until it is
 * taken: an action takes the ones raised while it ran, and a use takes the rest as problems, including
 * those raised on load, between uses, or while a check held the page.
 */
class DialogLog {
	private readonly notes: string[] = [];

	/** Answers the dialogs of the window's current document. Safe to call again for the same document. */
	watch(win: Window): void {
		answerDialogs(win, (note) => this.notes.push(note));
	}

	/** Where the log stands now, for take() to start from. */
	mark(): number {
		return this.notes.length;
	}

	/** The notes from `from` on (all of them by default), taken out of the log. */
	take(from = 0): string[] {
		return this.notes.splice(from);
	}
}

// =============================================================================
// THE APP'S PIPELINES
// =============================================================================

/** Marks a realm's client class as wrapped, so watching the same realm again wraps nothing. */
const RECORDED = Symbol('use_app records runs');

/** A client that can stop a run. */
interface Terminator {
	terminate(token: string): Promise<void>;
}

/** A client's use() as the recorder wraps it: the server's answer carries the run's token, and `reused` when it found a run someone else started. */
type UseCall = (...args: unknown[]) => Promise<{ token?: unknown; reused?: unknown } | undefined>;

/**
 * The pipelines the app started in this page, stopped when it closes. A pipeline the app starts with
 * client.use() is an EXECUTE task that outlives the page's connection (up to 15 min idle), so closing the
 * frame alone leaves it running.
 *
 * Recording: the preview shell shares its `rocketride` SDK module with the app through
 * `__rrShellDev.getShareScope()`, and its own connection builds its client from that same module.
 * Wrapping `RocketRideClient.prototype.use` there catches every client in that realm: the shell's, one it
 * makes again on reconnect, its bus proxy (a subclass that keeps `use`), and one the app makes itself.
 * A run the server marks `reused` (useExisting found it running) is someone else's, maybe the user's own
 * preview's, so it is not recorded. An app that bundles its own SDK copy isn't seen.
 *
 * Stopping: through the preview's own client first (same connection, so the server's task.control check
 * passes), then the builder's for any it couldn't stop (a page that left the app has no client).
 * Best effort, capped, never throws.
 */
class RunRecorder {
	private readonly tokens = new Set<string>();

	/** Records from now on in the window's current realm. Safe to call again: a realm already wrapped is skipped. */
	watch(win: Window): void {
		const sdk = shareScope(win)?.rocketride as { RocketRideClient?: { prototype: { use?: UseCall } } } | undefined;
		const proto = sdk?.RocketRideClient?.prototype;
		const use = proto?.use;
		if (!proto || typeof use !== 'function' || Object.hasOwn(proto, RECORDED)) return;
		const tokens = this.tokens;
		// step: the realm's own promise comes back, so the app awaits what it always did
		proto.use = function (this: unknown, ...args: unknown[]) {
			return use.apply(this, args).then((out) => {
				if (typeof out?.token === 'string' && out.reused !== true) tokens.add(out.token);
				return out;
			});
		};
		Object.defineProperty(proto, RECORDED, { value: true });
	}

	/** Stops every recorded pipeline, waiting at most `limitMs`. An ended run refuses terminate; that is the common case, and fine. */
	async stopAll(win: Window | null, builder: Terminator, limitMs: number): Promise<void> {
		if (!this.tokens.size) return;
		const preview = previewClient(win);
		const stop = async (token: string): Promise<void> => {
			try {
				await (preview ?? builder).terminate(token);
			} catch {
				if (preview) await builder.terminate(token).catch(() => undefined);
			}
		};
		const tokens = [...this.tokens];
		this.tokens.clear();
		const waited = new AbortController();
		await Promise.race([Promise.all(tokens.map(stop)), sleep(limitMs, waited.signal)]);
		waited.abort();
	}
}

/** The preview realm's shared modules; null for a shell without dev hooks, or a page now on another origin. */
function shareScope(win: Window | null): Record<string, unknown> | null {
	try {
		return (win as (Window & { __rrShellDev?: { getShareScope?: () => Record<string, unknown> | undefined } }) | null)?.__rrShellDev?.getShareScope?.() ?? null;
	} catch {
		return null;
	}
}

/** The client the preview's shell connects with, which started the app's runs. */
function previewClient(win: Window | null): Terminator | null {
	try {
		return (shareScope(win)?.shell as { getClient?: () => Terminator | null } | undefined)?.getClient?.() ?? null;
	} catch {
		return null;
	}
}
