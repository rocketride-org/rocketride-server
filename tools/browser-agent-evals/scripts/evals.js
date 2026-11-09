/**
 * Build tasks for the browser agent evals
 *
 * Commands:
 *   browser-agent:eval - runs src/run.ts, the eval runner. The builder keeps
 *                        flags such as --help for itself, so EVAL_ARGS holds
 *                        the runner's arguments (default: validate), e.g.
 *                        EVAL_ARGS="--help", or EVAL_ARGS="run --model
 *                        anthropic/claude-haiku-5-5" to run trials in a
 *                        browser. --pattern=<id> picks tasks. Not a :test
 *                        action, so ./builder test never runs it.
 *   browser-agent:test - the runner's own unit tests (node:test).
 */

const path = require('path');
const { readdir } = require('node:fs/promises');
const { execCommand } = require('../../../scripts/lib');

// tools/browser-agent-evals (one level up from this file)
const TOOL_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(TOOL_ROOT, 'src');

function makeEvalAction() {
	return {
		description: 'Running the browser agent evals',
		run: async (ctx, task) => {
			const argv = (process.env.EVAL_ARGS || 'validate').split(/\s+/).filter(Boolean);
			const pattern = ctx.options?.pattern ?? [];
			if (pattern.length && !argv.includes('--task')) argv.push('--task', pattern.join(','));
			await execCommand('node', ['--import', 'tsx', 'src/run.ts', ...argv], { task, cwd: TOOL_ROOT });
		},
	};
}

function makeTestAction() {
	return {
		description: 'Testing the browser agent eval runner',
		run: async (_ctx, task) => {
			const testFiles = (await readdir(SRC_DIR, { recursive: true }))
				.filter((f) => f.endsWith('.test.ts'))
				.map((f) => path.join('src', f));
			await execCommand('node', ['--import', 'tsx', '--test', '--test-reporter=spec', ...testFiles], {
				task,
				cwd: TOOL_ROOT,
			});
		},
	};
}

module.exports = {
	name: 'browser-agent',
	description: 'Browser agent evals',
	actions: [
		{ name: 'browser-agent:eval', action: makeEvalAction },
		{ name: 'browser-agent:test', action: makeTestAction },
	],
};
