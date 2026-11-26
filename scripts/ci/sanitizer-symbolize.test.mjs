// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Tests for the offline symbolization of sanitizer reports.
 *
 * Run:
 *     node --test scripts/ci/sanitizer-symbolize.test.mjs
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseLog } from './sanitizer-report.mjs';
import { main, symbolizeText } from './sanitizer-symbolize.mjs';

const ROOT = '/w';
const ENGINE = `${ROOT}/dist/server/engine`;
const LIBENGINE = `${ROOT}/dist/server/libengine.so`;
const LIBCXXABI = `${ROOT}/dist/server/libc++abi.so.1`;
const LIBCXX = `${ROOT}/dist/server/libc++.so.1`;
const LIBC = '/lib/x86_64-linux-gnu/libc.so.6';
const SOURCE = `${ROOT}/packages/server/engine-lib/engLib/store/python/python-endpoint.source.cpp`;
const ID = ' (BuildId: 428d8297)';

const text = (...lines) => `${lines.join('\n')}\n`;
/** A frame as the runtime prints it with symbolize=0. */
const raw = (number, pc, module, offset, buildId = ID) => `    #${number} 0x${pc}  (${module}+0x${offset})${buildId}`;
/** One entry of llvm-symbolizer's JSON `Symbol` array. */
const symbol = (FunctionName, FileName = '', Line = 0, Column = 0) => ({ FunctionName, FileName, Line, Column });
/** A fake symbolizer over a table `{ 'module+0xoffset': Symbol array }`. */
const fake = (table) => (module, offset) => table[`${module}+${offset}`];

describe('frame symbolization', () => {
	it('writes a frame with a file as `in FUNCTION FILE[:LINE[:COLUMN]]`, without the module', () => {
		const lookup = fake({
			[`${LIBENGINE}+0x10`]: [symbol('scan()', SOURCE, 110, 9)],
			[`${LIBENGINE}+0x20`]: [symbol('dispatch()', '/w/include/pybind11/pybind11.h')],
			[`${LIBENGINE}+0x30`]: [symbol('call()', '/w/src/call.c', 325)],
		});
		const input = text(
			raw(0, 'a10', LIBENGINE, '10'),
			raw(1, 'a20', LIBENGINE, '20'),
			raw(2, 'a30', LIBENGINE, '30', '')
		);
		assert.equal(
			symbolizeText(input, lookup),
			text(
				`    #0 0xa10 in scan() ${SOURCE}:110:9`,
				'    #1 0xa20 in dispatch() /w/include/pybind11/pybind11.h',
				'    #2 0xa30 in call() /w/src/call.c:325'
			)
		);
	});

	it('writes a frame with only a function as `in FUNCTION (MODULE+0xOFFSET)`, with its build id', () => {
		const lookup = fake({
			[`${LIBCXXABI}+0x29f63`]: [symbol('__cxa_end_catch')],
			[`${ENGINE}+0x2c344`]: [symbol('_start')],
			[`${ENGINE}+0xc62f6`]: [symbol('___interceptor_free')],
		});
		const input = text(
			raw(0, '7f2df63', LIBCXXABI, '29f63'),
			raw(1, '55c344', ENGINE, '2c344', ''),
			raw(2, '55c62f6', ENGINE, 'c62f6')
		);
		assert.equal(
			symbolizeText(input, lookup),
			text(
				`    #0 0x7f2df63 in __cxa_end_catch (${LIBCXXABI}+0x29f63)${ID}`,
				`    #1 0x55c344 in _start (${ENGINE}+0x2c344)`,
				// The runtime does not show the interceptor prefix
				`    #2 0x55c62f6 in free (${ENGINE}+0xc62f6)${ID}`
			)
		);
	});

	it('adds a line per inlined function and renumbers the rest of its stack only', () => {
		const lookup = fake({
			[`${LIBENGINE}+0x83a`]: [
				symbol('readPast()', '/w/a.cpp', 5, 85),
				symbol('outer()', '/w/a.cpp', 7, 70),
				// An inlined frame has no build id of its own
				symbol('caller()'),
			],
			[`${LIBENGINE}+0x900`]: [symbol('main', '/w/a.cpp', 12, 13)],
		});
		const input = text(
			raw(0, 'b83a', LIBENGINE, '83a'),
			raw(1, 'b900', LIBENGINE, '900'),
			raw(2, '7f94a82', LIBC, '94a82'),
			'',
			'allocated by thread T0 here:',
			raw(0, 'b900', LIBENGINE, '900')
		);
		assert.equal(
			symbolizeText(input, lookup),
			text(
				'    #0 0xb83a in readPast() /w/a.cpp:5:85',
				'    #1 0xb83a in outer() /w/a.cpp:7:70',
				`    #2 0xb83a in caller() (${LIBENGINE}+0x83a)`,
				'    #3 0xb900 in main /w/a.cpp:12:13',
				`    #4 0x7f94a82  (${LIBC}+0x94a82)${ID}`,
				'',
				'allocated by thread T0 here:',
				'    #0 0xb900 in main /w/a.cpp:12:13'
			)
		);
	});

	it('keeps a frame the symbolizer cannot name', () => {
		const lookup = fake({ [`${LIBC}+0x29d8f`]: [symbol('')], [`${LIBC}+0x29e3f`]: [] });
		const input = text(
			raw(0, '7f9d8f', LIBC, '29d8f'),
			raw(1, '7f9e3f', LIBC, '29e3f'),
			raw(2, '7f1', '/gone', '1')
		);
		assert.equal(symbolizeText(input, lookup), input);
	});
});

