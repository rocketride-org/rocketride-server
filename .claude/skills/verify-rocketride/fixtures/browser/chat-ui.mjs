// The chat page (/chat?auth=<public key>): start a chat pipeline, ask one question, wait for the
// answer, and check the conversation still shows the question.
// ARGS: pipeline file, question, text the answer must contain.
// Run: rr-verify browse --label chat-ui $F/browser/chat-ui.mjs [PIPE] [QUESTION] [EXPECTED]
// Defaults: $F/quickstart-chat.pipe, "What is RocketRide?", and the mock LLM's answer.
export default async ({ args, fixtures, pipeline, open, waitText, fill, click, check, shot, page, expectNoErrors }) => {
	const pipe = args[0] || `${fixtures}/quickstart-chat.pipe`;
	const question = args[1] || 'What is RocketRide?';
	const expected = args[2] || 'Mock LLM response';

	const { publicToken } = await pipeline(pipe);
	await open(`/chat?auth=${publicToken}`);
	await waitText('Connected', { exact: true });
	await shot('ready');
	await fill('role=textbox[name="Type your message here..."]', question);
	await click('role=button[name="Send message"]');
	await waitText(question);
	await waitText(expected, { timeout: 60000 });
	await check('the conversation still shows the question', async () => (await page.getByText(question, { exact: true }).filter({ visible: true }).count()) > 0);
	await shot('answer');
	await expectNoErrors();
};
