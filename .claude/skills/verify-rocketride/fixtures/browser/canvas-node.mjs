// Pipeline Builder: start a new pipeline from a source and check how its node renders on the canvas.
// The node's settings are opened once so its full definition has loaded before the icon check.
// Run: rr-verify browse --label canvas-node $F/browser/canvas-node.mjs [SOURCE]   (default: Chat)
export default async ({ args, open, signIn, click, waitText, waitFor, check, press, count, shot, page, expectNoErrors }) => {
	const source = args[0] || 'Chat';
	// Pipeline Builder keeps every open tab in the page, so only the visible canvas counts.
	const node = '.react-flow__node >> visible=true';
	const crashed = () => page.getByText('Pipeline Builder encountered an error').isVisible();

	await open('/');
	await signIn();
	await click('role=button[name="Open Pipeline Builder"]');
	await click('role=button[name="New pipeline"]');
	await waitText('Select your starting point');
	await click(`role=button[name="${source}"] >> visible=true`);
	await waitFor(page.locator('.react-flow__node').filter({ visible: true }).or(page.getByText('Pipeline Builder encountered an error')));
	await check('Pipeline Builder did not crash', async () => !(await crashed()));
	const nodes = await count(node);
	await check(`the ${source} node is on the canvas`, nodes === 1);
	await click(`${node} >> role=button[name="Edit node"]`);
	await waitFor(`role=dialog[name="${source}"]`);
	await shot('settings');
	await press('Escape');
	await waitFor(`role=dialog[name="${source}"]`, { state: 'hidden' });
	const icons = await count(`${node} >> .rr-node-header > div:first-child :is(svg, img)`);
	await check(`the ${source} node shows its icon in the header`, icons > 0);
	await shot('canvas');
	await expectNoErrors();
};
