#!/usr/bin/env node

// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { judgeApp } from './judge.mjs';

const USAGE = 'usage: cli.mjs --url <url> --checklist <file> --out <dir> [--runs 3] [--model claude-sonnet-5-5] [--budget-usd 0.6] [--timeout-ms 600000] [--local-storage <json file>]';
const EXIT_CODES = { pass: 0, fail: 1, inconclusive: 2 };
const EXIT_USAGE = 64;

const optionalNumber = (value) => (value === undefined ? undefined : Number(value));

try {
	const { values } = parseArgs({ options: { url: { type: 'string' }, checklist: { type: 'string' }, out: { type: 'string' }, runs: { type: 'string' }, model: { type: 'string' }, 'budget-usd': { type: 'string' }, 'timeout-ms': { type: 'string' }, 'local-storage': { type: 'string' } } });
	if (!values.url || !values.checklist || !values.out) throw new Error(USAGE);

	const checklist = fs
		.readFileSync(values.checklist, 'utf8')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	// A file, so a token never shows up in the process list.
	const localStorage = values['local-storage'] ? JSON.parse(fs.readFileSync(values['local-storage'], 'utf8')) : undefined;

	const result = await judgeApp({ url: values.url, checklist, runs: optionalNumber(values.runs), model: values.model, budgetUsd: optionalNumber(values['budget-usd']), timeoutMs: optionalNumber(values['timeout-ms']), outDir: values.out, localStorage });

	const resultFile = path.join(values.out, 'result.json');
	fs.writeFileSync(resultFile, JSON.stringify(result, null, '\t'));
	for (const run of result.runs) console.log(`run ${run.run}: ${run.verdict}, $${run.costUsd?.toFixed(3) ?? '?'}, ${Math.round(run.durationMs / 1000)}s${run.invalidReason ? `, invalid: ${run.invalidReason}` : ''}`);
	for (const line of result.lines) console.log(`line ${line.line}: ${line.verdict} (${line.runs.map((verdict) => verdict ?? 'invalid').join(' ')}) ${line.text}`);
	console.log(`verdict: ${result.verdict}, $${result.costUsd.toFixed(3)} over ${result.runs.length} runs, details in ${resultFile}`);
	process.exitCode = EXIT_CODES[result.verdict];
} catch (error) {
	console.error(error.message);
	process.exitCode = EXIT_USAGE;
}
