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
// DRIVER: the Agent tab in a real browser, as a user drives it
// =============================================================================

/**
 * Playwright on Rocket Builder's Agent tab. The locators come from the
 * rr-verify-agent skill's drive.mjs (origin/feat/rocket-agent-testing) and
 * were checked against this branch's components:
 *
 * - the composer and Send/Stop: shell ChatInputField (Stop shows while a turn runs);
 * - "Needs your OK" cards and "Turn result: <title>" cards: shell MessageList;
 * - the model picker: apps/shared tools/agent/ModelPicker.tsx, whose popup
 *   renders into #rr-popup-portal;
 * - the result card titles: agent turn.ts turnCard.
 *
 * Everything the page sends and receives over its WebSockets, a summary of
 * each HTTP request, and its console go to evidence files, scrubbed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

import { REPO_ROOT } from './catalog';
import type { AppUsed } from './checks/appRun';
import type { Scrubber } from './evidence';
import { APP_ID } from './store';
import type { CardAnswer, CardPolicy, DirtyFileAnswer } from './task';

/** The shell's sign-in token key (packages/shell/src/constants.ts LS_TOKEN). */
const LS_TOKEN = 'rr:user_token';
/** How long the shell waits after Stop before it cuts the turn (turnController.ts STOP_GRACE_MS), plus slack. */
const STOP_GRACE_MS = 3_000 + 7_000;
const LOAD_MS = 180_000;
/** A frame longer than this is cut in the trace, with its full length noted. */
const FRAME_MAX = 1_000_000;

// =============================================================================
// models
// =============================================================================

/** A model as --model names it: provider/model. */
export interface ModelPick {
	provider: string;
	model: string;
}

/**
 * @param spec - provider/model, such as anthropic/claude-haiku-5-5.
 * @returns The provider and model ids.
 */
export function parseModel(spec: string): ModelPick {
	const m = /^([a-z0-9_-]+)\/([A-Za-z0-9._-]+)$/.exec(spec);
	if (!m) throw new Error(`--model is provider/model, such as anthropic/claude-haiku-5-5 (got ${spec})`);
	return { provider: m[1], model: m[2] };
}

/**
 * The titles the picker shows for a model, read from the PROVIDERS table in
 * apps/shared/src/modules/agent/modelEngine.ts, so they follow that file.
 *
 * @param pick - The provider and model ids.
 * @param source - The table's source text (the file by default).
 * @returns The provider's title (its toggle) and the model's title (its row).
 */
export function modelTitles(pick: ModelPick, source?: string): { provider: string; model: string; variable: string } {
	const row = providerRow(pick.provider, source);
	const model = new RegExp(`\\{ model: '${pick.model.replace(/[.]/g, '\\.')}', title: '([^']+)' \\}`).exec(row.block)?.[1];
	if (!model) throw new Error(`the model picker offers no ${pick.model} for ${pick.provider} (modelEngine.ts PROVIDERS)`);
	return { provider: row.title, model, variable: row.variable };
}

/**
 * A provider's row in modelEngine.ts PROVIDERS: its title, the node it runs
 * on and the Variable its key comes from.
 *
 * @param provider - The provider id, such as anthropic.
 * @param source - The table's source text (the file by default).
 */
export function providerRow(provider: string, source?: string): { title: string; service: string; variable: string; block: string } {
	const text = source ?? fs.readFileSync(path.join(REPO_ROOT, 'apps/shared/src/modules/agent/modelEngine.ts'), 'utf8');
	const start = text.search(new RegExp(`\\n\\s*${provider}: \\{`));
	if (start < 0) throw new Error(`modelEngine.ts offers no provider ${provider}`);
	const block = text.slice(start, text.indexOf('\n\t},', start) + 1 || undefined);
	const title = /title: '([^']+)'/.exec(block)?.[1];
	const service = /service: '([^']+)'/.exec(block)?.[1];
	const variable = /variable: '([^']+)'/.exec(block)?.[1];
	if (!title || !service || !variable) throw new Error(`modelEngine.ts: could not read the ${provider} row`);
	return { title, service, variable, block };
}

// =============================================================================
// cards
// =============================================================================

/** The answer a card policy gives an ordinary "Needs your OK" card. */
export function cardAnswer(policy: CardPolicy): CardAnswer {
	return typeof policy === 'string' ? policy : policy.default;
}

/** The answer a card policy gives the unsaved-changes dialog, when it names one. */
export function dirtyFileAnswer(policy: CardPolicy): DirtyFileAnswer | null {
	return typeof policy === 'string' ? null : (policy.dirty_file_prompt ?? null);
}

/**
 * The outcome a "Turn result" card's title stands for (turn.ts turnCard).
 * "Not finished" covers failed and incomplete; any other title is a
 * needs_input card, whose title is its question.
 */
export function outcomeOfCard(title: string): 'done' | 'stopped' | 'failed_or_incomplete' | 'needs_input' {
	if (title === 'Done') return 'done';
	if (title === 'Stopped') return 'stopped';
	if (title === 'Not finished') return 'failed_or_incomplete';
	return 'needs_input';
}

/** One card the runner answered. */
export interface AnsweredCard {
	kind: 'ask' | 'unsaved_changes';
	title: string;
	detail: string;
	answer: string;
	atMs: number;
}

