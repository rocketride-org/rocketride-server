// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Tests for the sanitizer report summary.
 *
 * Run:
 *     node --test scripts/ci/sanitizer-report.test.mjs
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { groupReports, main, normalize, parseLog, renderSummary } from './sanitizer-report.mjs';

const ROOT = '/home/u/src/rocketride-server';
const ENGTEST = '/home/u/src/asan-root/dist/server/engtest';
const RUNTIME = '/build/llvm-toolchain-18-x/compiler-rt/lib/asan';
const FACTORY = `${ROOT}/packages/server/engine-core/apLib/../apLib/factory/Factory.hpp:84:16`;
const SEPARATOR = '='.repeat(65);

const text = (...lines) => `${lines.join('\n')}\n`;

/** An unsymbolized ASan report as engtest writes it; pid, offset and build id vary between builds. */
const asanScope = (pid, offset, buildId) =>
	text(
		SEPARATOR,
		`==${pid}==ERROR: AddressSanitizer: stack-use-after-scope on address 0x7825b4b4c6a1 ` +
			'at pc 0x619d87c229fb bp 0x7ffe4b5b09e0 sp 0x7ffe4b5b01a8',
		'READ of size 1 at 0x7825b4b4c6a1 thread T0',
		`    #0 0x619d87c229fa  (${ENGTEST}+${offset}) (BuildId: ${buildId})`,
		`    #1 0x619d87c21000 in main (${ENGTEST}+0x22cc000) (BuildId: ${buildId})`,
		'',
		'Address 0x7825b4b4c6a1 is located in stack of thread T0 at offset 161 in frame',
		`SUMMARY: AddressSanitizer: stack-use-after-scope (${ENGTEST}+${offset}) (BuildId: ${buildId}) ` +
			'in Catch::StringRef::StringRef(char const*)',
		'Shadow bytes around the buggy address:',
		'  0x7825b4b4c400: f1 f1 f1 f1 00 00 f2 f2'
	);

const ASAN_MISMATCH = text(
	SEPARATOR,
	'==65286==ERROR: AddressSanitizer: alloc-dealloc-mismatch (operator new [] vs operator delete) on 0x799714aee800',
	`    #0 0x5f0c1b2d3e4f in operator delete(void*) ${RUNTIME}/asan_new_delete.cpp:143:3`,
	`    #1 0x5f0c1b2d4000 in ap::Buffer::~Buffer() ${ROOT}/packages/server/engine-core/apLib/memory/Buffer.hpp:57:3`,
	`    #2 0x5f0c1b2d5000 in main ${ROOT}/packages/server/engine-core/test/main.cpp:10:3`,
	'',
	`SUMMARY: AddressSanitizer: alloc-dealloc-mismatch ${RUNTIME}/asan_new_delete.cpp:143:3 in operator delete(void*)`
);

const UBSAN_FUNCTION = text(
	`${FACTORY}: runtime error: call to function ap::file::make() ` +
		"through pointer to incorrect function type 'void *(*)()'",
	`${ROOT}/packages/server/engine-core/apLib/file/File.cpp:12: note: ap::file::make() defined here`,
	`    #0 0x55d0c0ffee00 in ap::Factory::make() ${FACTORY}`,
	`    #1 0x55d0c0ffef00 in main ${ROOT}/packages/server/engine-core/test/main.cpp:10:3`,
	'',
	`SUMMARY: UndefinedBehaviorSanitizer: function-type-mismatch ${FACTORY} `
);

const LEAK = text(
	SEPARATOR,
	'==4242==ERROR: LeakSanitizer: detected memory leaks',
	'',
	'Direct leak of 7 byte(s) in 1 object(s) allocated from:',
	`    #0 0x4af01b in __interceptor_malloc ${RUNTIME}/asan_malloc_linux.cpp:69:3`,
	'    #1 0x4f2e0a in leak() /src/leak.cpp:4:10',
	'',
	'SUMMARY: AddressSanitizer: 7 byte(s) leaked in 1 allocation(s).'
);

/** Run main() on a directory and capture its exit code, summary and output. */
async function run(dir, summaryPath) {
	const out = [];
	const err = [];
	const code = await main([dir], {
		env: { GITHUB_STEP_SUMMARY: summaryPath, GITHUB_WORKSPACE: ROOT },
		stdout: { write: (chunk) => out.push(chunk) },
		stderr: { write: (chunk) => err.push(chunk) },
	});
	const summary = await fs.readFile(summaryPath, 'utf8').catch(() => '');
	return { code, summary, stdout: out.join(''), stderr: err.join('') };
}