// The shape of the known libc++abi report in CI: the runtime has no line tables, so `free` keeps its module
const MISMATCH_LOOKUP = fake({
	[`${ENGINE}+0xc62f6`]: [symbol('__interceptor_free')],
	[`${LIBCXXABI}+0x27bdb`]: [symbol('std::range_error::~range_error()')],
	[`${LIBCXXABI}+0x29f63`]: [symbol('__cxa_end_catch')],
	[`${LIBENGINE}+0x83a`]: [
		symbol('scanObjects()::$_0::operator()() const', SOURCE, 110, 9),
		symbol('scanObjects()', SOURCE, 117, 12),
	],
	[`${ENGINE}+0x1038ed`]: [symbol('operator new(unsigned long)')],
	[`${LIBCXX}+0x5259f`]: [symbol('std::runtime_error::runtime_error(char const*)')],
});
const mismatchReport = (stack, allocated, summary) =>
	text(
		'='.repeat(65),
		'==18427==ERROR: AddressSanitizer: alloc-dealloc-mismatch (operator new vs free) on 0x5080058984a0',
		...stack,
		'',
		'0x5080058984a0 is located 0 bytes inside of 90-byte region [0x5080058984a0,0x5080058984fa)',
		'allocated by thread T115 here:',
		...allocated,
		'',
		summary,
		"==18427==HINT: if you don't care about these errors you may set ASAN_OPTIONS=alloc_dealloc_mismatch=0"
	);
const MISMATCH_RAW = mismatchReport(
	[
		raw(0, '55b8421ed2f6', ENGINE, 'c62f6'),
		raw(1, '7f6783a2bbdb', LIBCXXABI, '27bdb'),
		raw(2, '7f6783a2df63', LIBCXXABI, '29f63'),
		raw(3, '7f677ea7083a', LIBENGINE, '83a'),
		raw(4, '7f677d894a82', LIBC, '94a82'),
	],
	[raw(0, '55b84222a8ed', ENGINE, '1038ed'), raw(1, '7f677dd5859f', LIBCXX, '5259f')],
	`SUMMARY: AddressSanitizer: alloc-dealloc-mismatch (${ENGINE}+0xc62f6)${ID} `
);
// What the runtime prints for the same report with its own symbolizer
const MISMATCH_SYMBOLIZED = mismatchReport(
	[
		`    #0 0x55b8421ed2f6 in free (${ENGINE}+0xc62f6)${ID}`,
		`    #1 0x7f6783a2bbdb in std::range_error::~range_error() (${LIBCXXABI}+0x27bdb)${ID}`,
		`    #2 0x7f6783a2df63 in __cxa_end_catch (${LIBCXXABI}+0x29f63)${ID}`,
		`    #3 0x7f677ea7083a in scanObjects()::$_0::operator()() const ${SOURCE}:110:9`,
		`    #4 0x7f677ea7083a in scanObjects() ${SOURCE}:117:12`,
		`    #5 0x7f677d894a82  (${LIBC}+0x94a82)${ID}`,
	],
	[
		`    #0 0x55b84222a8ed in operator new(unsigned long) (${ENGINE}+0x1038ed)${ID}`,
		`    #1 0x7f677dd5859f in std::runtime_error::runtime_error(char const*) (${LIBCXX}+0x5259f)${ID}`,
	],
	`SUMMARY: AddressSanitizer: alloc-dealloc-mismatch (${ENGINE}+0xc62f6)${ID} in free`
);

