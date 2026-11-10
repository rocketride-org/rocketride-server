// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkApiKey, parseEvents, runClaude, scrub, sessionEnv } from './session.mjs';

/**
 * @typedef {'pass' | 'fail' | 'inconclusive'} Verdict
 * @typedef {{ line: number, verdict: 'pass' | 'fail' | 'not_tested', did: string, saw: string }} RunLine
 * @typedef {{ run: number, verdict: Verdict, invalidReason: string | null, lines: RunLine[], overall: 'pass' | 'fail' | null, costUsd: number | null, durationMs: number, exit: number | null, transcript: string }} JudgeRun
 * @typedef {{ line: number, text: string, verdict: Verdict, runs: (RunLine['verdict'] | null)[] }} JudgeLine
 * @typedef {{ verdict: Verdict, lines: JudgeLine[], runs: JudgeRun[], costUsd: number }} JudgeResult
 */

const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.84';

const SYSTEM = `You review web apps by using them in a browser, the way a careful person would.

You are given a URL and a checklist written by a person. For each checklist line, try what it describes in the running app and decide whether the line holds. Base every decision only on what you do and what you observe in the app.

Lines describe what should be true, not how the page should look. Differences in layout, styling or wording do not matter if the behaviour is right. Some apps work and some do not.

Give each line one verdict:
- pass: you tried it and it held.
- fail: you tried it and it did not hold, or the app does not offer what the line needs.
- not_tested: you could not try it for a reason outside the app's behaviour, such as your tools failing or running out of budget. Say why in the evidence.

When you have finished, return your result through the structured output tool: for each checklist line, the verdict, what you did, and what you saw. The overall verdict is fail if any line fails, otherwise pass.`;

const LINE_VERDICTS = ['pass', 'fail', 'not_tested'];
const SCHEMA = { type: 'object', additionalProperties: false, required: ['lines', 'overall'], properties: { lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['line', 'verdict', 'did', 'saw'], properties: { line: { type: 'integer' }, verdict: { enum: LINE_VERDICTS }, did: { type: 'string', description: 'The specific steps you took in the app for this line, with the exact inputs you used.' }, saw: { type: 'string', description: 'What the page actually showed as a result, quoted exactly where you can.' } } } }, overall: { enum: ['pass', 'fail'] } } };

const browserTools = (names) => names.map((name) => `mcp__playwright__${name}`);
const NAVIGATE = 'mcp__playwright__browser_navigate';
const ALLOWED = browserTools(['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_press_key', 'browser_select_option', 'browser_hover', 'browser_wait_for', 'browser_handle_dialog', 'browser_take_screenshot', 'browser_console_messages', 'browser_close', 'browser_tabs', 'browser_find']);
// Everything that could run code, read a file or read the app's source.
const BLOCKED = browserTools(['browser_evaluate', 'browser_run_code', 'browser_run_code_unsafe', 'browser_file_upload', 'browser_network_requests', 'browser_network_request', 'browser_drag', 'browser_drop', 'browser_install', 'browser_resize', 'browser_pdf_save', 'browser_start_tracing', 'browser_stop_tracing', 'browser_mouse_click_xy', 'browser_mouse_move_xy', 'browser_mouse_drag_xy', 'browser_mouse_down', 'browser_mouse_up', 'browser_mouse_wheel', 'browser_emulate_media']);

const UPLOAD = 'mcp__playwright__browser_file_upload';

/** The tools a run may use: the browser, plus file upload only when the run was given a folder to upload from. */
const toolsFor = (uploads) => (uploads ? { allowed: [...ALLOWED, UPLOAD], blocked: BLOCKED.filter((tool) => tool !== UPLOAD) } : { allowed: ALLOWED, blocked: BLOCKED });

/** The one rule for a run's lines, a line across runs and an app across runs. */
const rollUp = (verdicts) => (verdicts.includes('fail') ? 'fail' : verdicts.length > 0 && verdicts.every((verdict) => verdict === 'pass') ? 'pass' : 'inconclusive');