describe('sanitizer report parsing', () => {
	it('reads an ASan report and drops the volatile parts of its summary', () => {
		const log = asanScope(62622, '0x22cdd01', 'dab093bc8b68eacf42d02ad36e3f99c382162721');
		const [report] = parseLog(log, 'asan.62622');
		assert.equal(report.sanitizer, 'AddressSanitizer');
		assert.equal(report.kind, 'stack-use-after-scope');
		assert.equal(report.location, `(${ENGTEST}) in Catch::StringRef::StringRef(char const*)`);
		assert.match(report.lines[0], /^==62622==ERROR: AddressSanitizer: stack-use-after-scope/);
	});

	it('locates a report whose summary points into the sanitizer runtime at the calling frame', () => {
		const [report] = parseLog(ASAN_MISMATCH, 'asan.65286', ROOT);
		assert.equal(report.kind, 'alloc-dealloc-mismatch');
		const caller = 'in ap::Buffer::~Buffer() packages/server/engine-core/apLib/memory/Buffer.hpp:57:3';
		assert.equal(report.location, caller);
	});

	it('reads a UBSan runtime error with its summary', () => {
		const [report] = parseLog(UBSAN_FUNCTION, 'ub.111916', ROOT);
		assert.equal(report.sanitizer, 'UndefinedBehaviorSanitizer');
		assert.equal(report.kind, 'function-type-mismatch');
		assert.equal(report.location, 'packages/server/engine-core/apLib/../apLib/factory/Factory.hpp:84:16');
	});

	it('takes the location of a UBSan error without a summary from its first line', () => {
		const [report] = parseLog(text(`${FACTORY}: runtime error: load of misaligned address 0x1234`), 'ub.1', ROOT);
		assert.equal(report.kind, 'runtime-error');
		assert.equal(report.location, 'packages/server/engine-core/apLib/../apLib/factory/Factory.hpp:84:16');
	});

	it('locates a leak at its allocating frame', () => {
		const [report] = parseLog(LEAK, 'asan.4242');
		assert.equal(report.sanitizer, 'LeakSanitizer');
		assert.equal(report.kind, 'memory-leak');
		assert.equal(report.location, 'in leak() /src/leak.cpp:4:10');
	});

	it('splits a file that holds several reports', () => {
		const reports = parseLog(asanScope(7, '0x1', 'ab') + ASAN_MISMATCH + UBSAN_FUNCTION, 'ub.7', ROOT);
		assert.deepEqual(
			reports.map((report) => report.kind),
			['stack-use-after-scope', 'alloc-dealloc-mismatch', 'function-type-mismatch']
		);
	});

	it('counts output without a recognizable report as one report', () => {
		const log = text('==77==AddressSanitizer CHECK failed: asan_allocator.cpp:190 (0x0, 0x3)');
		const reports = parseLog(log, 'asan.77');
		assert.equal(reports.length, 1);
		assert.equal(reports[0].kind, 'other-output');
		assert.equal(reports[0].location, 'AddressSanitizer CHECK failed: asan_allocator.cpp:190 (<addr>, <addr>)');
	});

	it('finds nothing in an empty file', () => {
		assert.deepEqual(parseLog('\n', 'asan.1'), []);
	});

	it('strips only the checkout root followed by a slash', () => {
		assert.equal(normalize(`${ROOT}/a.cpp:1 ${ROOT}-other/b.cpp`, `${ROOT}/`), `a.cpp:1 ${ROOT}-other/b.cpp`);
	});
});

describe('sanitizer report summary', () => {
	let dir;
	let summaryPath;

	beforeEach(async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sanitizer-report-'));
		dir = path.join(tmp, 'logs');
		summaryPath = path.join(tmp, 'summary.md');
		await fs.mkdir(dir);
	});

	afterEach(async () => {
		await fs.rm(path.dirname(dir), { recursive: true, force: true });
	});

	it('passes on an empty directory', async () => {
		const result = await run(dir, summaryPath);
		assert.equal(result.code, 0);
		assert.match(result.summary, /No sanitizer reports\./);
	});

	it('exits 2 when the directory does not exist', async () => {
		const result = await run(path.join(dir, 'missing'), summaryPath);
		assert.equal(result.code, 2);
		assert.match(result.stderr, /not found/);
	});

	it('groups equal reports from two files and fails', async () => {
		await fs.writeFile(path.join(dir, 'asan.100'), asanScope(100, '0x22cdd01', 'aa11'));
		await fs.writeFile(path.join(dir, 'asan.200'), asanScope(200, '0x33cdd01', 'bb22'));
		await fs.writeFile(path.join(dir, 'ub.300'), UBSAN_FUNCTION);
		const result = await run(dir, summaryPath);
		assert.equal(result.code, 1);
		assert.match(result.summary, /3 report\(s\) in 2 group\(s\), from 3 file\(s\)/);
		assert.match(result.summary, /\| 1 \| 2 \| AddressSanitizer \| `stack-use-after-scope` \|.*\| 2 \| `asan\.100` \|/);
		assert.match(result.summary, /\| 2 \| 1 \| UndefinedBehaviorSanitizer \| `function-type-mismatch` \|/);
		assert.match(result.summary, /<summary>#1 stack-use-after-scope: 2 report\(s\), example asan\.100<\/summary>/);
		assert.match(result.stderr, /3 sanitizer report\(s\) in 2 group\(s\)/);
	});

	it('stays under the size limit and says what it left out', () => {
		const reports = Array.from({ length: 200 }, (_, index) =>
			parseLog(text(`/src/f${index}.cpp:1:1: runtime error: x`), `ub.${index}`)
		).flat();
		const markdown = renderSummary(groupReports(reports), { limit: 4096 });
		assert.ok(Buffer.byteLength(markdown) <= 4096);
		assert.match(markdown, /group\(s\) left out of the table/);
	});
});
