#!/usr/bin/env node

// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Summarize the sanitizer reports in a log directory.
 *
 * The sanitized programs run with `log_path=<dir>/<prefix>`, so every process
 * that reports writes `<prefix>.<pid>` there. This script splits each file into
 * AddressSanitizer, LeakSanitizer and UndefinedBehaviorSanitizer reports,
 * groups equal reports, and writes a Markdown summary to $GITHUB_STEP_SUMMARY
 * (to stdout when it is not set).
 *
 * Usage: node scripts/ci/sanitizer-report.mjs <log dir>
 *
 * Exits 0 when there is no report, 1 when there is at least one, and 2 when the
 * directory does not exist. A file with output but no recognizable report
 * counts as one report of kind `other-output`, so a truncated report or a
 * sanitizer's own failure is never dropped.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** GitHub refuses a step summary over 1 MiB; this leaves room for the notes. */
export const SUMMARY_LIMIT = 900 * 1024;
const EXAMPLE_LINES = 12;
const MAX_LINE_LENGTH = 300;

const ERROR_RE = /^==\d+==ERROR: (\w*Sanitizer): (.*)$/;
const UBSAN_RE = /^(?:(.*?): )?runtime error: (.*)$/;
const SUMMARY_RE = /^SUMMARY: (\w*Sanitizer): (\S+)(.*)$/;
const FRAME_RE = /^\s*#\d+ 0x[0-9a-f]+ (.*)$/;
// Frames in the sanitizer runtime itself: malloc, operator delete, interceptors
const RUNTIME_FRAME_RE = /compiler-rt\/|libclang_rt\.|\bin __(?:interceptor|asan|ubsan|sanitizer)_/;

/**
 * Remove what differs between two runs of the same error: pids, addresses,
 * offsets into a binary, build ids, and the checkout root.
 */
export function normalize(text, root = '') {
	let result = text
		.replace(/ ?\(BuildId: [0-9a-f]+\)/g, '')
		.replace(/\+0x[0-9a-f]+\)/g, ')')
		.replace(/==\d+==/g, '')
		.replace(/0x[0-9a-f]+/g, '<addr>')
		.replace(/\s+/g, ' ')
		.trim();
	if (root) result = result.replaceAll(`${root.replace(/\/+$/, '')}/`, '');
	return result;
}

/** The first lines of a report, for the example in the summary. */
function excerpt(lines) {
	const head = lines.slice(0, EXAMPLE_LINES).map((line) => {
		const trimmed = line.trimEnd();
		return trimmed.length > MAX_LINE_LENGTH ? `${trimmed.slice(0, MAX_LINE_LENGTH)}...` : trimmed;
	});
	while (head.length && !head.at(-1)) head.pop();
	return head;
}

/** The first stack frame outside the sanitizer runtime, normalized; '' when there is none. */
function firstOwnFrame(lines, root) {
	for (const line of lines) {
		const frame = line.match(FRAME_RE);
		if (frame && !RUNTIME_FRAME_RE.test(frame[1])) return normalize(frame[1], root);
	}
	return '';
}

/** Turn the lines of one report into its sanitizer, kind and location. */
function toReport({ error, lines }, file, root) {
	const summary = lines.map((line) => line.match(SUMMARY_RE)).find(Boolean);
	const report = { file, lines: excerpt(lines) };
	if (!error) {
		const ubsan = lines[0].match(UBSAN_RE);
		return {
			...report,
			sanitizer: 'UndefinedBehaviorSanitizer',
			kind: summary ? summary[2] : 'runtime-error',
			location: normalize(summary ? summary[3] : (ubsan[1] ?? ''), root),
		};
	}
	const sanitizer = error[1];
	// A leak summary only counts bytes, so the allocating frame tells leaks apart
	if (sanitizer === 'LeakSanitizer') {
		return { ...report, sanitizer, kind: 'memory-leak', location: firstOwnFrame(lines, root) };
	}
	const kind = summary ? summary[2] : error[2].split(' ')[0];
	let location = summary ? normalize(summary[3], root) : '';
	// A summary that points into the runtime (operator delete, malloc) would put
	// every report of that kind in one group: use the caller's frame instead.
	if (!location || RUNTIME_FRAME_RE.test(location)) location = firstOwnFrame(lines, root) || location;
	return { ...report, sanitizer, kind, location };
}

/**
 * Split the text of one log file into reports.
 *
 * A report starts at an `==PID==ERROR: <Name>Sanitizer:` line or at a
 * `<location>: runtime error:` line and runs until the next one.
 */
export function parseLog(text, file, root = '') {
	const lines = text.split(/\r?\n/);
	const blocks = [];
	for (const line of lines) {
		const error = line.match(ERROR_RE);
		if (error || UBSAN_RE.test(line)) blocks.push({ error, lines: [line] });
		else if (blocks.length) blocks.at(-1).lines.push(line);
	}
	const reports = blocks.map((block) => toReport(block, file, root));
	if (!reports.length && text.trim()) {
		const meaningful = lines.filter((line) => line.trim() && !/^=+$/.test(line.trim()));
		reports.push({
			file,
			lines: excerpt(meaningful),
			sanitizer: 'unknown',
			kind: 'other-output',
			location: normalize(meaningful[0] ?? '', root),
		});
	}
	return reports;
}

