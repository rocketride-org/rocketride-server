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
// T101 (L6): ONE USER'S STORED VALUE IS UNREADABLE BY THE NEXT USER
// =============================================================================
// User A's app keeps a secret in its own origin's storage (localStorage, a
// cookie, IndexedDB). It must be gone for user B:
//   - after A logs out through `handleLogout` (the open frame goes to
//     /_rr/clear, which clears the origin's storage);
//   - when A's session ended without a logout (a closed tab, a replaced token)
//     and B boots the shell: the boot-time sweep clears the origins A visited.
// `handleBackToHome` (the same sweep, after a navigation) is reachable only from
// the SaaS waitlist screen, so the boot-time path is driven through the user
// change instead; both end in `sweepAtBoot`.
//
// With isolation off the app runs in the shell realm, its storage is the
// shell's, nothing clears it, and B reads A's secret: red.
// =============================================================================

import { expect, FIXTURE_ID, isOff, test } from '../support/harness';
import { type IServer, type IsolationMode } from '../support/server';

const MARKER = 'user-a-stored-value';

async function twoUsers(another: (options: { mode: IsolationMode; users: Record<string, { userId: string; displayName: string }> }) => Promise<IServer>) {
	const keyA = 'e2e-user-a-key';
	const keyB = 'e2e-user-b-key';
	const server = await another({
		mode: (process.env.E2E_MODE ?? 'enforce') as IsolationMode,
		users: { [keyA]: { userId: 'e2e-user-a', displayName: 'User A' }, [keyB]: { userId: 'e2e-user-b', displayName: 'User B' } },
	});
	return { server, keyA, keyB };
}

test.describe('stored values (L6)', () => {
	test("T101 L6: user A's stored value is unreadable by user B after A logs out through handleLogout", async ({ another, openOn }) => {
		const { server, keyA, keyB } = await twoUsers(another);
		const world = await openOn(server, { key: keyA, scenario: 'l6', params: { write: MARKER } });
		await world.openHome();
		await world.switchTo();
		const wrote = (await world.outcome('l6'))!;
		expect(wrote.wrote).toBe(true);

		await world.page.evaluate(() => (window as any).__e2e.logout());
		await expect.poll(async () => (await world.shellStorage())['rr:user_token'], { timeout: 20_000 }).toBeUndefined();
		if (!isOff()) {
			// The open frame was sent to the clear page.
			await expect.poll(() => world.requests.some((url) => url.startsWith(server.appOrigin + '/_rr/clear')), { timeout: 20_000 }).toBe(true);
		}

		// User B signs in on the same browser and opens the same app.
		await world.signIn(keyB);
		world.setScenario('l6', {});
		const mark = world.reports.length;
		await world.openHome();
		await world.switchTo();
		const seen = (await world.outcome('l6', { since: mark }))!;
		expect(seen.before.local, 'localStorage survived the logout').toBeNull();
		expect(seen.before.cookie, 'the cookie survived the logout').not.toContain('e2e_secret');
		expect(seen.idb, 'IndexedDB survived the logout').toBeNull();
	});

	test("T101 L6: user A's stored value is unreadable by user B after a session that ended without a logout (boot-time sweep)", async ({ another, openOn }) => {
		const { server, keyA, keyB } = await twoUsers(another);
		const world = await openOn(server, { key: keyA, scenario: 'l6', params: { write: MARKER } });
		await world.openHome();
		await world.switchTo();
		expect((await world.outcome('l6'))!.wrote).toBe(true);

		// Control: the same user coming back finds the value (nothing sweeps the owner's own origins).
		world.setScenario('l6', {});
		let mark = world.reports.length;
		await world.openHome();
		await world.switchTo();
		const again = (await world.outcome('l6', { since: mark }))!;
		expect(again.before.local, 'the value must survive a reload of the same user').toBe(MARKER);

		// A's session ends without a logout: the stored session is replaced (a closed tab, a second window)
		// and B boots the shell.
		await world.page.evaluate((key) => localStorage.setItem('rr:user_token', key), keyB);
		mark = world.reports.length;
		await world.openHome();
		await world.switchTo();
		const seen = (await world.outcome('l6', { since: mark }))!;
		expect(seen.before.local, 'localStorage survived the user change').toBeNull();
		expect(seen.before.cookie, 'the cookie survived the user change').not.toContain('e2e_secret');
		expect(seen.idb, 'IndexedDB survived the user change').toBeNull();
		if (!isOff())
			expect(
				world.requests.some((url) => url.startsWith(server.appOrigin + '/_rr/clear')),
				'no sweep frame reached the clear page'
			).toBe(true);
	});
});
