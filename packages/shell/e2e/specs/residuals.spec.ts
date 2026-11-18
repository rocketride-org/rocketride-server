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
// WHAT THE NODE TESTS COULD NOT SEE (PR2b residuals, plan section 5.4)
// =============================================================================
// PR2b's own tests run in node. These run the guest runtime, the frame UI, the
// chunk rewrite and the logout paths in a real browser:
//   R1  the guest boots from frame.html and loads the app through its frame-token
//       prefix (the chunk-URL rewrite), nothing from the shell origin;
//   R2  a refused frame is a tile, and Reload recovers;
//   R3  a frame that burns the handshake's ready budget gets no init and nothing runs;
//   R4  a server org-change push during a logout does not reconnect the old session.
// All of them need the isolated frame, so they are skipped under E2E_MODE=off.
// =============================================================================

import { expect, FIXTURE_ID, isOff, test } from '../support/harness';

test.describe('residuals', () => {
	test.skip(isOff(), 'these exercise the isolated frame');

	test('R1 the guest runtime boots in a real browser and loads the app through the frame-token prefix', async ({ open, server }) => {
		const world = await open({ scenario: 'l1' });
		const responses: Array<{ status: number; url: string }> = [];
		world.page.on('response', (response) => void responses.push({ status: response.status(), url: response.url() }));
		await world.openApp();
		const render = (await world.outcome('render'))!;
		expect(render.base, 'the app must load from its frame-token prefix').toMatch(new RegExp('^' + server.appOrigin.replace(/[.]/g, '\\.') + '/_t/[^/]+/v\\d+/$'));

		const appHost = responses.filter((r) => r.url.startsWith(server.appOrigin));
		// Every guest file and every app file (entry and chunks, after the rewrite) was served.
		expect(
			appHost.some((r) => /\/_rr\/guest-boot\.[^/]+\.js$/.test(r.url) && r.status === 200),
			'the guest entry was not served'
		).toBe(true);
		expect(
			appHost.some((r) => /\/_t\/[^/]+\/v\d+\/remoteEntry\.js$/.test(r.url) && r.status === 200),
			'remoteEntry.js was not loaded through the prefix'
		).toBe(true);
		expect(
			appHost.some((r) => /\/_t\/[^/]+\/v\d+\/static\/js\/.+\.js$/.test(r.url) && r.status === 200),
			'the app chunks were not loaded through the prefix'
		).toBe(true);
		expect(
			appHost.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url.slice(-60)}`),
			'a request on the app origin failed'
		).toEqual([]);
		// Nothing of the app came from the shell origin.
		expect(
			responses.filter((r) => r.url.startsWith(server.origin + '/apps/' + FIXTURE_ID + '/')).map((r) => r.url),
			'the app loaded from the shell origin'
		).toEqual([]);
	});

	test('R2 a refused frame is a tile, and Reload recovers', async ({ open, server }) => {
		const world = await open({ scenario: 'l1' });
		await world.page.route('**/apps/frame', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"e2e"}' }));
		await world.openApp();
		await expect(world.page.getByRole('status')).toContainText('could not be opened');
		expect(
			world.reports.filter((r) => r.kind === 'started'),
			'the app ran although its frame was refused'
		).toEqual([]);
		await world.page.unroute('**/apps/frame');
		await world.page.getByRole('button', { name: 'Reload', exact: true }).click();
		const render = (await world.outcome('render'))!;
		expect(render.origin).toBe(server.appOrigin);
	});

	test('R3 a frame that uses up the ready budget before it loads gets no init and runs nothing', async ({ open, server }) => {
		const world = await open({ scenario: 'idle' });
		// The app origin serves a page of the test's own: 8 messages (the budget is 5), then the real
		// ready, then a reload before the document has loaded. It records whatever it is sent.
		const stub = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', function (e) { console.log('STUB-GOT ' + (e.data && e.data.type) + ' ports=' + e.ports.length); });
for (var i = 0; i < 8; i++) parent.postMessage({ type: 'junk' }, ${JSON.stringify(server.origin)});
parent.postMessage({ type: 'rr:frame:ready', protoMin: 1, protoMax: 1 }, ${JSON.stringify(server.origin)});
console.log('STUB-FLOODED');
if (!sessionStorage.getItem('reloaded')) { sessionStorage.setItem('reloaded', '1'); location.reload(); }
</script>`;
		await world.context.route(server.appOrigin + '/_rr/frame.html*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: stub }));
		await world.openApp();
		await expect.poll(() => world.console.some((line) => line.includes('STUB-FLOODED')), { timeout: 20_000 }).toBe(true);
		await world.page.waitForTimeout(3000);
		expect(
			world.console.filter((line) => line.includes('STUB-GOT rr:bridge:init')),
			'the shell sent an init after the budget was used up'
		).toEqual([]);
		expect(world.reports, 'the app ran').toEqual([]);

		// The shell is not wedged: with the real frame page back, a reload opens the app.
		await world.context.unroute(server.appOrigin + '/_rr/frame.html*');
		world.setScenario('l1');
		await world.openApp();
		expect((await world.outcome('render'))!.origin).toBe(server.appOrigin);
	});

	test('R4a control: an org-change push without a logout re-authenticates and leaves no frame under the old scope', async ({ open, server }) => {
		const world = await open({ scenario: 'l1' });
		await world.openHome();
		await world.switchTo();
		await world.outcome('render');
		const frame = world.page.locator('iframe[title="E2E Fixture"]');
		const before = await frame.getAttribute('src');
		await server.clear();
		const pushed = await server.orgChange();
		expect(pushed.sent).toBeGreaterThan(0);
		await expect.poll(async () => (await server.commands()).filter((c) => c.command === 'auth' && c.credential && c.t >= pushed.t).length, { timeout: 20_000, message: 'the rescope did not reconnect' }).toBeGreaterThan(0);
		await world.page.waitForTimeout(5000);
		// The frame of the old scope is gone: no frame, or a new one (a new ticket) after a reopen.
		const after = (await frame.count()) === 0 ? null : await frame.getAttribute('src');
		expect(after === null || after !== before, 'the frame of the old scope is still there').toBe(true);
	});

	test('R4b control: a logout with no org-change push clears the app origin (the read used below)', async ({ open, server }) => {
		const world = await open({ scenario: 'l6', params: { write: 'R4-SECRET' } });
		await world.openHome();
		await world.switchTo();
		await world.outcome('l6');
		await world.page.evaluate(() => (window as any).__e2e.logout());
		await expect.poll(async () => (await world.shellStorage())['rr:user_token'], { timeout: 20_000 }).toBeUndefined();
		await world.page.waitForTimeout(2000);
		await world.signIn(server.apiKey);
		world.setScenario('l6', {});
		const mark = world.reports.length;
		await world.openHome();
		await world.switchTo();
		expect((await world.outcome('l6', { since: mark }))!.before.local, 'the app origin kept its storage across the logout').toBeNull();
	});

	test('R4b an org-change push during a logout does not reconnect the old session', async ({ open, server }) => {
		const world = await open({ scenario: 'l6', params: { write: 'R4-SECRET' } });
		await world.openHome();
		await world.switchTo();
		await world.outcome('l6');
		await server.clear();
		// The logout starts, and in the same turn the server announces an org change.
		const pushed = await world.page.evaluate(async () => {
			(window as any).__e2e.logout();
			return (await (await fetch('/__e2e/org-change', { method: 'POST' })).json()) as { sent: number; t: number };
		});
		expect(pushed.sent).toBeGreaterThan(0);
		await expect.poll(async () => (await world.shellStorage())['rr:user_token'], { timeout: 20_000 }).toBeUndefined();
		await world.page.waitForTimeout(4000);
		const reauth = (await server.commands()).filter((c) => c.command === 'auth' && c.credential && c.t >= pushed.t);
		expect(reauth, 'the rescope re-authenticated with the old session during the logout').toEqual([]);
		expect((await world.shellStorage())['rr:user_token'], 'the old session came back').toBeUndefined();
		// The logout still cleared the app's origin: the same browser signs in again and the app's value is gone.
		await world.signIn(server.apiKey);
		world.setScenario('l6', {});
		const mark = world.reports.length;
		await world.openHome();
		await world.switchTo();
		const after = (await world.outcome('l6', { since: mark }))!;
		expect(after.before.local, 'the app origin kept its storage across the logout').toBeNull();
	});
});
