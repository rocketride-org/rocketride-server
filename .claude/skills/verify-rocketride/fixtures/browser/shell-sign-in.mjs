// Sign in to the shell: a wrong API key is refused with a message, the run's key signs in, and
// Sign Out returns to the signed-out home page.
// Run: rr-verify browse --label shell-sign-in $F/browser/shell-sign-in.mjs
export default async ({ open, click, fill, waitText, waitFor, signIn, shot, expectNoErrors }) => {
	await open('/');
	await click('role=button[name="Sign In"]');
	await fill('role=textbox[name="API key"]', 'wrong-key');
	await click('role=button[name="Connect"]');
	await waitText('Invalid API key');
	await shot('wrong-key');
	await click('role=button[name="Cancel"]');
	await signIn();
	await waitText('Connected');
	await shot('signed-in');
	await click('role=button[name="Sign Out"]');
	await waitFor('role=button[name="Sign In"]');
	await shot('signed-out');
	await expectNoErrors();
};
