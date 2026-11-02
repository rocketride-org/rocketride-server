/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * The page the browser lands on after `rocketride login` (#2850): branded
 * like the RocketRide landing page, themed with the web app's palettes,
 * tries to close itself on success (no redirect), and explains a failure.
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { authorizeViaLoopback, CALLBACK_PALETTES, renderCallbackPage, webAppUrlFor } from '../src/cli/commands/auth';
import { Output } from '../src/cli/output';

afterEach(() => {
	jest.restoreAllMocks();
});

/** The inline script's body ('' when the page has none). */
const scriptOf = (page: string): string => /<script>([\s\S]*)<\/script>/.exec(page)?.[1] ?? '';

/** A shell theme's tokens (packages/shell/public/themes/<id>.json). */
const theme = (id: string): Record<string, string> => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'shell', 'public', 'themes', `${id}.json`), 'utf8'));

describe('renderCallbackPage', () => {
	it('success: branded, themed, tries to close, links the web app, never redirects', () => {
		const page = renderCallbackPage({ ok: true, webUrl: 'https://api.rocketride.ai/' });

		expect(page).toContain("<h1>You're signed in</h1>");
		expect(page).toContain('<span>RocketRide</span>');
		expect(page).toContain('fill="#F93822"');
		expect(page).toContain('@media (prefers-color-scheme:dark)');
		expect(scriptOf(page)).toBe('window.close();');
		expect(page).not.toMatch(/location\.(replace|assign|href)/);
		expect(page).toContain('<a class="btn" href="https://api.rocketride.ai/">Open RocketRide</a>');
	});

	it('success without a usable web URL drops the button, never a non-http link', () => {
		for (const webUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', undefined]) {
			const page = renderCallbackPage({ ok: true, webUrl });

			expect(page).not.toContain('class="btn"');
			expect(page).not.toContain('javascript:');
			expect(scriptOf(page)).toBe('window.close();');
		}
	});

	it('keeps a hostile URL out of the markup', () => {
		const page = renderCallbackPage({ ok: true, webUrl: 'https://evil.test/"><script>alert(1)</script>' });

		expect(page.match(/<script>/g)).toHaveLength(1);
		expect(page).not.toContain('<script>alert(1)');
	});

	it('failure: escaped reason, branded, no close attempt', () => {
		const page = renderCallbackPage({ ok: false, error: 'access_denied <b>by user</b>' });

		expect(page).toContain('<h1>Sign-in failed</h1>');
		expect(page).toContain('access_denied &lt;b&gt;by user&lt;/b&gt;');
		expect(page).toContain('<span>RocketRide</span>');
		expect(page).not.toContain('<script>');
	});

	it('waitlisted: the access-queue notice, the web app link, no close attempt', () => {
		const page = renderCallbackPage({ ok: true, webUrl: 'https://rocketride.ai/', waitlisted: true });

		expect(page).toContain("<h1>You're on the list</h1>");
		expect(page).not.toContain("You're signed in");
		expect(page).toContain('<a class="btn" href="https://rocketride.ai/">Open RocketRide</a>');
		expect(page).not.toContain('<script>');
	});
});

describe('authorizeViaLoopback', () => {
	/** Starts a loopback sign-in whose "browser" follows the redirect with the given query. */
	const follow = async (query: string) => {
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		let page: Promise<string> = Promise.resolve('');
		const grant = authorizeViaLoopback('https://idp.test', 'client', 'challenge', new Output(undefined), (authorizeUrl) => {
			const redirectUri = new URL(authorizeUrl).searchParams.get('redirect_uri') as string;
			page = fetch(`${redirectUri}?${query}`).then((res) => res.text());
		});
		return { grant, page: () => page };
	};

	it('holds the browser on the code until the outcome is known, then shows it', async () => {
		const { grant, page } = await follow('code=abc');
		const { code, finish } = await grant;
		let settled = false;
		void page().then(() => (settled = true));
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(code).toBe('abc');
		expect(settled).toBe(false);

		finish({ ok: false, error: 'Token exchange rejected by test server' });
		const html = await page();

		expect(html).toContain('<h1>Sign-in failed</h1>');
		expect(html).toContain('Token exchange rejected by test server');
		expect(html).not.toContain("You're signed in");
		expect(html).not.toContain('window.close()');
	});

	it('shows success only once the caller reports it', async () => {
		const { grant, page } = await follow('code=abc');
		(await grant).finish({ ok: true, webUrl: 'https://rocketride.ai/' });

		const html = await page();
		expect(html).toContain("<h1>You're signed in</h1>");
		expect(html).toContain('window.close()');
	});

	it('answers a provider error at once and rejects', async () => {
		const { grant, page } = await follow('error=access_denied&error_description=nope');

		await expect(grant).rejects.toThrow(/Sign-in was rejected: nope/);
		expect(await page()).toContain('<h1>Sign-in failed</h1>');
	});
});

describe('webAppUrlFor', () => {
	it('sends the RocketRide cloud API to the cloud web app at rocketride.ai', () => {
		expect(webAppUrlFor('https://api.rocketride.ai')).toBe('https://rocketride.ai/');
		expect(webAppUrlFor('https://API.rocketride.ai/')).toBe('https://rocketride.ai/');
		expect(webAppUrlFor('https://api.rocketride.ai:443')).toBe('https://rocketride.ai/');
	});

	it('keeps any other server on its own origin', () => {
		expect(webAppUrlFor('http://localhost:5565')).toBe('http://localhost:5565/');
		expect(webAppUrlFor('https://rr.example.com/')).toBe('https://rr.example.com/');
		expect(webAppUrlFor('https://api.rocketride.ai:8443')).toBe('https://api.rocketride.ai:8443/');
	});
});

describe('CALLBACK_PALETTES', () => {
	it.each([
		['dark', 'rocketride'],
		['light', 'rocketride-light'],
	] as const)('%s matches the web app theme %s', (mode, id) => {
		const tokens = theme(id);
		const palette = CALLBACK_PALETTES[mode];

		expect(palette).toEqual({
			bg: tokens['--rr-bg-default'],
			paper: tokens['--rr-bg-paper'],
			text: tokens['--rr-text-primary'],
			muted: tokens['--rr-text-secondary'],
			border: tokens['--rr-border'],
			buttonBg: tokens['--rr-bg-button'],
			buttonFg: tokens['--rr-fg-button'],
			success: tokens['--rr-color-success'],
			error: tokens['--rr-color-error'],
		});
	});
});
