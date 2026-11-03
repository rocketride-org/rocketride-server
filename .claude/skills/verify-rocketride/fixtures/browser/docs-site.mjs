// The docs site as GitHub Pages serves it: the home page, sidebar navigation to a page, search,
// and the 404 page. Needs `rr-verify docs` first.
// Run: rr-verify browse --label docs-site --site docs $F/browser/docs-site.mjs [SEARCH TERM]
export default async ({ args, open, waitText, waitFor, click, fill, check, count, shot, page, expectNoErrors }) => {
	const term = args[0] || 'webhook';

	await open('/');
	await waitText('RocketRide Documentation');
	await shot('home');

	await click('nav[aria-label="Docs sidebar"] >> role=button[name="Get Started"]');
	await click('nav[aria-label="Docs sidebar"] >> role=link[name="Overview"]');
	await check('the sidebar link opened /quickstart', async () => {
		await page.waitForURL('**/quickstart');
		return new URL(page.url()).pathname.replace(/\/$/, '') === '/quickstart';
	});
	await waitFor('main h1');
	await shot('quickstart');

	await fill('role=textbox[name="Search"]', term);
	await waitFor('role=listbox >> role=option');
	await check(`the search for "${term}" lists results`, (await count('role=listbox >> role=option')) > 0);
	await shot('search');

	await open('/no-such-page-rr-verify/', { status: 404 });
	await waitText('Page Not Found');
	await shot('not-found');
	await expectNoErrors();
};