/**
 * A proof run saw a defect, passed every line and still said fail overall, so `overall` decides when every line passes.
 * It decides nothing otherwise, since a run that tested nothing can say fail too.
 */
function runVerdict(lines, overall) {
	const verdict = rollUp(lines.map((line) => line.verdict));
	return verdict === 'pass' ? overall : verdict;
}

const hasText = (value) => typeof value === 'string' && value.trim() !== '';

function findRejection(events, result, lineCount, allowed) {
	const output = result?.structured_output;
	const offered = events.find((event) => event.type === 'system' && event.subtype === 'init')?.tools ?? [];
	const extraTools = offered.filter((tool) => tool !== 'StructuredOutput' && !allowed.includes(tool));
	const opened = events.some((event) => event.type === 'assistant' && event.message?.content?.some((block) => block.type === 'tool_use' && block.name === NAVIGATE));
	if (!output) return `no structured output (subtype ${result?.subtype})`;
	if (extraTools.length > 0) return `offered tools beyond the browser: ${extraTools.join(', ')}`;
	if (!opened) return 'never opened the app';
	if (!Array.isArray(output.lines) || output.lines.length !== lineCount) return `wrong line count ${output.lines?.length}`;
	if (output.lines.some((line, index) => line.line !== index + 1)) return 'line numbers off';
	if (output.lines.some((line) => !LINE_VERDICTS.includes(line.verdict) || !hasText(line.did) || !hasText(line.saw))) return 'missing verdict or evidence';
	if (!['pass', 'fail'].includes(output.overall)) return 'missing overall verdict';
	return null;
}

function parseTranscript(text, lineCount, allowed) {
	const events = parseEvents(text);
	const result = events.findLast((event) => event.type === 'result');
	const invalidReason = findRejection(events, result, lineCount, allowed);
	return { invalidReason, lines: invalidReason ? [] : result.structured_output.lines, overall: invalidReason ? null : result.structured_output.overall, costUsd: result?.total_cost_usd ?? null };
}

async function judgeOnce(run, { url, checklist, model, budgetUsd, timeoutMs, outDir, localStorage, apiKey, uploadDir }) {
	const origin = new URL(url).origin;
	const scratch = path.join(outDir, `run-${run}.scratch`);
	const tmp = path.join(scratch, 'tmp');
	// macOS caps socket paths at 104 bytes and outDir can be longer, so this one directory can't live under it.
	const sockets = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-'));
	const state = path.join(scratch, 'state.json');
	const mcpConfig = path.join(scratch, 'mcp.json');
	const transcript = path.join(outDir, `run-${run}.jsonl`);
	const stderr = path.join(outDir, `run-${run}.stderr`);
	// Playwright only uploads from the session's working folder, so the session runs in a copy of the
	// upload folder kept outside any repo, and the checklist names the copy.
	const uploads = uploadDir ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'judge-files-'))) : null;
	const tools = toolsFor(uploads);
	const lines = uploads ? checklist.map((line) => line.split(uploadDir).join(uploads)) : checklist;

	const prompt = `URL: ${url}\nCurrent local date and time: ${new Date().toString()}\n\nChecklist:\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`;
	const args = ['-p', prompt, '--model', model, '--system-prompt', SYSTEM, '--tools', '', '--mcp-config', mcpConfig, '--strict-mcp-config', '--allowedTools', tools.allowed.join(','), '--disallowedTools', tools.blocked.join(','), '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--permission-mode', 'dontAsk', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(SCHEMA), '--max-budget-usd', String(budgetUsd)];
	const env = sessionEnv(apiKey, { TMPDIR: tmp, PWTEST_SOCKETS_DIR: sockets });

	const started = Date.now();
	let finished;
	try {
		fs.mkdirSync(tmp, { recursive: true });
		if (uploads) fs.cpSync(uploadDir, uploads, { recursive: true });
		fs.writeFileSync(state, JSON.stringify({ cookies: [], origins: [{ origin, localStorage: Object.entries(localStorage).map(([name, value]) => ({ name, value })) }] }), { mode: 0o600 });
		fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['-y', PLAYWRIGHT_MCP, '--headless', '--isolated', '--browser', 'chromium', '--allowed-origins', origin, '--storage-state', state, '--output-dir', path.join(scratch, 'browser'), '--no-webmcp', '--timeout-action', '5000', '--viewport-size', '1440x900'] } } }));
		// The session is told its working directory and whether that's a git repo, so point it at neither the results nor a repo.
		finished = await runClaude(args, { cwd: uploads ?? '/', env, transcript, stderr, timeoutMs });
	} finally {
		for (const dir of [scratch, sockets, uploads].filter(Boolean)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
	}
	const durationMs = Date.now() - started;

	// A page can show or log a seeded value, and it would land in the transcript.
	scrub([transcript, stderr], [...Object.values(localStorage), apiKey]);
	const parsed = parseTranscript(fs.readFileSync(transcript, 'utf8'), checklist.length, tools.allowed);
	const invalidReason = parsed.invalidReason && (finished.failure ?? parsed.invalidReason);
	return { run, verdict: invalidReason ? 'inconclusive' : runVerdict(parsed.lines, parsed.overall), ...parsed, invalidReason, durationMs, exit: finished.exit, transcript };
}

