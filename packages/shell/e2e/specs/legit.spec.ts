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
// THE LEGITIMATE FLOWS (plan section 5.4: T96-T100, T102)
// =============================================================================
// What an isolated app must still be able to do: render with the shell's theme
// and its identity aliases, run, keep files, notify, open a confirmed link, and
// follow a version change. T102 is the control: with isolation off the same app
// runs in the shell realm, as before.
// =============================================================================

import { expect, FIXTURE_ID, isOff, test } from '../support/harness';

const USER_ALIAS = /^ru_[A-Za-z0-9_-]{16,}$/;
const ORG_ALIAS = /^ro_[A-Za-z0-9_-]{16,}$/;

test.describe('legit flows (L1-L5)', () => {
	test.skip(isOff(), 'the L flows describe the isolated app; the off base has no frame (T102 covers it)');

	test('T96 L1: a signed-in, non-public isolated app renders with theme and identity aliases', async ({ open, server }) => {
		// Absent from the probe: an anonymous caller does not see it, so it arrives only through the connect.
		const anonymous = await fetch(server.url(`/apps/${FIXTURE_ID}`));
		expect(anonymous.status, 'the fixture must not be public').toBe(404);

		const world = await open({ scenario: 'l1' });
		await world.openApp();
		const render = (await world.outcome('render'))!;
		expect(render.framed).toBe(true);
		expect(render.origin).toBe(server.appOrigin);
		expect(render.origin).not.toBe(server.origin);
		expect(render.isConnected).toBe(true);
		expect(render.identity?.userId, 'the user id must be the per-app alias').toMatch(USER_ALIAS);
		expect(render.identity?.userId).not.toBe('local');
		expect(render.identity?.organization?.id).toMatch(ORG_ALIAS);
		expect(render.identity?.organization?.id).not.toBe('local');
		const tokens = Object.values(render.tokens as Record<string, string>).filter((value) => value !== '');
		expect(tokens.length + (render.inlineRrTokens as number), 'the shell theme tokens must reach the frame').toBeGreaterThan(0);
		await expect(world.page.frameLocator('iframe').getByTestId('fixture-root')).toBeVisible();
	});

	test('T98 L3: a file round trip through the SDK works inside the app folder and nowhere else', async ({ open }) => {
		const world = await open({ scenario: 'l3' });
		await world.openApp();
		const { out } = (await world.outcome('l3'))!;
		expect(out.write.ok, JSON.stringify(out.write)).toBe(true);
		expect(out.read.value).toEqual({ hello: 'world', n: 7 });
		expect(out.list.value).toEqual(expect.arrayContaining(['roundtrip.json']));
		expect(out.writeString.ok).toBe(true);
		expect(out.readString.value).toBe('plain text');
		expect(out.outside.ok, 'a path outside the app folder was readable').toBe(false);
		expect(out.traversal.ok, 'a traversal path was readable').toBe(false);
		expect(out.delete.ok).toBe(true);
	});

	test('T99 L4: notify shows in the strip and openExternal asks before it opens', async ({ open }) => {
		const world = await open({ scenario: 'l4' });
		await world.context.route('https://example.com/**', (route) => route.abort());
		await world.openApp();
		const denials = (await world.outcome('l4-denials'))!;
		expect(denials.out.notify.ok, JSON.stringify(denials.out.notify)).toBe(true);
		expect(denials.out.openExternalJavascript.ok, 'a javascript: link was accepted').toBe(false);
		expect(denials.out.openExternalShellOrigin.ok, 'a link to the shell origin was accepted').toBe(false);
		await expect(world.page.getByText('hello from the fixture')).toBeVisible();
		// The allowed link waits for the user.
		await expect(world.page.getByText(/wants to open example\.com/)).toBeVisible();
		expect(world.find('l4'), 'the link opened before the user confirmed').toBeUndefined();
		await world.page.getByRole('button', { name: 'Open', exact: true }).click();
		const done = (await world.waitFor('l4', 15_000))!;
		expect(done.out.openExternalAllowed.ok, JSON.stringify(done.out.openExternalAllowed)).toBe(true);
	});

	test('T100 L5: a version change remints the frame and the app runs the new build', async ({ open, server }) => {
		const world = await open({ scenario: 'l1' });
		await world.openHome();
		await world.switchTo();
		const first = (await world.outcome('render'))!;
		expect(first.version.stamp).toBe(1);

		// The user picks version 2 (the picker applies an override), then opens the app again.
		const seeded = await server.seed(2);
		expect(seeded.version).toBeGreaterThan(first.version.version);
		await world.switchTo('rocketride.hello');
		await world.page.evaluate((version) => (window as any).__e2e.setVersion('e2e.fixture', 'e2e_fixture', version), seeded.version);
		const mark = world.reports.length;
		await world.switchTo();
		const second = await (async () => {
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const hit = world.reports.slice(mark).find((report) => report.kind === 'render' && report.version?.stamp === 2);
				if (hit) return hit;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			return undefined;
		})();
		expect(second, 'the app never ran the new version').toBeDefined();
		expect(second!.base, 'the new frame must carry a new frame token').not.toBe(first.base);
		expect(second!.origin).toBe(server.appOrigin);
	});
});

test.describe('control', () => {
	test('T102 L7: with isolation off the same app runs in the shell realm', async ({ another, openOn }) => {
		const off = await another({ mode: 'off' });
		const world = await openOn(off, { scenario: 'l1' });
		await world.openApp();
		const render = (await world.outcome('render'))!;
		expect(render.framed).toBe(false);
		expect(render.origin).toBe(off.origin);
		// No frame at all: the app is the shell's own child.
		expect(world.page.frames().filter((frame) => frame.url().includes('apps.localhost'))).toHaveLength(0);
	});
});
