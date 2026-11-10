#!/usr/bin/env node

// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { explainFailure } from './explain.mjs';
import { judgeApp, parseChecklist } from './judge.mjs';

const USAGE = `usage: cli.mjs --url <url> --checklist <file> --out <dir> [--runs 3] [--model claude-sonnet-5-5] [--budget-usd 0.6] [--timeout-ms 600000] [--local-storage <json file>]
       cli.mjs --explain <trial dir> --failed <json file> --out <dir> [--model claude-sonnet-5-5] [--budget-usd 0.5] [--timeout-ms 300000]`;
const EXIT_CODES = { pass: 0, fail: 1, inconclusive: 2 };
const EXIT_USAGE = 64;

const optionalNumber = (value) => (value === undefined ? undefined : Number(value));
// The sessions run on the eval key only, never on a credential the shell or a logged-in claude holds.
const apiKey = process.env.EVAL_ANTHROPIC_KEY;

async function judge(values) {
	if (!values.url || !values.checklist || !values.out) throw new Error(USAGE);

	const checklist = parseChecklist(fs.readFileSync(values.checklist, 'utf8'));
	// A file, so a token never shows up in the process list.
	const localStorage = values['local-storage'] ? JSON.parse(fs.readFileSync(values['local-storage'], 'utf8')) : undefined;

	const result = await judgeApp({ url: values.url, checklist, runs: optionalNumber(values.runs), model: values.model, budgetUsd: optionalNumber(values['budget-usd']), timeoutMs: optionalNumber(values['timeout-ms']), outDir: values.out, localStorage, apiKey });

	const resultFile = path.join(values.out, 'result.json');
	fs.writeFileSync(resultFile, JSON.stringify(result, null, '\t'));
	for (const run of result.runs) console.log(`run ${run.run}: ${run.verdict}, $${run.costUsd?.toFixed(3) ?? '?'}, ${Math.round(run.durationMs / 1000)}s${run.invalidReason ? `, invalid: ${run.invalidReason}` : ''}`);
	for (const line of result.lines) console.log(`line ${line.line}: ${line.verdict} (${line.runs.map((verdict) => verdict ?? 'invalid').join(' ')}) ${line.text}`);
	console.log(`verdict: ${result.verdict}, $${result.costUsd.toFixed(3)} over ${result.runs.length} runs, details in ${resultFile}`);
	process.exitCode = EXIT_CODES[result.verdict];
}

async function explain(values) {
	if (!values.failed || !values.out) throw new Error(USAGE);

	const lead = await explainFailure({ trialDir: values.explain, failed: JSON.parse(fs.readFileSync(values.failed, 'utf8')), model: values.model, budgetUsd: optionalNumber(values['budget-usd']), timeoutMs: optionalNumber(values['timeout-ms']), outDir: values.out, apiKey });

	const leadFile = path.join(values.out, 'lead.json');
	fs.writeFileSync(leadFile, JSON.stringify(lead, null, '\t'));
	if (lead.invalid) console.log(`no lead: ${lead.invalid}`);
	else console.log(`Lead (not a verdict${lead.verified ? '' : ', unverified'}): ${lead.text} Step: ${lead.step}`);
	for (const { file, quote, found } of lead.evidence) console.log(`  ${file}${found ? '' : ' (not found)'}: ${quote}`);
	console.log(`$${lead.costUsd?.toFixed(3) ?? '?'}, details in ${leadFile}`);
	process.exitCode = lead.invalid ? EXIT_CODES.inconclusive : 0;
}

try {
	const { values } = parseArgs({ options: { url: { type: 'string' }, checklist: { type: 'string' }, out: { type: 'string' }, runs: { type: 'string' }, model: { type: 'string' }, 'budget-usd': { type: 'string' }, 'timeout-ms': { type: 'string' }, 'local-storage': { type: 'string' }, explain: { type: 'string' }, failed: { type: 'string' } } });
	await (values.explain ? explain(values) : judge(values));
} catch (error) {
	console.error(error.message);
	process.exitCode = EXIT_USAGE;
}
