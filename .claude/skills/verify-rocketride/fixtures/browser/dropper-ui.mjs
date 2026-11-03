// The dropper page (/dropper?auth=<public key>): start a dropper pipeline, upload a text file, wait
// for the text the pipeline returns, then remove the file and check its result goes with it.
// ARGS: a pipeline file, or a dropper URL that is already running (such as MCP's dropper_url);
// then the text to put in the uploaded file.
// Run: rr-verify browse --label dropper-ui $F/browser/dropper-ui.mjs [PIPE|URL] [TEXT]
// Defaults: $F/dropper-text.pipe (Dropper, Parse, Return Text) and "hello from the dropper page".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async ({ args, fixtures, env, pipeline, open, waitText, waitFor, upload, click, check, count, shot, expectNoErrors }) => {
	const target = args[0] || `${fixtures}/dropper-text.pipe`;
	const text = args[1] || 'hello from the dropper page';
	const file = path.join(os.tmpdir(), `rr-verify-${path.basename(env.runDir)}-dropper-note.txt`);
	fs.writeFileSync(file, `${text}\n`);

	if (/^(https?:|\/dropper)/.test(target)) {
		await open(target);
	} else {
		const { publicToken } = await pipeline(target);
		await open(`/dropper?auth=${publicToken}`);
	}
	await waitText('Connected', { exact: true });
	await waitText('Drop files or click');
	await upload('input[type=file]', file);
	await waitText(path.basename(file));
	await waitText(text, { timeout: 60000 });
	await check('one file is listed', (await count('role=button[name="Remove file"]')) === 1);
	await shot('result');
	await click('role=button[name="Remove file"]');
	await waitFor('role=button[name="Remove file"]', { state: 'hidden' });
	await waitFor(`text=${text}`, { state: 'hidden', timeout: 5000 });
	await shot('removed');
	await expectNoErrors();
};
