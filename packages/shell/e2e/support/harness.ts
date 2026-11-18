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
// HARNESS: the `rrReport` outcome channel, the signed-in world, the fixtures
// =============================================================================
// The fixture app reports everything it managed to do through `rrReport` (a
// `context.exposeBinding`, so it exists in every frame of every origin). A spec
// fails because an exploit worked: `World.outcome` first proves the fixture
// actually ran, and throws `FixtureDidNotRun` otherwise, so a missing frame is
// never read as "the exploit was blocked".
// =============================================================================

import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { FIXTURE_ID, startServer, type IServer, type IServerOptions, type IsolationMode } from './server';

export { expect, FIXTURE_ID };

export interface IReport {
	kind: string;
	origin: string;
	framed: boolean;
	frameUrl: string;
	[key: string]: any;
}

/** The fixture never executed: the frame (or the guest) did not come up. Not an exploit result. */
export class FixtureDidNotRun extends Error {
	constructor(scenario: string, detail: string) {
		super(`the fixture app never ran scenario ${scenario}: ${detail} (this is a missing frame or guest, not a blocked exploit)`);
		this.name = 'FixtureDidNotRun';
	}
}

export interface IOpenOptions {
	/** The API key to sign in with (default: the server's own key); `null` stays signed out. */
	key?: string | null;
	scenario?: string;
	params?: Record<string, unknown>;
}

export class World {
	readonly reports: IReport[] = [];
	readonly requests: string[] = [];
	readonly console: string[] = [];
	private scenario = 'idle';
	private params: Record<string, unknown> = {};

	private constructor(
		readonly server: IServer,
		readonly context: BrowserContext,
		readonly page: Page
	) {}

	static async open(browser: Browser, server: IServer, options: IOpenOptions = {}): Promise<World> {
		const context = await browser.newContext();
		const page = await context.newPage();
		const world = new World(server, context, page);
		world.setScenario(options.scenario ?? 'idle', options.params);
		await context.exposeBinding('rrReport', (source, data: Record<string, unknown>) => {
			world.reports.push({ ...(data as object), frameUrl: source.frame.url() } as IReport);
		});
		await context.exposeBinding('rrScenario', () => ({ scenario: world.scenario, params: world.params }));
		page.on('request', (request) => world.requests.push(request.url()));
		page.on('console', (message) => world.console.push(`${message.type()}: ${message.text()}`));
		const key = options.key === undefined ? server.apiKey : options.key;
		if (key !== null) await world.signIn(key);
		return world;
	}

	/** Sets the shell's stored session token the way a sign-in leaves it (OSS: the API key). */
	async signIn(key: string): Promise<void> {
		await this.page.goto(this.server.url('/__e2e/blank'));
		await this.page.evaluate((value) => localStorage.setItem('rr:user_token', value), key);
	}

	setScenario(scenario: string, params: Record<string, unknown> = {}): void {
		this.scenario = scenario;
		this.params = {
			secret: this.server.apiKey,
			shellUrl: this.server.origin,
			evilUrl: this.server.url('/__e2e/evil'),
			openerNavUrl: this.server.url('/__e2e/opener-nav?to=' + encodeURIComponent(this.server.url('/__e2e/evil'))),
			...params,
		};
	}

	/** Opens the fixture app the way a user does: the shell's deep link to it. */
	async openApp(id: string = FIXTURE_ID): Promise<void> {
		await this.page.goto(this.server.url(`/?appId=${encodeURIComponent(id)}`));
	}

	/** Opens the shell on its home app (a platform app, in the shell realm). */
	async openHome(): Promise<void> {
		await this.page.goto(this.server.url('/'));
		await this.page.waitForFunction(() => Boolean((window as any).__e2e), undefined, { timeout: 30_000 });
	}

	/** Switches from the home app to another app, as the app switcher does. */
	async switchTo(id: string = FIXTURE_ID): Promise<void> {
		await this.page.evaluate((appId) => (window as any).__e2e.switchApp(appId), id);
	}

