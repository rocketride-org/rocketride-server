#!/usr/bin/env node

// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Add function, file and line to the sanitizer reports in a log directory.
 *
 * The sanitize job runs with `symbolize=0`, so a report names each frame only by
 * its module and the offset into it:
 *
 *     #0 0x55b8421ed2f6  (/x/dist/server/engine+0xc62f6) (BuildId: 428d…)
 *
 * This script rewrites every file in the directory in place, each such frame in
 * the form the sanitizer runtime prints with its own symbolizer (compiler-rt's
 * default stack_trace_format, `    #%n %p %F %L`):
 *
 *     #0 0x55b8421ed2f6 in FUNCTION FILE:LINE:COLUMN                    the file is known
 *     #0 0x55b8421ed2f6 in FUNCTION (/x/engine+0xc62f6) (BuildId: 428d…)  only the function is known
 *
 * A frame with inlined calls becomes one line per function, innermost first, all
 * with the same PC, and the later frames of its stack are renumbered. A frame the
 * symbolizer cannot name keeps its line. The `SUMMARY:` line of an
 * AddressSanitizer report gets the location the runtime picks: the first frame of
 * the report's first stack outside the runtime and the C++ library headers.
 * Lines already symbolized stay as they are, so a second run changes nothing.
 *
 * One llvm-symbolizer process runs per module with all of its offsets, so each
 * module's debug info is read once. The symbolizer is $ASAN_SYMBOLIZER_PATH, else
 * llvm-symbolizer on PATH. The frames of a module that is not on disk, or that
 * the symbolizer cannot read, stay as they are, with one note per module.
 *
 * Usage: node scripts/ci/sanitizer-symbolize.mjs <log dir>
 *
 * Exits 0 when done, also when there is nothing to symbolize, and 2 on a usage
 * error, when the directory does not exist, or when the symbolizer is missing,
 * does not start or fails.
 */

import { spawn } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Any frame line: its indent, its number, and the rest from the PC on
const FRAME_RE = /^(\s*)#(\d+)( 0x[0-9a-f]+ .*)$/;
// A frame without a function, as printed with symbolize=0: `    #1 0x7f..  (/x/libc.so.6+0x29d8f) (BuildId: 12b8…)`
const RAW_FRAME_RE = /^(\s*)#(\d+) 0x([0-9a-f]+) {2}\((.+)\+0x([0-9a-f]+)\)( \(BuildId: [0-9a-f]+\))?$/;
const ASAN_ERROR_RE = /^==\d+==ERROR: AddressSanitizer:/;
// An AddressSanitizer summary that names only a module location (`%L %F` without a function)
const RAW_SUMMARY_RE = /^(SUMMARY: AddressSanitizer: \S+) \((.+)\+0x([0-9a-f]+)\)( \(BuildId: [0-9a-f]+\))? $/;
// Files whose frames the runtime skips when it picks the summary location (compiler-rt's FrameIsInternal)
const INTERNAL_FILE_RE = /\/compiler-rt\/lib\/|\\compiler-rt\\lib\\|\/include\/c\+\+\/|\/include\/g\+\+/;

/** `%F`: `in FUNCTION` without the interceptor prefix the runtime strips, or '' when the function is unknown. */
function functionPart(symbol) {
	return symbol.FunctionName ? `in ${symbol.FunctionName.replace(/^_{2,3}interceptor_/, '')}` : '';
}

/**
 * `%L`: `FILE`, `FILE:LINE` or `FILE:LINE:COLUMN` when the file is known, else
 * `(MODULE+0xOFFSET)` with the build id, which the runtime prints only on the
 * first frame of a PC.
 */
function locationPart(symbol, entry, first) {
	if (symbol.FileName) {
		if (!(symbol.Line > 0)) return symbol.FileName;
		return symbol.Column > 0
			? `${symbol.FileName}:${symbol.Line}:${symbol.Column}`
			: `${symbol.FileName}:${symbol.Line}`;
	}
	return `(${entry.module}+0x${entry.offset})${first ? entry.buildId : ''}`;
}

/** True when the symbolizer knows the function or the file of a frame. */
function named(symbol) {
	return Boolean(symbol.FunctionName || symbol.FileName);
}

function isInternal(entry, symbol) {
	return entry.module.includes('clang_rt.') || INTERNAL_FILE_RE.test(symbol.FileName ?? '');
}