/** A checklist file's text as its lines: one expectation per line, trimmed, blank lines left out. */
export function parseChecklist(text) {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * Judges a running app against a person-written checklist, one fresh `claude -p`
 * session per run with only browser tools, limited to the URL's origin.
 *
 * `fail` means a valid run failed a line, or passed every line and said fail
 * overall. `inconclusive` means an invalid run or a `not_tested` line with no
 * failure. `pass` means every run tested every line and found nothing wrong.
 *
 * @param {object} options
 * @param {string} options.url The app to open. Its origin limits where the browser can go.
 * @param {string[]} options.checklist One expectation per entry, numbered in this order.
 * @param {number} [options.runs] Fresh sessions to run, one after another.
 * @param {string} [options.model]
 * @param {number} [options.budgetUsd] Spend limit for each run.
 * @param {number} [options.timeoutMs] Time limit for each run.
 * @param {string} options.outDir Receives each run's transcript. Scratch files live here during a run. The judge can see this path, so don't name it after the expected verdict.
 * @param {Record<string, string>} [options.localStorage] Seeded for the URL's origin. Values of 8 characters or more are replaced in the saved transcripts.
 * @param {string} options.apiKey The Anthropic API key the sessions run on, as `ANTHROPIC_API_KEY`. No other Anthropic credential reaches them, and the key is replaced in the saved transcripts.
 * @param {string} [options.uploadDir] A folder of files the sessions may upload into the app. Each session gets a fresh copy outside any repo as its working folder, and checklist lines that name a file in this folder are rewritten to the copy. Without it, uploading is blocked.
 * @returns {Promise<JudgeResult>} `costUsd` adds up what the runs reported, and a run killed at its time limit reports nothing.
 */
export async function judgeApp({ url, checklist, runs = 3, model = 'claude-sonnet-5-5', budgetUsd = 0.6, timeoutMs = 600_000, outDir, localStorage = {}, apiKey, uploadDir }) {
	if (checklist.length === 0) throw new Error('checklist has no lines');
	checkApiKey(apiKey);
	if (!Number.isInteger(runs) || runs < 1) throw new Error(`runs must be a positive integer, got ${runs}`);
	const absoluteOutDir = path.resolve(outDir);
	fs.mkdirSync(absoluteOutDir, { recursive: true });

	const completed = [];
	for (let run = 1; run <= runs; run++) {
		completed.push(await judgeOnce(run, { url, checklist, model, budgetUsd, timeoutMs, outDir: absoluteOutDir, localStorage, apiKey, uploadDir: uploadDir && path.resolve(uploadDir) }));
	}

	const lines = checklist.map((text, index) => {
		const verdicts = completed.map((run) => run.lines[index]?.verdict ?? null);
		return { line: index + 1, text, verdict: rollUp(verdicts), runs: verdicts };
	});
	return { verdict: rollUp(completed.map((run) => run.verdict)), lines, runs: completed, costUsd: completed.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) };
}