	find(kind: string, since = 0): IReport | undefined {
		return this.reports.slice(since).find((report) => report.kind === kind);
	}

	/** Waits for a report of `kind`. */
	async waitFor(kind: string, timeoutMs = 20_000, since = 0): Promise<IReport | undefined> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const found = this.find(kind, since);
			if (found) return found;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return undefined;
	}

	/**
	 * The fixture ran `scenario`: waits for its `started` report (else throws
	 * `FixtureDidNotRun`), then for the outcome report `kind`.
	 *
	 * @param kind The report that carries the outcome.
	 * @param options `resultOptional`: the scenario may destroy its own page (a navigation), so a missing outcome is `undefined`.
	 */
	async outcome(kind: string, options: { timeoutMs?: number; resultOptional?: boolean; since?: number } = {}): Promise<IReport | undefined> {
		const since = options.since ?? 0;
		const started = await this.waitFor('started', 30_000, since);
		if (!started)
			throw new FixtureDidNotRun(
				this.scenario,
				`no start report after 30 s; page ${this.page.url()}; console: ${this.console
					.filter((line) => /error|warn/i.test(line))
					.slice(-4)
					.join(' | ')}`
			);
		const result = await this.waitFor(kind, options.timeoutMs ?? 25_000, since);
		if (!result && !options.resultOptional) throw new FixtureDidNotRun(this.scenario, `started, but no ${kind} outcome`);
		return result;
	}

	/** The shell origin's `localStorage` as seen from a page at that origin (the main page, or any popup). */
	async shellStorage(): Promise<Record<string, string>> {
		const pages = this.context.pages().filter((p) => p.url().startsWith(this.server.origin));
		const merged: Record<string, string> = {};
		for (const page of pages) {
			try {
				Object.assign(merged, await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k) ?? '']))));
			} catch {
				/* a page that is navigating */
			}
		}
		return merged;
	}

	async close(): Promise<void> {
		await this.context.close();
	}
}

interface IFixtures {
	/** Opens a signed-in world on the worker's server (closed after the test). */
	open: (options?: IOpenOptions) => Promise<World>;
	/** Opens a world on a server of the test's own (see `another`). */
	openOn: (server: IServer, options?: IOpenOptions) => Promise<World>;
	/** Starts another server for a test that needs a different configuration (stopped after the test). */
	another: (options: IServerOptions) => Promise<IServer>;
}

interface IWorkerFixtures {
	server: IServer;
}

export const test = base.extend<IFixtures, IWorkerFixtures>({
	server: [
		// eslint-disable-next-line no-empty-pattern
		async ({}, use) => {
			const mode = (process.env.E2E_MODE ?? 'enforce') as IsolationMode;
			const server = await startServer({ mode });
			try {
				await use(server);
			} finally {
				await server.stop();
			}
		},
		{ scope: 'worker', timeout: 120_000 },
	],
	open: async ({ browser, server }, use) => {
		const worlds: World[] = [];
		await use(async (options) => {
			await server.clear();
			const world = await World.open(browser, server, options);
			worlds.push(world);
			return world;
		});
		await Promise.all(worlds.map((world) => world.close()));
	},
	openOn: async ({ browser }, use) => {
		const worlds: World[] = [];
		await use(async (server, options) => {
			await server.clear();
			const world = await World.open(browser, server, options);
			worlds.push(world);
			return world;
		});
		await Promise.all(worlds.map((world) => world.close()));
	},
	// eslint-disable-next-line no-empty-pattern
	another: async ({}, use) => {
		const servers: IServer[] = [];
		await use(async (options) => {
			const server = await startServer(options);
			servers.push(server);
			return server;
		});
		await Promise.all(servers.map((server) => server.stop()));
	},
});

/** Whether the run is the red base (the fixture in the shell realm). */
export const isOff = (): boolean => (process.env.E2E_MODE ?? 'enforce') === 'off';