/**
 * The summary line of an AddressSanitizer report whose first stack is `stack`,
 * or `line` unchanged when that stack was not printed wholly without
 * symbolization or the summary is not at the frame the runtime picked for it.
 */
function summaryLine(line, [, prefix, module, offset], stack) {
	if (!stack.length || stack.some((entry) => !entry)) return line;
	// Without symbolization the runtime skips only frames in its own shared library
	const picked = stack.find((entry) => !entry.module.includes('clang_rt.')) ?? stack[0];
	if (picked.module !== module || picked.offset !== offset) return line;
	const render = (entry, symbol, first) =>
		`${prefix} ${locationPart(symbol, entry, first)} ${functionPart(symbol)}`;
	for (const entry of stack) {
		const symbols = entry.symbols.length ? entry.symbols : [{}];
		const index = symbols.findIndex((symbol) => !isInternal(entry, symbol));
		if (index >= 0) return render(entry, symbols[index], index === 0);
	}
	return render(stack[0], stack[0].symbols[0] ?? {}, true);
}

/** The module and offset (`0x…`) of every unsymbolized frame in a log file. */
export function rawFrames(text) {
	const frames = [];
	for (const line of text.split('\n')) {
		const raw = line.match(RAW_FRAME_RE);
		if (raw) frames.push({ module: raw[4], offset: `0x${raw[5]}` });
	}
	return frames;
}

/**
 * Symbolize the unsymbolized frames in the text of one log file.
 *
 * `lookup(module, offset)` returns what llvm-symbolizer knows of an offset
 * (`0x…`) into a module: the `Symbol` array of its JSON output, innermost
 * function first, each with `FunctionName`, `FileName`, `Line` and `Column`
 * ('' or 0 when unknown); an empty array or undefined when it knows nothing.
 */
export function symbolizeText(text, lookup) {
	const out = [];
	// Lines that inlined calls added earlier in the same stack; each later frame number grows by it
	let shift = 0;
	// The open AddressSanitizer report and its first stack: one entry per frame, null for a symbolized frame
	let report = null;
	for (const line of text.split('\n')) {
		const frame = line.match(FRAME_RE);
		if (!frame) {
			if (report?.stack.length) report.closed = true;
			if (ASAN_ERROR_RE.test(line)) report = { stack: [], closed: false };
			const summary = report && line.match(RAW_SUMMARY_RE);
			out.push(summary ? summaryLine(line, summary, report.stack) : line);
			if (line.startsWith('SUMMARY: ')) report = null;
			continue;
		}
		const [, indent, number, rest] = frame;
		if (number === '0') shift = 0;
		const first = Number(number) + shift;
		const raw = line.match(RAW_FRAME_RE);
		const entry = raw && {
			module: raw[4],
			offset: raw[5],
			buildId: raw[6] ?? '',
			symbols: lookup(raw[4], `0x${raw[5]}`) ?? [],
		};
		if (report && !report.closed) report.stack.push(entry);
		if (!entry?.symbols.some(named)) {
			out.push(`${indent}#${first}${rest}`);
			continue;
		}
		entry.symbols.forEach((symbol, index) => {
			const where = locationPart(symbol, entry, index === 0);
			out.push(`${indent}#${first + index} 0x${raw[3]} ${functionPart(symbol)} ${where}`);
		});
		shift += entry.symbols.length - 1;
	}
	return out.join('\n');
}

function sameAddress(printed, offset) {
	return typeof printed === 'string' && /^0x[0-9a-f]+$/i.test(printed) && BigInt(printed) === BigInt(offset);
}

/**
 * Run one llvm-symbolizer on `offsets` (`0x…`) of `module`. Resolves to
 * `{ symbols }`, one `Symbol` array per offset, or to `{ error }` when the
 * symbolizer cannot read the module; rejects when it does not start or fails.
 */
