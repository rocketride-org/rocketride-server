// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { parseEvents, runClaude, scrub, sessionEnv } from './session.mjs';

/**
 * @typedef {{ id: string, detail: string }} Failed One failed check or failed judge line.
 * @typedef {{ file: string, quote: string, found: boolean }} Evidence A quote the session relied on, and whether it was found verbatim in that file.
 * @typedef {{ text: string, step: string, evidence: Evidence[], verified: boolean, costUsd: number | null, invalid: string | null }} Lead
 */

const TOOLS = ['Read', 'Grep', 'Glob'];

const SYSTEM = `You find out why an AI agent failed a task. The current folder holds the record of one trial: the task, what the agent did, and what came of it. You can read and search the files in this folder and nothing else.

You are given the checks the trial failed. Find the step where the agent went wrong and say why, in at most three sentences. Name the step so a person can find it in the record. The failure may not be the agent's fault. If the record shows the agent did what was asked, say so and say what went wrong instead.

Back the explanation with quotes. Copy each one character for character from a file in this folder, keep it to a line or less, and give the file's path relative to this folder. Each quote is checked against its file.

When you have finished, return your result through the structured output tool.`;

const SCHEMA = { type: 'object', additionalProperties: false, required: ['step', 'lead', 'evidence'], properties: { step: { type: 'string', description: 'Where the agent went wrong, so a person can find it in the record.' }, lead: { type: 'string', description: 'What went wrong and why, in at most three sentences.' }, evidence: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['file', 'quote'], properties: { file: { type: 'string', description: 'Path relative to the trial folder.' }, quote: { type: 'string', description: 'Text copied verbatim from that file.' } } } } } };

const hasText = (value) => typeof value === 'string' && value.trim() !== '';

function quoteIn(root, file, quote) {
	try {
		// realpath, so a symlink inside the folder that points out of it doesn't count.
		const real = fs.realpathSync(path.resolve(root, file));
		return real.startsWith(root + path.sep) && hasText(quote) && fs.readFileSync(real, 'utf8').includes(quote);
	} catch {
		return false;
	}
}

/**
 * Looks for each quote verbatim in its file. A file that resolves outside `trialDir`,
 * through `..`, an absolute path or a symlink, counts as not found.
 *
 * @param {string} trialDir
 * @param {{ file: string, quote: string }[]} evidence
 * @returns {Evidence[]}
 */
export function checkEvidence(trialDir, evidence) {
	const root = fs.realpathSync(trialDir);
	return evidence.map(({ file, quote }) => ({ file, quote, found: quoteIn(root, file, quote) }));
}

function findRejection(events, result) {
	const output = result?.structured_output;
	const offered = events.find((event) => event.type === 'system' && event.subtype === 'init')?.tools ?? [];
	const extraTools = offered.filter((tool) => tool !== 'StructuredOutput' && !TOOLS.includes(tool));
	if (!output) return `no structured output (subtype ${result?.subtype})`;
	if (extraTools.length > 0) return `offered tools beyond ${TOOLS.join(', ')}: ${extraTools.join(', ')}`;
	if (!hasText(output.lead)) return 'empty lead';
	return null;
}

/**
 * Explains a failed trial as a lead, not a verdict: one `claude -p` session over the
 * trial folder with only Read, Grep and Glob, which names the step where the agent
 * went wrong and quotes the files that show it. `verified` means code found at least
 * one quote verbatim in its file inside the trial folder.
 *
 * @param {object} options
 * @param {string} options.trialDir The session's working directory. It reads only here.
 * @param {Failed[]} options.failed What the trial failed, named in the prompt.
 * @param {string} [options.model]
 * @param {number} [options.budgetUsd] Spend limit for the session.
 * @param {number} [options.timeoutMs] Time limit for the session.
 * @param {string} options.outDir Receives `explain.jsonl`, the session's transcript, and `explain.stderr`. Must be outside `trialDir`, or the session could read its own transcript and quote it.
 * @param {string[]} [options.redact] Values of 8 characters or more are replaced in the saved transcript and the lead.
 * @returns {Promise<Lead>} `invalid` names why the session's claims don't count. A session killed at its time limit reports no cost.
 */
export async function explainFailure({ trialDir, failed, model = 'claude-sonnet-5-5', budgetUsd = 0.5, timeoutMs = 300_000, outDir, redact = [] }) {
	const root = fs.realpathSync(trialDir);
	const absoluteOutDir = path.resolve(outDir);
	if (`${absoluteOutDir}${path.sep}`.startsWith(`${path.resolve(trialDir)}${path.sep}`)) throw new Error(`outDir ${outDir} is inside trialDir ${trialDir}`);
	fs.mkdirSync(absoluteOutDir, { recursive: true });
	const transcript = path.join(absoluteOutDir, 'explain.jsonl');
	const stderr = path.join(absoluteOutDir, 'explain.stderr');

	const prompt = `Checks this trial failed:\n${failed.map(({ id, detail }) => `- ${id}: ${detail}`).join('\n')}`;
	// --restricted confines the file tools to cwd even if an allow rule, such as a managed policy, would let a read through.
	const args = ['-p', prompt, '--model', model, '--system-prompt', SYSTEM, '--tools', TOOLS.join(','), '--restricted', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--permission-mode', 'dontAsk', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(SCHEMA), '--max-budget-usd', String(budgetUsd)];
	const finished = await runClaude(args, { cwd: root, env: sessionEnv(), transcript, stderr, timeoutMs });

	scrub([transcript, stderr], redact);
	const events = parseEvents(fs.readFileSync(transcript, 'utf8'));
	const result = events.findLast((event) => event.type === 'result');
	const costUsd = result?.total_cost_usd ?? null;
	const rejection = findRejection(events, result);
	if (rejection) return { text: '', step: '', evidence: [], verified: false, costUsd, invalid: finished.failure ?? rejection };

	const { step, lead, evidence } = result.structured_output;
	const checked = checkEvidence(root, evidence);
	return { text: lead, step, evidence: checked, verified: checked.some((item) => item.found), costUsd, invalid: null };
}