/** How the turn went, as the page showed it. */
export interface TurnRun {
	/** The turn ended on its own, or after Stop. */
	ended: boolean;
	/** The runner pressed Stop at the time limit. */
	stoppedAtLimit: boolean;
	ms: number;
	cards: AnsweredCard[];
	/** The last "Turn result" card: its title and lines. */
	card: { title: string; text: string } | null;
	/** The error banner the turn ended on instead of a card (a turn that threw, such as a refused pasted key), scrubbed. */
	banner?: string;
}

/** Text as a literal inside a RegExp. */
function escapeRe(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =============================================================================
// the driver
// =============================================================================

export interface DriverOptions {
	shellUrl: string;
	/** Open Rocket Builder from the checkout's dev remote (rrdev=1), as on a local stack. */
	devRemote: boolean;
	apiKey: string;
	headed: boolean;
	/** The trial folder: trace.jsonl, console.log, steps.log and screenshots go here. */
	dir: string;
	scrubber: Scrubber;
	/** Sees each WebSocket frame and console line raw, before it is scrubbed: the trial's leak scans. */
	observe?: (surface: 'ws-sent' | 'ws-received' | 'console', text: string) => void;
	/**
	 * Holds the page's first write of one store file while `during` runs, then
	 * lets it through: the user's save landing between the agent's freshness
	 * check (its read) and its write (edit-05). The write is the store's
	 * fs_open with mode w for that path, on the engine's WebSocket.
	 */
	holdWrite?: { storePath: string; during: () => Promise<string> };
}

/**
 * Page code that reads the Design preview's Console rows (LogList.tsx): the
 * list next to the visible "Filter…" box, each row's spans as text (time,
 * level or the source of an uncaught exception, message). null when no list
 * is showing. A string, because this package has no DOM types.
 */
const CONSOLE_ROWS = `(() => {
	const input = Array.from(document.querySelectorAll('input[placeholder="Filter…"]')).find((el) => el.offsetParent !== null);
	const isList = (el) => !!el && el.children.length > 0 && Array.from(el.children).every((r) => r.children.length >= 2 && r.firstElementChild && r.firstElementChild.tagName === 'SPAN');
	let wrap = input ? input.parentElement : null;
	while (wrap && !(wrap.lastElementChild !== wrap.firstElementChild && isList(wrap.lastElementChild))) wrap = wrap.parentElement;
	if (!wrap || !wrap.lastElementChild) return null;
	return Array.from(wrap.lastElementChild.children).map((r) => Array.from(r.children).map((c) => c.textContent || ''));
})()`;

/** A node inside the preview page, as page code sees it (this package has no DOM types): its document's window, where the runner leaves a mark. */
type PageNode = { ownerDocument: { defaultView: Record<string, unknown> } };

/** What the Design preview showed when the runner loaded an app (Driver.appLoad). */
export interface AppLoad {
	/** null when the preview or its Console could not be read. */
	ok: boolean | null;
	detail: string;
	/** The Console's error rows, scrubbed. */
	errors: string[];
	/** The app showed its error screen. */
	crashed: boolean;
}

/** What happened to the write the driver was asked to hold. */
export interface HeldWrite {
	held: boolean;
	/** How long the write waited, in milliseconds. */
	ms: number;
	/** What `during` did, or why it failed. */
	detail: string;
}

/** Whether a frame the page sends opens a store file for writing (rrext_store fs_open, mode w). */
export function isWriteOpen(frame: string, storePath: string): boolean {
	try {
		const msg = JSON.parse(frame) as { command?: string; arguments?: { subcommand?: string; mode?: string; path?: string } };
		return msg.command === 'rrext_store' && msg.arguments?.subcommand === 'fs_open' && (msg.arguments.mode ?? '').includes('w') && msg.arguments.path === storePath;
	} catch {
		return false;
	}
}

export class Driver {
	private shots = 0;
	/** How many result cards the page had when the prompt was sent. */
	private resultsBefore = 0;
	/** How many error banners (role alert) the page had when the prompt was sent. */
	private alertsBefore = 0;
	/** The prompt the runner sent, which marks the chat's tab among the editor tabs. */
	private sent = '';
	private consoleLines: string[] = [];
	private readonly trace: string;
	private readonly t0 = Date.now();
	/** The held write, once one was held (opts.holdWrite). */
	heldWrite: HeldWrite | null = null;

	private constructor(
		private readonly opts: DriverOptions,
		private readonly browser: Browser,
		private readonly context: BrowserContext,
		readonly page: Page
	) {
		this.trace = path.join(opts.dir, 'trace.jsonl');
	}

	/** Launches Chromium with the sign-in token seeded, and starts recording. */
	static async open(opts: DriverOptions): Promise<Driver> {
		fs.mkdirSync(opts.dir, { recursive: true });
		const browser = await chromium.launch({ headless: !opts.headed });
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		// step: the token the API key screen would store, before the first page loads
		await context.addInitScript(([key, token]) => (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(key, token), [LS_TOKEN, opts.apiKey]);
		const page = await context.newPage();
		const driver = new Driver(opts, browser, context, page);
		driver.record();
		if (opts.holdWrite) await driver.routeHold(opts.holdWrite);
		return driver;
	}

	/** Routes the engine's WebSocket so the first write of one file waits for `during` (DriverOptions.holdWrite). */
	private async routeHold(hold: NonNullable<DriverOptions['holdWrite']>): Promise<void> {
		await this.page.routeWebSocket(
			(url) => url.pathname === '/task/service',
			(ws) => {
				const server = ws.connectToServer();
				ws.onMessage((frame) => {
					if (this.heldWrite || typeof frame !== 'string' || !isWriteOpen(frame, hold.storePath)) return server.send(frame);
					const t0 = Date.now();
					this.heldWrite = { held: true, ms: 0, detail: 'holding' };
					this.log('hold the write', hold.storePath);
					void hold
						.during()
						.then((detail) => (this.heldWrite = { held: true, ms: Date.now() - t0, detail }))
						.catch((err: unknown) => (this.heldWrite = { held: true, ms: Date.now() - t0, detail: `failed: ${err instanceof Error ? err.message : String(err)}` }))
						.finally(() => {
							server.send(frame);
							this.log('release the write', this.heldWrite?.detail ?? '');
						});
				});
				server.onMessage((frame) => ws.send(frame));
			}
		);
	}

	async close(): Promise<void> {
		fs.writeFileSync(path.join(this.opts.dir, 'console.log'), this.opts.scrubber.scrub(this.consoleLines.join('\n')) + '\n');
		await this.context.close().catch(() => {});
		await this.browser.close().catch(() => {});
	}

	/** A line in steps.log. */
	log(action: string, result: string): void {
		fs.appendFileSync(path.join(this.opts.dir, 'steps.log'), `${new Date().toISOString()}  ${action}  ->  ${this.opts.scrubber.scrub(result)}\n`);
	}

	/**
	 * A screenshot and the page's accessibility tree, numbered in order.
	 *
	 * @param timeoutMs - The longest each capture may take; a capture that runs out is skipped.
	 */
	async shot(label: string, timeoutMs = 30_000): Promise<void> {
		const base = `${String(++this.shots).padStart(2, '0')}-${label}`;
		const until = Date.now() + timeoutMs;
		try {
			await this.page.screenshot({ path: path.join(this.opts.dir, `${base}.png`), timeout: timeoutMs });
			fs.writeFileSync(path.join(this.opts.dir, `${base}.aria.txt`), this.opts.scrubber.scrub(await this.page.locator('body').ariaSnapshot({ timeout: Math.max(1, until - Date.now()) })));
		} catch {
			/* the page may be gone; the shot is evidence, not a step */
		}
	}

	/** The page's visible text, raw: for the leak scans only, never for a file. */
	async pageText(): Promise<string> {
		return await this.page
			.locator('body')
			.innerText()
			.catch(() => '');
	}

	/** The page's visible text, for transcript.txt. */
	async transcript(): Promise<string> {
		return this.opts.scrubber.scrub(
			await this.page
				.locator('body')
				.innerText()
				.catch(() => '')
		);
	}

	// =========================================================================
	// recording
	// =========================================================================

	private write(entry: Record<string, unknown>): void {
		fs.appendFileSync(this.trace, `${this.opts.scrubber.scrub(JSON.stringify({ t: new Date().toISOString(), ...entry }))}\n`);
	}

	private record(): void {
		const page = this.page;
		const consoleLine = (line: string) => {
			this.opts.observe?.('console', line);
			this.consoleLines.push(line);
		};
		page.on('console', (m) => consoleLine(`[${m.type()}] ${m.text()}`));
		page.on('pageerror', (e) => consoleLine(`[pageerror] ${e.stack ?? e.message}`));
		page.on('websocket', (ws) => {
			const url = ws.url();
			this.write({ kind: 'ws-open', url });
			const frame =
				(dir: 'ws-sent' | 'ws-received') =>
				({ payload }: { payload: string | Buffer }) => {
					const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
					this.opts.observe?.(dir, text);
					this.write({ kind: dir, url, bytes: text.length, text: text.length > FRAME_MAX ? `${text.slice(0, FRAME_MAX)}[cut: ${text.length} chars]` : text });
				};
			ws.on('framesent', frame('ws-sent'));
			ws.on('framereceived', frame('ws-received'));
			ws.on('close', () => this.write({ kind: 'ws-close', url }));
		});
		page.on('requestfinished', async (req) => {
			if (req.url().startsWith('data:')) return;
			const res = await req.response().catch(() => null);
			const timing = req.timing();
			this.write({ kind: 'http', method: req.method(), url: req.url(), status: res?.status() ?? null, ms: timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : null });
		});
		page.on('requestfailed', (req) => {
			if (req.url().startsWith('data:')) return;
			this.write({ kind: 'http', method: req.method(), url: req.url(), status: null, failure: req.failure()?.errorText ?? 'failed' });
		});
	}

	// =========================================================================
	// the user's path
	// =========================================================================

	private composer(): Locator {
		return this.page.getByRole('textbox', { name: 'Reply to the agent...' }).filter({ visible: true }).first();
	}

	private button(name: string): Locator {
		return this.page.getByRole('button', { name, exact: true }).filter({ visible: true }).first();
	}

	/** Opens Rocket Builder from this checkout's dev remote and waits for the Agent tab. */
	async openApp(): Promise<void> {
		await this.page.goto(this.opts.shellUrl, { waitUntil: 'domcontentloaded' });
		// step: the seeded token signs in; the API key screen is the fallback
		const signIn = this.page.getByRole('button', { name: 'Sign In' });
		if (await signIn.isVisible().catch(() => false)) {
			await signIn.click();
			await this.submitApiKey('home');
		}
		await this.page.goto(`${this.opts.shellUrl}/?appid=${APP_ID}${this.opts.devRemote ? '&rrdev=1' : ''}`, { waitUntil: 'domcontentloaded' });
		await this.page.locator('input[aria-label="API key"], [role="tab"][aria-label="Agent"]').first().waitFor({ timeout: LOAD_MS });
		if (
			await this.page
				.getByPlaceholder('API key')
				.isVisible()
				.catch(() => false)
		)
			await this.submitApiKey('app');
		await this.page.getByRole('tab', { name: 'Agent', exact: true }).waitFor({ timeout: LOAD_MS });
		await this.shot('app-loaded');
		this.log('open Rocket Builder', 'the rail shows the Agent tab');
	}

	private async submitApiKey(where: string): Promise<void> {
		const key = this.page.getByPlaceholder('API key');
		await key.fill(this.opts.apiKey);
		await key.press('Enter');
		await key.waitFor({ state: 'detached', timeout: 60_000 });
		this.log(`sign in on the API key screen (${where})`, 'the seeded token was not enough');
	}

	/**
	 * Opens an app's Design preview the way a user does: the Apps rail view,
	 * the app under My Apps, then the App Builder's Design tab, and waits for
	 * the preview's watch to report ok. The App Builder stays open as a tab.
	 *
	 * @param appName - The app's name as My Apps lists it (its appManifest.name).
	 * @param limitMs - The longest the whole step may take.
	 */
	async openDesignPreview(appName: string, limitMs = LOAD_MS): Promise<void> {
		// step: every wait fits in limitMs, so a preview opened during a turn cannot outlast its time limit
		const until = Date.now() + limitMs;
		const left = (ms: number) => Math.max(1, Math.min(ms, until - Date.now()));
		const apps = this.page.getByRole('tab', { name: 'Apps', exact: true });
		for (let i = 0; i < 8 && Date.now() < until && (await apps.getAttribute('aria-selected', { timeout: left(30_000) })) !== 'true'; i++) {
			await apps.click({ timeout: left(30_000) });
			await this.page.waitForTimeout(Math.min(1000, left(1000)));
		}
		await this.page
			.getByRole('tabpanel')
			.getByRole('button', { name: appName, exact: true })
			.click({ timeout: left(30_000) });
		await this.page.getByRole('tab', { name: 'Design', exact: true }).click({ timeout: left(60_000) });
		await this.page
			.getByText(/^watch: ok/)
			.first()
			.waitFor({ timeout: left(LOAD_MS) });
		await this.shot('design-preview', left(30_000));
		this.log(`open the ${appName} Design preview`, 'the preview watch reports ok');
	}

	/** Selects the Agent rail view, where the chat, its cards and its Stop button are. */
	async showAgent(): Promise<void> {
		const tab = this.page.getByRole('tab', { name: 'Agent', exact: true });
		// step: the first click after load can be swallowed while the app restores its view
		for (let i = 0; i < 8 && (await tab.getAttribute('aria-selected')) !== 'true'; i++) {
			await tab.click();
			await this.page.waitForTimeout(1000);
		}
		if ((await tab.getAttribute('aria-selected')) !== 'true') throw new Error('the Agent rail tab never became selected');
	}

	/** The Agent view, then New session, then waits for the composer. */
	async newSession(): Promise<void> {
		await this.showAgent();
		await this.button('New session').click();
		await this.composer().waitFor({ timeout: 60_000 });
		await this.shot('new-session');
		this.log('start a new agent session', 'the composer is ready');
	}

	/**
	 * Makes sure the agent asks before risky actions (the "Ask first" mode),
	 * which the tasks' card policies assume. The mode is the app's setting,
	 * so a fresh browser starts there; switch back if it does not.
	 *
	 * @returns The mode's label as the page shows it.
	 */
	async askFirst(): Promise<string> {
		const ask = this.button('Ask first');
		if (!(await ask.isVisible().catch(() => false))) {
			const auto = this.page
				.getByRole('button', { name: /^Don't ask/ })
				.filter({ visible: true })
				.first();
			await auto.click({ timeout: 10_000 });
			await ask.waitFor({ timeout: 10_000 });
			this.log('approval mode', `was "Don't ask"; switched to "Ask first"`);
		}
		return 'Ask first';
	}

	/**
	 * Picks the model through the picker and confirms the button shows it.
	 *
	 * @returns The key state the picker showed for the provider: 'set', or 'missing' (an environment failure).
	 */
	async pickModel(pick: ModelPick): Promise<{ key: 'set' | 'missing'; shown: string }> {
		const titles = modelTitles(pick);
		const pickerButton = this.page.locator('button[title="The model this chat uses"], button[title^="Requires your "]').filter({ visible: true }).first();
		await pickerButton.click();
		const popup = this.page.locator('#rr-popup-portal');
		await popup.getByRole('button', { name: titles.provider, exact: true }).click({ timeout: 30_000 });
		// step: the status line says whether the key is set, once the offers are read
		const status = popup.getByText(new RegExp(`^(Uses|Requires) your ${titles.provider} key`));
		await status.first().waitFor({ timeout: 30_000 });
		const key = (await status.first().innerText()).startsWith('Uses') ? 'set' : 'missing';
		await popup.getByText(titles.model, { exact: true }).first().click();
		await this.page.waitForTimeout(500);
		const shown = (await pickerButton.innerText()).trim();
		await this.shot('model-picked');
		if (shown !== titles.model) throw new Error(`picked ${titles.model}, but the picker shows "${shown}"`);
		this.log(`pick ${pick.provider}/${pick.model}`, `the picker shows "${shown}", ${key === 'set' ? `uses the ${titles.provider} key` : `REQUIRES the ${titles.provider} key`}`);
		return { key, shown };
	}

	private results(): Locator {
		return this.page.locator('[role="group"][aria-label^="Turn result: "]');
	}

	/** The error banners. A turn that fails before it starts, such as a refused pasted key, ends on one of these and gets no result card (agent.ts withCards skips error rows). */
	private alerts(): Locator {
		return this.page.getByRole('alert').filter({ visible: true });
	}

	/**
	 * Brings the chat back to the front of the editor area. The chat, with its
	 * cards and its Stop button, is an editor tab; opening an app puts the App
	 * Builder's tab in front of it, and the Agent rail tab shows only the
	 * session list. The tabs have no role or name (shell DocTabs), so each is
	 * tried until the one showing the sent prompt and the composer.
	 */
	async showChat(): Promise<void> {
		// the user's message is a paragraph in the chat; the session list's entry for it is a button, so it does not count
		const prompt = this.page.getByRole('paragraph').filter({ hasText: this.sent.slice(0, 60), visible: true });
		const inFront = async () =>
			(await prompt.count()) > 0 &&
			(await this.composer()
				.isVisible()
				.catch(() => false));
		if (await inFront()) return;
		const tabs = this.page.locator('div[draggable="true"]').filter({ has: this.page.getByRole('button', { name: '×', exact: true }) });
		for (let i = 0, n = await tabs.count(); i < n; i++) {
			await tabs
				.nth(i)
				.locator('span')
				.filter({ hasText: /\S/ })
				.first()
				.click({ timeout: 5_000 })
				.catch(() => {});
			await this.page.waitForTimeout(300);
			if (await inFront()) {
				this.log('back to the chat', `editor tab ${i + 1} of ${n}`);
				return;
			}
		}
		throw new Error('could not bring the chat back to the front: no editor tab shows the sent prompt');
	}

	/**
	 * Loads an app in its Design preview from the files as they are now and
	 * reads what the preview shows (task 3.2's load check): its App Builder tab
	 * (opened if it is not), Console cleared, Refresh the preview, a wait for
	 * the watch and the mount, then the preview's Console rows and its page.
	 * The app fails on an error row, an uncaught exception, its error screen
	 * ("... encountered an error") or an empty page. Warnings do not count.
	 *
	 * @param appName - The app's name as My Apps and its App Builder tab show it.
	 * @returns ok null when the preview or its Console could not be read.
	 */
	async appLoad(appName: string): Promise<AppLoad> {
		await this.appInFront(appName);
		const view = (name: string) => this.page.getByRole('button', { name, exact: true }).filter({ visible: true }).first();
		await view('Console').click();
		const clear = view('Clear');
		if (await clear.isVisible().catch(() => false)) await clear.click();
		await view('Preview').click();
		// step: mark the preview's page, so the one Refresh mounts is told from it (the watch shows the old status until the new page attaches)
		const previewBody = () => this.page.locator('iframe[src^="blob:"]').filter({ visible: true }).first().contentFrame().locator('body');
		const unread = (why: string): AppLoad => {
			const detail = `not read: ${why}`;
			this.log(`load ${appName} in its Design preview`, detail);
			return { ok: null, detail, errors: [], crashed: false };
		};
		const marked = await previewBody()
			.evaluate(
				(b: PageNode) => {
					b.ownerDocument.defaultView.__evalLoadMark = true;
					return true;
				},
				undefined,
				{ timeout: 10_000 }
			)
			.catch(() => false);
		if (!marked) return unread('no preview page to mark before Refresh');
		await view('Refresh the preview').click();
		let remounted = false;
		for (const until = Date.now() + 30_000; !remounted && Date.now() < until; ) {
			remounted = await previewBody()
				.evaluate((b: PageNode) => !b.ownerDocument.defaultView.__evalLoadMark, undefined, { timeout: 2_000 })
				.catch(() => false);
			if (!remounted) await this.page.waitForTimeout(250);
		}
		if (!remounted) return unread('Refresh did not mount a new preview page in 30 s');
		// step: the watch settles on ok or error (types.ts WatchStatus: idle, installing, building, ok, error); hidden App Builder tabs keep their own watch, so only the visible one counts
		const watch = this.page
			.getByText(/^watch: /)
			.filter({ visible: true })
			.first();
		const settled = await this.page
			.getByText(/^watch: (ok|error)/)
			.filter({ visible: true })
			.first()
			.waitFor({ timeout: 60_000 })
			.then(() => true)
			.catch(() => false);
		const watchText = (await watch.innerText().catch(() => '')).trim();
		if (!settled) return unread(`the preview watch did not settle in 60 s (${watchText || 'no watch shown'})`);
		if (watchText.startsWith('watch: error')) {
			await this.shot('app-load');
			const detail = `the preview build failed (${this.opts.scrubber.scrub(watchText).slice(0, 200)})`;
			this.log(`load ${appName} in its Design preview`, detail);
			return { ok: false, detail, errors: [], crashed: false };
		}
		// step: the mount, and any error it throws, come a moment after the build
		await this.page.waitForTimeout(4000);
		const body = await previewBody()
			.innerText({ timeout: 10_000 })
			.catch(() => null);
		await this.shot('app-load');
		await view('Console').click();
		await this.page.waitForTimeout(500);
		// rows: div > span(time), span(level, or the source of an uncaught exception), span(message), under the list next to the "Filter…" box (LogList.tsx)
		const rows = (await this.page.evaluate(CONSOLE_ROWS)) as string[][] | null;
		await view('Preview').click();
		const scrub = (t: string) => this.opts.scrubber.scrub(t).slice(0, 300);
		const errors = (rows ?? []).filter(([, level = '', message = '']) => level === 'error' || message.startsWith('Uncaught')).map(([time = '', level = '', message = '']) => scrub(`${time} ${level} ${message}`));
		const crashed = body !== null && /encountered an error/.test(body);
		const empty = body !== null && body.trim() === '';
		const read = rows !== null && body !== null;
		const ok = read ? errors.length === 0 && !crashed && !empty : null;
		const detail = !read ? `not read: ${rows === null ? 'no Console rows' : 'no preview page'}` : ok ? `loads: ${rows.length} Console rows, no errors` : [crashed ? 'the app shows its error screen' : '', empty ? 'the preview page is empty' : '', errors.length ? `${errors.length} error row(s): ${errors[0]}` : ''].filter(Boolean).join('; ');
		this.log(`load ${appName} in its Design preview`, detail);
		return { ok, detail, errors, crashed };
	}

	/**
	 * Uses an app the way its user would, in the preview appLoad left in
	 * front: types into its first visible text box, presses the first
	 * visible button whose name contains `click`, then waits for `answer` on
	 * its page (checks/appRun.ts reads what the engine ran).
	 *
	 * @param appName - The app's name, for the log.
	 * @param use - What to type and press.
	 * @param answer - What the page must show, or null for any change.
	 * @param limitMs - How long to wait for it.
	 */
	async useApp(appName: string, use: { fill: string; click: string }, answer: RegExp | null, limitMs: number): Promise<AppUsed> {
		// step: this app's tab, since the load loop leaves the last app it loaded in front
		await this.appInFront(appName);
		const frame = this.page.locator('iframe[src^="blob:"]').filter({ visible: true }).first().contentFrame();
		const pageText = (fallback: string) =>
			frame
				.locator('body')
				.innerText({ timeout: 5_000 })
				.catch(() => fallback);
		const excerpt = (text: string) => this.opts.scrubber.scrub(text.trim().slice(-400));
		const done = (used: AppUsed): AppUsed => {
			this.log(`use ${appName}`, used.detail);
			return used;
		};
		await this.page
			.getByRole('button', { name: 'Preview', exact: true })
			.filter({ visible: true })
			.first()
			.click({ timeout: 10_000 })
			.catch(() => {});
		const before = await pageText('');
		const box = frame.getByRole('textbox').filter({ visible: true }).first();
		const typed = await box
			.fill(use.fill, { timeout: 10_000 })
			.then(() => true)
			.catch(() => false);
		if (!typed) return done({ done: false, answered: null, detail: "no text box on the app's page", excerpt: excerpt(before) });
		const button = frame
			.getByRole('button', { name: new RegExp(escapeRe(use.click), 'i') })
			.filter({ visible: true })
			.first();
		const pressed = await button
			.click({ timeout: 10_000 })
			.then(() => true)
			.catch(() => false);
		if (!pressed) return done({ done: false, answered: null, detail: `no button named ${JSON.stringify(use.click)} on the app's page`, excerpt: excerpt(before) });
		const t0 = Date.now();
		let text = before;
		let seen = false;
		for (const until = t0 + limitMs; !seen && Date.now() < until; ) {
			await this.page.waitForTimeout(1000);
			text = await pageText(text);
			seen = answer ? answer.test(text) : text !== before;
		}
		await this.shot('app-use');
		const secs = Math.round((Date.now() - t0) / 1000);
		const detail = seen ? `typed and pressed ${use.click}; the page ${answer ? 'showed the answer' : 'changed'} after ${secs} s` : `typed and pressed ${use.click}; the page ${answer ? 'did not show the answer' : 'did not change'} in ${secs} s`;
		return done({ done: true, answered: answer ? seen : null, detail, excerpt: excerpt(text) });
	}

	/** Brings an app's App Builder tab to the front (opening its Design preview if it has no tab), on its Design view. */
	private async appInFront(appName: string): Promise<void> {
		const tab = this.page.locator('div[draggable="true"]').filter({ has: this.page.locator('span', { hasText: new RegExp(`^${escapeRe(appName)}$`) }) });
		if (await tab.count()) await tab.first().locator('span').filter({ hasText: /\S/ }).first().click({ timeout: 10_000 });
		else await this.openDesignPreview(appName);
		await this.page.getByRole('tab', { name: 'Design', exact: true }).click({ timeout: 30_000 });
	}

	// =========================================================================
	// what the user does in the editor (a task's user_events)
	// =========================================================================

	/** The path line over an open file's editor. Its parent also holds "●" while the buffer is unsaved, and the Save button. */
	private fileHeader(file: string): Locator {
		return this.page
			.locator('span')
			.filter({ hasText: new RegExp(`^${escapeRe(file)}$`), visible: true })
			.first()
			.locator('xpath=..');
	}

	/** Waits until the open file's editor shows it unsaved (or saved), up to timeoutMs; returns whether it got there. */
	private async untilUnsaved(file: string, unsaved: boolean, timeoutMs: number): Promise<boolean> {
		for (const until = Date.now() + timeoutMs; ; ) {
			if (
				(
					await this.fileHeader(file)
						.innerText()
						.catch(() => '')
				).includes('●') === unsaved
			)
				return true;
			if (Date.now() > until) return false;
			await this.page.waitForTimeout(250);
		}
	}

	/**
	 * Opens a workspace file in the editor the way a user does: the Explorer
	 * rail view, then each folder and the file in its tree.
	 *
	 * @param file - A workspace path, such as apps/daybook-ui/src/App.tsx.
	 */
	async openFile(file: string): Promise<void> {
		const tab = this.page.getByRole('tab', { name: 'Explorer', exact: true });
		for (let i = 0; i < 8 && (await tab.getAttribute('aria-selected')) !== 'true'; i++) {
			await tab.click();
			await this.page.waitForTimeout(1000);
		}
		const tree = this.page.getByRole('tabpanel');
		for (const part of file.split('/')) {
			await tree.getByText(part, { exact: true }).first().click({ timeout: 30_000 });
			await this.page.waitForTimeout(500);
		}
		await this.fileHeader(file).waitFor({ timeout: 30_000 });
		this.log(`open ${file}`, 'the editor shows it');
	}

	/**
	 * Changes the open file's text without saving it, through the editor's own
	 * Find and Replace (typing would trip Monaco's auto-closing quotes and
	 * brackets). Each find text must occur in the file.
	 *
	 * @param file - The open file, whose editor is in front.
	 * @param replace - Each find text and its replacement.
	 */
	async replaceUnsaved(file: string, replace: Record<string, string>): Promise<void> {
		const widget = this.page.locator('.find-widget').filter({ visible: true }).first();
		const count = async () =>
			(
				await widget
					.locator('.matchesCount')
					.innerText()
					.catch(() => '')
			).trim();
		for (const [find, by] of Object.entries(replace)) {
			// Monaco's text area is invisible by design, so find the visible editor first
			await this.page.locator('.monaco-editor').filter({ visible: true }).first().getByRole('textbox', { name: 'Editor content' }).focus();
			await this.page.keyboard.press('Control+h');
			await widget.getByRole('textbox', { name: 'Find' }).fill(find);
			await widget.getByRole('textbox', { name: 'Replace' }).fill(by);
			await this.page.waitForTimeout(300);
			const found = await count();
			if (!found || /^No results/.test(found)) throw new Error(`${file} has no "${find}" to replace (find says: ${found || 'nothing'})`);
			await widget.getByRole('button', { name: /^Replace All/ }).click();
			await this.page.waitForTimeout(300);
			await this.page.keyboard.press('Escape');
		}
		if (!(await this.untilUnsaved(file, true, 10_000))) throw new Error(`${file} does not show unsaved changes after the edit`);
		await this.shot('unsaved-edit');
		this.log(`edit ${file} without saving`, `${Object.keys(replace).length} replacement(s); the editor shows unsaved changes`);
	}

	/**
	 * Saves an open file the way a user does when it still has unsaved
	 * changes: its editor tab, then Save.
	 *
	 * @param file - A workspace path.
	 * @returns Whether it was unsaved (and is now saved).
	 */
	async saveIfUnsaved(file: string): Promise<boolean> {
		const name = file.split('/').pop() ?? file;
		const tabs = this.page.locator('div[draggable="true"]').filter({ has: this.page.locator('span', { hasText: new RegExp(`^${escapeRe(name)}$`) }) });
		if (!(await tabs.count())) {
			this.log(`save ${file} if unsaved`, 'no editor tab for it');
			return false;
		}
		await tabs.first().locator('span').filter({ hasText: /\S/ }).first().click({ timeout: 10_000 });
		await this.fileHeader(file).waitFor({ timeout: 10_000 });
		if (!(await this.untilUnsaved(file, true, 0))) {
			this.log(`save ${file} if unsaved`, 'already saved');
			return false;
		}
		await this.fileHeader(file).getByRole('button', { name: 'Save', exact: true }).click();
		if (!(await this.untilUnsaved(file, false, 15_000))) throw new Error(`${file} still shows unsaved changes after Save`);
		await this.shot('saved');
		this.log(`save ${file} if unsaved`, 'it was unsaved; pressed Save');
		return true;
	}

	/** Types the prompt and presses Send. */
	async send(text: string): Promise<void> {
		this.sent = text;
		await this.composer().fill(text);
		// step: count the result cards before the turn starts, so even a very fast turn's card is new
		this.resultsBefore = await this.results().count();
		this.alertsBefore = await this.alerts().count();
		await this.button('Send').click();
		this.log(`send "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`, 'sent');
		await this.shot('prompt-sent');
	}

	/**
	 * Waits for the turn to end, answering cards by the policy, and presses
	 * Stop at the time limit. Never types into the composer.
	 *
	 * @param policy - How to answer cards.
	 * @param timeLimitMs - When to press Stop.
	 * @param during - Runs between polls until the time limit, as a user watching would act (trial.ts opens a new app's Design preview), given the time limit as an absolute deadline (Date.now() ms); true when it did something, so the turn's state is read again. It leaves the chat in front (showChat).
	 */
	async runTurn(policy: CardPolicy, timeLimitMs: number, during?: (deadline: number) => Promise<boolean>): Promise<TurnRun> {
		const t0 = Date.now();
		const stop = this.button('Stop');
		const results = this.results();
		const before = this.resultsBefore;
		const cards: AnsweredCard[] = [];
		let stoppedAtLimit = false;
		let refused: string | null = null;
		const newAlert = async () => (await this.alerts().count()) > this.alertsBefore;
		// step: wait for the turn to start, or for it to end at once (a fast turn's card, or an error banner)
		for (const until = Date.now() + 30_000; Date.now() < until; ) {
			if ((await stop.isVisible().catch(() => false)) || (await results.count()) > before || (await newAlert())) break;
			await this.page.waitForTimeout(250);
		}
		for (;;) {
			let running = await stop.isVisible().catch(() => false);
			// step: past the time limit, press Stop once and answer no card, so no action is approved after it
			const late = Date.now() - t0 > timeLimitMs;
			if (running && !stoppedAtLimit && late) {
				await this.shot('time-limit');
				await stop.click().catch(() => {});
				stoppedAtLimit = true;
				this.log('time limit', `pressed Stop after ${Math.round((Date.now() - t0) / 1000)}s`);
				await stop.waitFor({ state: 'hidden', timeout: STOP_GRACE_MS }).catch(() => {});
				continue;
			}
			if (!late && (await this.answerAsk(policy, cards, t0))) continue;
			if (!late && (await this.answerUnsavedChanges(policy, cards, t0))) continue;
			if (!late && during && (await during(t0 + timeLimitMs))) continue;
			running = await stop.isVisible().catch(() => false);
			if (!running && (await results.count()) > before) break;
			if (!running && (await newAlert())) {
				// step: an error row ends the turn with a banner and no card; give a card a moment in case both come
				await results
					.nth(before)
					.waitFor({ timeout: 2_000 })
					.catch(() => {});
				if ((await results.count()) === before)
					refused = this.opts.scrubber.scrub(
						(
							await this.alerts()
								.last()
								.innerText()
								.catch(() => '')
						).trim()
					);
				break;
			}
			if (!running && Date.now() - t0 > 30_000 && (await results.count()) === before) {
				// step: the turn is over with no card yet; give the row a moment, then grade it as it stands
				await results
					.nth(before)
					.waitFor({ timeout: 30_000 })
					.catch(() => {});
				break;
			}
			if (stoppedAtLimit && Date.now() - t0 > timeLimitMs + STOP_GRACE_MS + 30_000) break;
			await this.page.waitForTimeout(500);
		}
		const ms = Date.now() - t0;
		const last = (await results.count()) > before ? results.last() : null;
		const card = last ? { title: ((await last.getAttribute('aria-label')) ?? '').replace(/^Turn result: /, ''), text: this.opts.scrubber.scrub(await last.innerText()) } : null;
		await this.shot('turn-ended');
		this.log('wait for the turn', `${card ? `card "${card.title}"` : refused !== null ? `an error banner, no result card: "${refused.slice(0, 120)}"` : 'no result card'} after ${Math.round(ms / 1000)}s${stoppedAtLimit ? ', stopped at the time limit' : ''}`);
		return { ended: card !== null || refused !== null, stoppedAtLimit, ms, cards, card, ...(refused !== null ? { banner: refused } : {}) };
	}

	/** Answers a visible "Needs your OK" card by the policy. */
	private async answerAsk(policy: CardPolicy, cards: AnsweredCard[], t0: number): Promise<boolean> {
		const card = this.page.getByRole('group', { name: 'Needs your OK' }).filter({ visible: true }).first();
		if (!(await card.isVisible().catch(() => false))) return false;
		const lines = (await card.innerText().catch(() => ''))
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		// lines: "Needs your OK", the title, the detail when there is one, then the buttons
		const buttons = new Set(['Approve', 'Deny']);
		const title = lines[1] ?? '';
		const detail = lines
			.slice(2)
			.filter((l) => !buttons.has(l))
			.join(' ');
		const answer = cardAnswer(policy);
		await this.shot(`card-${cards.length + 1}`);
		await card.getByRole('button', { name: answer === 'approve' ? 'Approve' : 'Deny', exact: true }).click();
		cards.push({ kind: 'ask', title: this.opts.scrubber.scrub(title), detail: this.opts.scrubber.scrub(detail), answer, atMs: Date.now() - t0 });
		this.log('answer a "Needs your OK" card', `${answer}: "${title}"`);
		await card.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
		return true;
	}

	/** Answers the unsaved-changes dialog by the policy's dirty_file_prompt, or Cancel when it names none. */
	private async answerUnsavedChanges(policy: CardPolicy, cards: AnsweredCard[], t0: number): Promise<boolean> {
		const dialog = this.page
			.getByRole('dialog')
			.filter({ hasText: /unsaved changes/i })
			.first();
		if (!(await dialog.isVisible().catch(() => false))) return false;
		const buttons = await dialog.getByRole('button').allInnerTexts();
		const wanted = dirtyFileAnswer(policy);
		const pattern = wanted === 'save_mine_first' ? /save/i : wanted === 'discard_mine' ? /discard/i : wanted === 'keep_mine' ? /keep/i : /cancel/i;
		const choice = buttons.find((b) => pattern.test(b)) ?? buttons.at(-1) ?? '';
		await this.shot(`unsaved-changes-${cards.length + 1}`);
		await dialog.getByRole('button', { name: choice, exact: true }).click();
		cards.push({ kind: 'unsaved_changes', title: this.opts.scrubber.scrub((await dialog.innerText().catch(() => '')).slice(0, 200)), detail: buttons.join(' | '), answer: choice, atMs: Date.now() - t0 });
		this.log('answer the unsaved-changes dialog', `${choice} (buttons: ${buttons.join(' | ')})`);
		await dialog.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
		return true;
	}
}