function symbolizeModule(symbolizer, module, offsets) {
	return new Promise((resolve, reject) => {
		const child = spawn(symbolizer, [`--obj=${module}`, '--output-style=JSON', '--inlines', '--demangle']);
		const stdout = [];
		const stderr = [];
		child.stdout.on('data', (chunk) => stdout.push(chunk));
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		// It stops reading at a module it cannot open; its output says why
		child.stdin.on('error', () => {});
		child.on('error', (error) => reject(new Error(`cannot start the symbolizer ${symbolizer}: ${error.message}`)));
		child.on('close', (code, signal) => {
			const fail = (what) => {
				const detail = Buffer.concat(stderr).toString('utf8').trim();
				reject(new Error(`${symbolizer} failed on ${module}: ${what}${detail ? ` (${detail})` : ''}`));
			};
			let results;
			try {
				const lines = Buffer.concat(stdout).toString('utf8').split('\n');
				results = lines.filter((line) => line.trim()).map((line) => JSON.parse(line));
			} catch (error) {
				fail(`output that is not JSON: ${error.message}`);
				return;
			}
			const unreadable = results.find((result) => result?.Error);
			if (unreadable) {
				resolve({ error: unreadable.Error.Message ?? 'unknown error' });
				return;
			}
			if (signal || code !== 0) {
				fail(signal ? `killed by ${signal}` : `exit code ${code}`);
				return;
			}
			const matches =
				results.length === offsets.length &&
				results.every(
					(result, index) => Array.isArray(result?.Symbol) && sameAddress(result.Address, offsets[index])
				);
			if (!matches) {
				fail(`${results.length} results that do not match the ${offsets.length} offsets`);
				return;
			}
			resolve({ symbols: results.map((result) => result.Symbol) });
		});
		child.stdin.end(offsets.map((offset) => `${offset}\n`).join(''));
	});
}

async function isFile(file) {
	return (await fs.stat(file).catch(() => null))?.isFile() ?? false;
}

/** Symbolize the log directory in `args[0]` in place; resolves to the exit code. */
export async function main(args, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
	const [dir] = args;
	if (!dir) {
		stderr.write('Usage: node scripts/ci/sanitizer-symbolize.mjs <log dir>\n');
		return 2;
	}
	const stat = await fs.stat(dir).catch(() => null);
	if (!stat?.isDirectory()) {
		stderr.write(`Sanitizer log directory not found: ${dir}\n`);
		return 2;
	}
	const github = env.GITHUB_ACTIONS === 'true';
	const note = (text) => stdout.write(github ? `::notice::${text}\n` : `note: ${text}\n`);

	const entries = await fs.readdir(dir, { withFileTypes: true });
	const names = entries
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort();
	const texts = new Map();
	const offsets = new Map();
	for (const name of names) {
		const text = await fs.readFile(path.join(dir, name), 'utf8');
		texts.set(name, text);
		for (const { module, offset } of rawFrames(text)) {
			if (!offsets.has(module)) offsets.set(module, new Set());
			offsets.get(module).add(offset);
		}
	}
	if (!offsets.size) {
		stdout.write(`No unsymbolized frames in ${dir}.\n`);
		return 0;
	}

	const symbolizer = env.ASAN_SYMBOLIZER_PATH || 'llvm-symbolizer';
	const known = new Map();
	for (const [module, set] of offsets) {
		const list = [...set];
		if (!(await isFile(module))) {
			note(`${module} is not on disk; its ${list.length} offset(s) stay unsymbolized.`);
			continue;
		}
		let result;
		try {
			result = await symbolizeModule(symbolizer, module, list);
		} catch (error) {
			const hint = env.ASAN_SYMBOLIZER_PATH ? '' : '; set ASAN_SYMBOLIZER_PATH or put llvm-symbolizer on PATH';
			stderr.write(`${github ? '::error::' : ''}${error.message}${hint}. The reports in ${dir} are unchanged.\n`);
			return 2;
		}
		if (result.error) {
			const left = `its ${list.length} offset(s) stay unsymbolized`;
			note(`${symbolizer} cannot read ${module} (${result.error}); ${left}.`);
			continue;
		}
		list.forEach((offset, index) => known.set(`${module}\n${offset}`, result.symbols[index]));
	}

	const lookup = (module, offset) => known.get(`${module}\n${offset}`);
	let total = 0;
	let left = 0;
	let changed = 0;
	for (const [name, text] of texts) {
		const symbolized = symbolizeText(text, lookup);
		total += rawFrames(text).length;
		left += rawFrames(symbolized).length;
		if (symbolized === text) continue;
		await fs.writeFile(path.join(dir, name), symbolized);
		changed += 1;
	}
	stdout.write(
		`Symbolized ${total - left} of ${total} unsymbolized frame(s); ` +
			`${changed} of ${names.length} file(s) in ${dir} changed.\n`
	);
	return 0;
}

/** True when Node started this file as the script, also through a symlink or junction. */
function startedAsScript() {
	if (!process.argv[1]) return false;
	// import.meta.url holds the real path; argv[1] keeps the path as typed
	try {
		return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

if (startedAsScript()) {
	process.exitCode = await main(process.argv.slice(2));
}
