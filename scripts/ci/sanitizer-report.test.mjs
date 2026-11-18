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
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { groupReports, main, normalize, parseLog, renderSummary } from './sanitizer-report.mjs';

const SCRIPT = fileURLToPath(new URL('./sanitizer-report.mjs', import.meta.url));
const ROOT = '/home/u/src/rocketride-server';
const ENGTEST = '/home/u/src/asan-root/dist/server/engtest';
const RUNTIME = '/build/llvm-toolchain-18-x/compiler-rt/lib/asan';
const FACTORY = `${ROOT}/packages/server/engine-core/apLib/../apLib/factory/Factory.hpp:84:16`;
const SEPARATOR = '='.repeat(65);

const text = (...lines) => `${lines.join('\n')}\n`;
const binary = (name) => `${ROOT}/dist/server/${name}`;

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

// The shapes of a real CI-like run: one heap-use-after-free in the shared test
// main, reported by engtest and nodetest, each through two Catch2 frames that
// have no line tables. Our first frame, testMain.ipp, is the same in all four.
const COMMON = '/llvm/compiler-rt/lib/sanitizer_common';
const MEMMOVE = `memmove ${COMMON}/sanitizer_common_interceptors_memintrinsics.inc:98:3`;
const STRLEN = `strlen /llvm/compiler-rt/lib/asan/../sanitizer_common/sanitizer_common_interceptors.inc:391:5`;
const CLARA_PARSE = 'Catch::Clara::Detail::ParserBase::parse(Catch::Clara::Args const&) const';
const STRING_REF = 'Catch::StringRef::StringRef(char const*)';
const TEST_MAIN_FUNCTION = 'ap::application::TestMain(std::__1::vector<char const*, std::__1::allocator<char const*>>)';
const TEST_MAIN = `packages/server/engine-lib/test/testMain.ipp:230:36 in ${TEST_MAIN_FUNCTION}`;
const PROGRAMS = {
	engtest: 'packages/server/engine-lib/test/.',
	nodetest: 'packages/server/engine-mod/test/../../engine-lib/test',
};

const catchUseAfterFree = (program, interceptor, catchFrame) =>
	text(
		SEPARATOR,
		'==28874==ERROR: AddressSanitizer: heap-use-after-free on address 0x50600014a200 ' +
			'at pc 0x61e0528e6b8c bp 0x7ffca220d0e0 sp 0x7ffca220c898',
		'READ of size 3 at 0x50600014a200 thread T0',
		`    #0 0x61e0528e6b8b in ${interceptor}`,
		`    #1 0x61e05456accc in ${catchFrame} (${binary(program)}+0x270accd) (BuildId: 888c834a)`,
		'    #2 0x61e054561031 in Catch::Session::applyCommandLine(int, char const* const*) ' +
			`(${binary(program)}+0x2701032) (BuildId: 888c834a)`,
		'    #3 0x61e052f04a2e in int Catch::Session::run<char>(int, char const* const*) ' +
			`${ROOT}/build/vcpkg_installed/x64-linux-clang-rocketride/include/catch2/catch_session.hpp:47:30`,
		`    #4 0x61e052f04a2e in ${TEST_MAIN_FUNCTION} ${ROOT}/${PROGRAMS[program]}/testMain.ipp:230:36`,
		'',
		'freed by thread T0 here:',
		`    #0 0x61e052925c4d in operator delete(void*) ${RUNTIME}/asan_new_delete.cpp:143:3`,
		`    #1 0x61e052efd510 in ${TEST_MAIN_FUNCTION} ${ROOT}/${PROGRAMS[program]}/testMain.ipp:224:9`,
		'',
		`SUMMARY: AddressSanitizer: heap-use-after-free (${binary(program)}+0x270accd) (BuildId: 888c834a) ` +
			`in ${catchFrame}`
	);

const PMR = `${ROOT}/packages/server/engine-core/apLib/memory/pmr.hpp:173:13`;
const RELEASE_BUFFERS = 'ap::memory::constant_mbr::_M_release_buffers()';
const pmrMismatch = (withSummary) =>
	text(
		SEPARATOR,
		'==28875==ERROR: AddressSanitizer: alloc-dealloc-mismatch (operator new [] vs operator delete) ' +
			'on 0x799714aee800',
		'    #0 0x63d94ac4ae6d in operator delete(void*) /llvm/compiler-rt/lib/asan/asan_new_delete.cpp:143:3',
		`    #1 0x79977ed30d3a in ${RELEASE_BUFFERS} ${PMR}`,
		...(withSummary ? ['', `SUMMARY: AddressSanitizer: alloc-dealloc-mismatch ${PMR} in ${RELEASE_BUFFERS}`] : [])
	);