describe('report symbolization', () => {
	it('gives a report the text the runtime prints, so the known entry matches as on its own output', () => {
		const symbolized = symbolizeText(MISMATCH_RAW, MISMATCH_LOOKUP);
		assert.equal(symbolized, MISMATCH_SYMBOLIZED);
		const [report] = parseLog(symbolized, 'report.18427', ROOT);
		assert.equal(report.known, 'libcxxabi-exception-free');
	});

	it('takes the summary location past frames in the runtime and the C++ library headers', () => {
		const lookup = fake({
			[`${ENGINE}+0xc62f6`]: [symbol('free', '/llvm/compiler-rt/lib/asan/asan_malloc_linux.cpp', 52, 3)],
			[`${ENGINE}+0x200`]: [
				symbol('std::vector<int>::vector()', '/usr/include/c++/v1/vector', 511, 9),
				symbol('main', '/w/a.cpp', 14, 22),
			],
		});
		const input = mismatchReport(
			[raw(0, 'e1', ENGINE, 'c62f6'), raw(1, 'e2', ENGINE, '200')],
			[],
			`SUMMARY: AddressSanitizer: alloc-dealloc-mismatch (${ENGINE}+0xc62f6)${ID} `
		);
		const summary = symbolizeText(input, lookup)
			.split('\n')
			.find((line) => line.startsWith('SUMMARY:'));
		assert.equal(summary, 'SUMMARY: AddressSanitizer: alloc-dealloc-mismatch /w/a.cpp:14:22 in main');
	});

	it('leaves a symbolized report as it is, and a second run changes nothing', () => {
		assert.equal(symbolizeText(MISMATCH_SYMBOLIZED, MISMATCH_LOOKUP), MISMATCH_SYMBOLIZED);
		const once = symbolizeText(MISMATCH_RAW, MISMATCH_LOOKUP);
		assert.equal(symbolizeText(once, MISMATCH_LOOKUP), once);
	});
});

describe('sanitizer-symbolize main', () => {
	let tmp;
	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sanitizer-symbolize-'));
	});
	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	/** Run main() on a directory and capture its exit code and output. */
	async function run(args, env) {
		const out = [];
		const err = [];
		const code = await main(args, {
			env,
			stdout: { write: (chunk) => out.push(chunk) },
			stderr: { write: (chunk) => err.push(chunk) },
		});
		return { code, stdout: out.join(''), stderr: err.join('') };
	}

	it('exits 2 without a directory or with one that does not exist', async () => {
		assert.equal((await run([], {})).code, 2);
		assert.equal((await run([path.join(tmp, 'missing')], {})).code, 2);
	});

	it('leaves the frames of a module that is not on disk, with a note', async () => {
		const file = path.join(tmp, 'report.1');
		const input = text(raw(0, 'a1', '/no/such/dir/engine', '10'));
		await fs.writeFile(file, input);
		const result = await run([tmp], { ASAN_SYMBOLIZER_PATH: path.join(tmp, 'no-symbolizer') });
		assert.equal(result.code, 0);
		assert.match(result.stdout, /^note: \/no\/such\/dir\/engine is not on disk; its 1 offset\(s\) stay unsymbolized/);
		assert.equal(await fs.readFile(file, 'utf8'), input);
	});

	it('exits 2 and changes nothing when the symbolizer does not start', async () => {
		const file = path.join(tmp, 'report.1');
		// Any file on disk serves as the module; the symbolizer fails before reading it
		const input = text(raw(0, 'a1', fileURLToPath(import.meta.url), '10'));
		await fs.writeFile(file, input);
		const env = { ASAN_SYMBOLIZER_PATH: path.join(tmp, 'no-symbolizer'), GITHUB_ACTIONS: 'true' };
		const result = await run([tmp], env);
		assert.equal(result.code, 2);
		assert.match(result.stderr, /^::error::cannot start the symbolizer .*no-symbolizer/);
		assert.equal(await fs.readFile(file, 'utf8'), input);
	});
});
