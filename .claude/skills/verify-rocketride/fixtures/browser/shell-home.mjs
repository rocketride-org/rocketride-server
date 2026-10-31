// The shell's home page, signed out: the welcome heading, one tile per shell app, and their icons.
// Run: rr-verify browse --label shell-home $F/browser/shell-home.mjs
export default async ({ open, waitText, count, check, step, shot, page, expectNoErrors }) => {
	await open('/');
	await waitText('Welcome to RocketRide');
	const tiles = await count('role=button[name=/^Open /]');
	await check('the home page shows at least one app tile', tiles > 0);
	const broken = await step('list app icons that did not load', () => page.locator('img').evaluateAll((imgs) => imgs.filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.getAttribute('src'))));
	await check(`every app icon loaded (broken: ${broken.join(', ') || 'none'})`, broken.length === 0);
	await shot('home');
	await expectNoErrors();
};