/** Group reports by sanitizer, kind and location; the largest groups come first. */
export function groupReports(reports) {
	const groups = new Map();
	for (const report of reports) {
		const key = [report.sanitizer, report.kind, report.location].join('\n');
		let group = groups.get(key);
		if (!group) {
			const { sanitizer, kind, location } = report;
			group = { sanitizer, kind, location, count: 0, files: new Set(), example: report };
			groups.set(key, group);
		}
		group.count += 1;
		group.files.add(report.file);
	}
	return [...groups.values()].sort(
		(a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.location.localeCompare(b.location)
	);
}

function byteLength(text) {
	return Buffer.byteLength(text, 'utf8');
}

/** A Markdown table cell in code style. */
function cell(text) {
	return `\`${text.replaceAll('`', "'").replaceAll('|', '\\|')}\``;
}

function escapeHtml(text) {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** A code fence longer than any run of backticks in the text. */
function fence(text) {
	const runs = text.match(/`+/g) ?? [];
	return '`'.repeat(Math.max(2, ...runs.map((run) => run.length)) + 1);
}

function exampleBlock(number, group) {
	const body = group.example.lines.join('\n');
	const marks = fence(body);
	const title = escapeHtml(`#${number} ${group.kind}: ${group.count} report(s), example ${group.example.file}`);
	return `<details><summary>${title}</summary>\n\n${marks}text\n${body}\n${marks}\n\n</details>\n\n`;
}

/**
 * Render the groups as Markdown of at most `limit` bytes: a table of every
 * group that fits, then an example report per group while there is room.
 */
export function renderSummary(groups, { limit = SUMMARY_LIMIT } = {}) {
	if (!groups.length) return '## Sanitizer reports\n\nNo sanitizer reports.\n';
	const total = groups.reduce((sum, group) => sum + group.count, 0);
	const fileCount = new Set(groups.flatMap((group) => [...group.files])).size;
	const parts = [
		'## Sanitizer reports\n\n',
		`${total} report(s) in ${groups.length} group(s), from ${fileCount} file(s). ` +
			'Reports of the same kind at the same location form one group.\n\n',
		'| # | Reports | Sanitizer | Kind | Location | Files | Example file |\n',
		'| ---: | ---: | --- | --- | --- | ---: | --- |\n',
	];
	// Room for the note on what did not fit
	const budget = limit - 512;
	let size = byteLength(parts.join(''));
	const add = (text) => {
		if (size + byteLength(text) > budget) return false;
		parts.push(text);
		size += byteLength(text);
		return true;
	};

	let rows = 0;
	for (const group of groups) {
		const row =
			`| ${rows + 1} | ${group.count} | ${group.sanitizer} | ${cell(group.kind)} | ` +
			`${cell(group.location || '(unknown)')} | ${group.files.size} | ${cell(group.example.file)} |\n`;
		if (!add(row)) break;
		rows += 1;
	}
	let examples = 0;
	if (add('\n### Examples\n\n')) {
		for (const group of groups.slice(0, rows)) {
			if (!add(exampleBlock(examples + 1, group))) break;
			examples += 1;
		}
	}
	const omitted = [];
	if (rows < groups.length) omitted.push(`${groups.length - rows} group(s) left out of the table`);
	if (examples < rows) omitted.push(`${rows - examples} example(s) left out`);
	if (omitted.length) {
		parts.push(`\n_${omitted.join(', ')} to stay under the summary size limit; the report files have them all._\n`);
	}
	return parts.join('');
}

/** Read every file in `dir` (sorted by name) and return their reports. */
export async function collectReports(dir, root = '') {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const names = entries
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort();
	const reports = [];
	for (const name of names) {
		reports.push(...parseLog(await fs.readFile(path.join(dir, name), 'utf8'), name, root));
	}
	return reports;
}

/**
 * Report on the log directory in `args[0]`; resolves to the exit code.
 *
 * Paths under $GITHUB_WORKSPACE are shown relative to it.
 */
export async function main(args, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
	const [dir] = args;
	if (!dir) {
		stderr.write('Usage: node scripts/ci/sanitizer-report.mjs <log dir>\n');
		return 2;
	}
	const stat = await fs.stat(dir).catch(() => null);
	if (!stat?.isDirectory()) {
		stderr.write(`Sanitizer log directory not found: ${dir}\n`);
		return 2;
	}

	const reports = await collectReports(dir, env.GITHUB_WORKSPACE ?? '');
	const groups = groupReports(reports);
	const markdown = renderSummary(groups);
	if (env.GITHUB_STEP_SUMMARY) {
		await fs.appendFile(env.GITHUB_STEP_SUMMARY, markdown);
		if (!reports.length) stdout.write(`No sanitizer reports in ${dir}.\n`);
		for (const group of groups) {
			stdout.write(`${group.count}\t${group.sanitizer}\t${group.kind}\t${group.location}\n`);
		}
	} else {
		stdout.write(markdown);
	}
	if (!reports.length) return 0;
	stderr.write(`${reports.length} sanitizer report(s) in ${groups.length} group(s) in ${dir}.\n`);
	return 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