const NO_RETURN_WARNING = (size) =>
	`==123==WARNING: ASan is ignoring requested __asan_handle_no_return: stack type: default top: 0x7ffd5d5e2000; ` +
	`bottom 0x7f0b4c3fe000; size: 0x00f1115e4000 (${size})`;

/** Run main() on a directory and capture its exit code, summary and output. */
async function run(dir, summaryPath, env = { GITHUB_STEP_SUMMARY: summaryPath, GITHUB_WORKSPACE: ROOT }) {
	const out = [];
	const err = [];
	const code = await main(dir === undefined ? [] : [dir], {
		env,
		stdout: { write: (chunk) => out.push(chunk) },
		stderr: { write: (chunk) => err.push(chunk) },
	});
	const summary = await fs.readFile(summaryPath, 'utf8').catch(() => '');
	return { code, summary, stdout: out.join(''), stderr: err.join('') };
}

/** Start the script in its own Node process, outside any job summary. */
function runScript(script, dir) {
	const env = { ...process.env };
	delete env.GITHUB_STEP_SUMMARY;
	delete env.GITHUB_WORKSPACE;
	return spawnSync(process.execPath, [script, dir], { env, encoding: 'utf8' });
}

describe('sanitizer report parsing', () => {
	it('reads an ASan report and drops the volatile parts of its summary', () => {
		const log = asanScope(62622, '0x22cdd01', 'dab093bc8b68eacf42d02ad36e3f99c382162721');
		const [report] = parseLog(log, 'asan.62622');
		assert.equal(report.sanitizer, 'AddressSanitizer');
		assert.equal(report.kind, 'stack-use-after-scope');
		assert.equal(report.location, 'in Catch::StringRef::StringRef(char const*)');
		assert.match(report.lines[0], /^==62622==ERROR: AddressSanitizer: stack-use-after-scope/);
	});

	it('locates a report whose summary points into the sanitizer runtime at the calling frame', () => {
		const [report] = parseLog(ASAN_MISMATCH, 'asan.65286', ROOT);
		assert.equal(report.kind, 'alloc-dealloc-mismatch');
		const caller = 'packages/server/engine-core/apLib/memory/Buffer.hpp:57:3 in ap::Buffer::~Buffer()';
		assert.equal(report.location, caller);
	});

	it('reads a UBSan runtime error with its summary', () => {
		const [report] = parseLog(UBSAN_FUNCTION, 'ub.111916', ROOT);
		assert.equal(report.sanitizer, 'UndefinedBehaviorSanitizer');
		assert.equal(report.kind, 'function-type-mismatch');
		assert.equal(report.location, 'packages/server/engine-core/apLib/factory/Factory.hpp:84:16');
	});

	it('takes the location of a UBSan error without a summary from its first line', () => {
		const [report] = parseLog(text(`${FACTORY}: runtime error: load of misaligned address 0x1234`), 'ub.1', ROOT);
		assert.equal(report.kind, 'runtime-error');
		assert.equal(report.location, 'packages/server/engine-core/apLib/factory/Factory.hpp:84:16');
	});

	it('locates a leak at its allocating frame', () => {
		const [report] = parseLog(LEAK, 'asan.4242');
		assert.equal(report.sanitizer, 'LeakSanitizer');
		assert.equal(report.kind, 'memory-leak');
		assert.equal(report.location, '/src/leak.cpp:4:10 in leak()');
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

	it('removes ./ and dir/../ from paths, but not a leading ../', () => {
		assert.equal(normalize(`${ROOT}/a/b/../../c/././d.cpp:1`, ROOT), 'c/d.cpp:1');
		assert.equal(normalize('in f() ../x/../y.cpp:2 (a/../b.so)'), 'in f() ../y.cpp:2 (b.so)');
	});
});

describe('sanitizer report location', () => {
	it('groups one defect reached through third-party frames in two programs at our first frame', () => {
		for (const root of [ROOT, '']) {
			const reports = Object.keys(PROGRAMS).flatMap((program) =>
				parseLog(
					catchUseAfterFree(program, MEMMOVE, CLARA_PARSE) + catchUseAfterFree(program, STRLEN, STRING_REF),
					`ub.${program}`,
					root
				)
			);
			const groups = groupReports(reports);
			assert.equal(groups.length, 1, `root '${root}'`);
			assert.equal(groups[0].count, 4);
			assert.equal(groups[0].files.size, 2);
			assert.equal(groups[0].kind, 'heap-use-after-free');
			assert.equal(groups[0].location, root ? TEST_MAIN : `${ROOT}/${TEST_MAIN}`);
		}
	});

	it('keeps a summary that points into our code, and finds the same place without a summary', () => {
		const reports = [...parseLog(pmrMismatch(true), 'ub.1', ROOT), ...parseLog(pmrMismatch(false), 'ub.2', ROOT)];
		const groups = groupReports(reports);
		assert.equal(groups.length, 1);
		assert.equal(groups[0].count, 2);
		assert.equal(
			groups[0].location,
			'packages/server/engine-core/apLib/memory/pmr.hpp:173:13 in ap::memory::constant_mbr::_M_release_buffers()'
		);
	});

	it('without a frame in our code, takes the first frame outside the runtime, not the program name', () => {
		const onlyCatch = (program) =>
			text(
				'==1==ERROR: AddressSanitizer: heap-use-after-free on address 0x1 at pc 0x2 bp 0x3 sp 0x4',
				`    #0 0x1 in ${MEMMOVE}`,
				`    #1 0x2 in ${CLARA_PARSE} (${binary(program)}+0x270accd) (BuildId: 888c834a)`,
				`    #2 0x3 in main (${binary(program)}+0x1000)`
			);
		const groups = groupReports(
			Object.keys(PROGRAMS).flatMap((program) => parseLog(onlyCatch(program), `ub.${program}`, ROOT))
		);
		assert.equal(groups.length, 1);
		assert.equal(groups[0].location, `in ${CLARA_PARSE}`);
	});

	it('never locates a report at an allocator or interceptor frame without a runtime path', () => {
		const names = [
			'malloc',
			'calloc',
			'realloc',
			'free',
			'operator new(unsigned long)',
			'operator new[](unsigned long, std::align_val_t)',
			'operator delete(void*)',
			'operator delete[](void*, unsigned long)',
			'memmove',
			'memcpy',
			'memset',
			'strlen',
		];
		for (const name of names) {
			const log = text(
				'==5==ERROR: AddressSanitizer: alloc-dealloc-mismatch (operator new [] vs operator delete) on 0x1',
				`    #0 0x1 in ${name} (${binary('engine')}+0x10) (BuildId: 77)`,
				'    #1 0x2 in third::Pool::release() (/usr/lib/libthird.so+0x20)',
				'',
				`SUMMARY: AddressSanitizer: alloc-dealloc-mismatch (${binary('engine')}+0x10) (BuildId: 77) in ${name}`
			);
			assert.equal(parseLog(log, 'ub.5', ROOT)[0].location, 'in third::Pool::release()', name);
		}
	});

	it('does not take a function in a namespace that is named like an allocator for a runtime frame', () => {
		const log = text(
			'==5==ERROR: AddressSanitizer: heap-use-after-free on address 0x1 at pc 0x2 bp 0x3 sp 0x4',
			'    #0 0x1 in ap::memory::free(void*) (/usr/lib/libap.so+0x10)',
			'    #1 0x2 in third::caller() (/usr/lib/libthird.so+0x20)'
		);
		assert.equal(parseLog(log, 'ub.5', ROOT)[0].location, 'in ap::memory::free(void*)');
	});
});

describe('sanitizer warnings', () => {
	it('reads a file of sanitizer warnings as one warning report per warning', () => {
		const log = text(
			NO_RETURN_WARNING(1036518211584),
			'False positive error reports may follow',
			'For details see https://github.com/google/sanitizers/issues/189',
			'==123==WARNING: Symbolizer buffer too small'
		);
		const reports = parseLog(log, 'ub.123');
		assert.deepEqual(
			reports.map((report) => [report.kind, report.lines.length]),
			[
				['warning', 3],
				['warning', 1],
			]
		);
		assert.equal(reports[1].location, 'Symbolizer buffer too small');
	});

	it('groups the same warning from two processes', () => {
		const reports = [
			...parseLog(text(NO_RETURN_WARNING(1036518211584)), 'ub.1'),
			...parseLog(text(NO_RETURN_WARNING(17179869184)), 'ub.2'),
		];
		const groups = groupReports(reports);
		assert.equal(groups.length, 1);
		assert.match(groups[0].location, /^ASan is ignoring requested __asan_handle_no_return: .*\(<n>\)$/);
	});

	it('counts warnings mixed with other sanitizer output as other output', () => {
		const log = text('==9==WARNING: Symbolizer buffer too small', '==9==AddressSanitizer CHECK failed: x.cpp:1');
		assert.deepEqual(
			parseLog(log, 'ub.9').map((report) => report.kind),
			['other-output']
		);
		const before = text('AddressSanitizer:DEADLYSIGNAL', '==9==WARNING: Symbolizer buffer too small');
		assert.equal(parseLog(before, 'ub.9')[0].kind, 'other-output');
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

	it('exits 2 with the usage when no directory is given', async () => {
		const result = await run(undefined, summaryPath);
		assert.equal(result.code, 2);
		assert.match(result.stderr, /^Usage: node scripts\/ci\/sanitizer-report\.mjs <log dir>/);
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
		assert.match(
			result.stderr,
			/^::error::3 sanitizer report\(s\) in 2 group\(s\): see the job summary; the sanitizer-reports artifact/
		);
		assert.match(result.stdout, /^2\tAddressSanitizer\tstack-use-after-scope\tin Catch::StringRef/m);
	});

	it('writes the summary to stdout when there is no job summary', async () => {
		await fs.writeFile(path.join(dir, 'ub.300'), UBSAN_FUNCTION);
		const result = await run(dir, summaryPath, { GITHUB_WORKSPACE: ROOT });
		assert.equal(result.code, 1);
		assert.equal(result.summary, '');
		assert.match(result.stdout, /^## Sanitizer reports\n/);
		assert.match(result.stdout, /\| 1 \| 1 \| UndefinedBehaviorSanitizer \| `function-type-mismatch` \|/);
		assert.equal(result.stderr, `1 sanitizer report(s) in 1 group(s) in ${dir}.\n`);
	});

	it('says which reports are warnings, and still fails on them', async () => {
		await fs.writeFile(path.join(dir, 'ub.123'), text(NO_RETURN_WARNING(1)));
		const result = await run(dir, summaryPath);
		assert.equal(result.code, 1);
		assert.match(result.summary, /1 report\(s\) are sanitizer warnings \(kind `warning`\), not errors/);
		assert.match(result.summary, /\| 1 \| 1 \| unknown \| `warning` \| `ASan is ignoring requested/);
		assert.match(result.stderr, /^::error::1 sanitizer report\(s\) \(1 warning\(s\)\) in 1 group\(s\)/);
	});

	it('fails when started as a script', async () => {
		await fs.writeFile(path.join(dir, 'ub.300'), UBSAN_FUNCTION);
		const result = runScript(SCRIPT, dir);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stdout, /^## Sanitizer reports\n/);
	});

	it('fails when started through a symlink or junction', async (t) => {
		await fs.writeFile(path.join(dir, 'ub.300'), UBSAN_FUNCTION);
		// The link points to a copy in the temp folder, so removing that folder never reaches the checkout
		const copy = path.join(path.dirname(dir), 'copy');
		await fs.mkdir(copy);
		await fs.copyFile(SCRIPT, path.join(copy, 'sanitizer-report.mjs'));
		const link = path.join(path.dirname(dir), 'link');
		try {
			await fs.symlink(copy, link, 'junction');
		} catch (error) {
			t.skip(`this system refused to create a directory link (${error.code})`);
			return;
		}
		const result = runScript(path.join(link, 'sanitizer-report.mjs'), dir);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stdout, /^## Sanitizer reports\n/);
	});

	it('stays under the size limit and says what it left out', () => {
		const reports = Array.from({ length: 200 }, (_, index) =>
			parseLog(text(`/src/f${index}.cpp:1:1: runtime error: x`), `ub.${index}`)
		).flat();
		const markdown = renderSummary(groupReports(reports), { limit: 4096 });
		assert.ok(Buffer.byteLength(markdown) <= 4096);
		assert.match(markdown, /group\(s\) left out of the table/);
	});

	it('keeps every row and leaves out the examples that do not fit', () => {
		const long = 'y'.repeat(290);
		const reports = Array.from({ length: 3 }, (_, index) =>
			parseLog(text(`/src/f${index}.cpp:1:1: runtime error: x`, ...Array(11).fill(long)), `ub.${index}`)
		).flat();
		const markdown = renderSummary(groupReports(reports), { limit: 6000 });
		assert.ok(Buffer.byteLength(markdown) <= 6000);
		assert.match(markdown, /\| 3 \| 1 \| UndefinedBehaviorSanitizer \|/);
		assert.match(markdown, /_2 example\(s\) left out to stay under the summary size limit;/);
		assert.doesNotMatch(markdown, /left out of the table/);
	});

	it('escapes Markdown and HTML in the table, the example title and the code fence', () => {
		const log = text(
			'/src/a|b`c.cpp:1:1: runtime error: x',
			'   in ```quoted``` text',
			'',
			'SUMMARY: UndefinedBehaviorSanitizer: odd<kind>&x /src/a|b`c.cpp:1:1'
		);
		const markdown = renderSummary(groupReports(parseLog(log, 'ub<1>')));
		assert.match(markdown, /\| `odd<kind>&x` \| `\/src\/a\\\|b'c\.cpp:1:1` \| 1 \| `ub<1>` \|/);
		assert.match(markdown, /<summary>#1 odd&lt;kind&gt;&amp;x: 1 report\(s\), example ub&lt;1&gt;<\/summary>/);
		assert.match(markdown, /^````text\n\/src\/a\|b`c\.cpp:1:1: runtime error: x\n {3}in ```quoted``` text\n\nSUMMARY: /m);
		assert.match(markdown, /a\|b`c\.cpp:1:1\n````\n/);
	});
});
