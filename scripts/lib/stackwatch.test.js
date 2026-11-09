/**
 * Tests for the frozen-child watcher (stackwatch.js).
 *
 * Run:
 *     node --test scripts/lib/stackwatch.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
	parseDump,
	parseStackFile,
	checkFrozen,
	checkSilent,
	parseTime,
	findCdb,
	parseElapsed,
	lockWait,
	longLockWait,
	parseLockHolders,
	selectHolderTargets,
	claimFile,
	lockHoldersScript,
	startStackWatch,
} = require('./stackwatch');

const WIN = 'D:\\a\\rocketride-server\\rocketride-server';
const NODE_PY = `${WIN}\\packages\\ai\\src\\ai\\node.py`;
const TASK_FILE = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\task-1.json';
const HEADER = `pid=9280 started=2026-11-06T18:31:51+0000 interval=30s\nargv=${NODE_PY} ${TASK_FILE} --data_port=1\n`;
// Makes findCdb succeed: the override names a file that exists.
const WITH_CDB = { env: { ROCKETRIDE_TEST_CDB: __filename } };

const frame = (file, line, func) => `  File "${file}", line ${line} in ${func}\n`;
const LOOP_THREAD =
	'Thread 0x0000200c (most recent call first):\n' +
	frame(`${WIN}\\dist\\server\\Lib\\asyncio\\windows_events.py`, 774, '_poll') +
	frame(`${NODE_PY}`, 65, 'run_loop') +
	'\n';

// The main thread of a child frozen in "import numpy": the C call create_module is on top.
const FROZEN_MAIN =
	'Thread 0x0000243c (most recent call first):\n' +
	frame('<frozen importlib._bootstrap>', 488, '_call_with_frames_removed') +
	frame('<frozen importlib._bootstrap_external>', 1293, 'create_module') +
	frame(`${WIN}\\packages\\ai\\src\\ai\\common\\models\\__init__.py`, 25, '<module>') +
	frame(NODE_PY, 453, 'run') +
	frame(NODE_PY, 484, '<module>');

// The main thread of a ready child: blocked in processArguments, called from run().
const IDLE_MAIN =
	'Thread 0x00002464 (most recent call first):\n' + frame(NODE_PY, 465, 'run') + frame(NODE_PY, 484, '<module>');

// The main thread of a child that waits for the shared install.lock.
const lockWaitMain = (file) =>
	'Thread 0x00002464 (most recent call first):\n' +
	frame(file, 276, '__enter__') +
	frame(NODE_PY, 453, 'run') +
	frame(NODE_PY, 484, '<module>');
const DEPENDS_WIN = `${WIN}\\dist\\server\\Lib\\depends.py`;
const DEPENDS_POSIX = '/a/rocketride-server/dist/server/Lib/depends.py';

const dump = (main, secs = '0:00:30') => `Timeout (${secs})!\n${LOOP_THREAD}${main}\n`;

test('parses the header and the dump blocks', () => {
	const parsed = parseStackFile(HEADER + dump(FROZEN_MAIN) + dump(FROZEN_MAIN, '0:01:00'));
	assert.strictEqual(parsed.pid, 9280);
	assert.strictEqual(parsed.started, '2026-11-06T18:31:51+0000');
	assert.strictEqual(parsed.interval, 30);
	assert.ok(parsed.argv.endsWith('--data_port=1'));
	assert.strictEqual(parsed.dumps.length, 2);
	assert.deepStrictEqual(parsed.dumps[0].frames[0], {
		file: '<frozen importlib._bootstrap>',
		line: 488,
		func: '_call_with_frames_removed',
	});
	assert.strictEqual(parsed.dumps[0].frames.at(-1).func, '<module>');
});

test('the main thread is found whether it is a plain or the current thread, with CRLF too', () => {
	const current = FROZEN_MAIN.replace('Thread 0x0000243c', 'Current thread 0x0000243c');
	assert.ok(parseDump(`${LOOP_THREAD}${current}`.split('\n')).complete);
	const crlf = parseStackFile((HEADER + dump(FROZEN_MAIN)).replace(/\n/g, '\r\n'));
	assert.ok(crlf.dumps[0].complete);
	assert.strictEqual(crlf.pid, 9280);
});

test('POSIX paths are accepted for node.py', () => {
	const posix = FROZEN_MAIN.replaceAll('\\', '/').replaceAll('D:/a', '/a');
	const parsed = parseStackFile(HEADER + dump(posix) + dump(posix));
	assert.ok(parsed.dumps[0].complete);
	assert.ok(checkFrozen(parsed).frozen);
});

test('an empty file, a header only and a file without a header give no dumps', () => {
	assert.deepStrictEqual(parseStackFile(''), { pid: null, started: null, interval: null, argv: null, dumps: [] });
	const headerOnly = parseStackFile(HEADER);
	assert.strictEqual(headerOnly.pid, 9280);
	assert.deepStrictEqual(headerOnly.dumps, []);
	assert.strictEqual(parseStackFile(dump(FROZEN_MAIN)).pid, null);
	for (const text of ['', HEADER]) assert.strictEqual(checkFrozen(parseStackFile(text)).frozen, false);
});

test('one complete dump is not enough', () => {
	assert.strictEqual(checkFrozen(parseStackFile(HEADER + dump(FROZEN_MAIN))).frozen, false);
});

test('a truncated last dump is skipped, in every place it can be cut', () => {
	const full = dump(FROZEN_MAIN, '0:01:00');
	// Cut inside the main thread, inside its header, and before the main thread.
	const mainAt = full.indexOf('Thread 0x0000243c');
	for (const cut of [full.length - 40, mainAt + 10, mainAt - 1, 'Timeout (0:01:00)!\n'.length]) {
		const parsed = parseStackFile(HEADER + dump(FROZEN_MAIN) + full.slice(0, cut));
		assert.strictEqual(parsed.dumps.at(-1).complete, false, `cut at ${cut}`);
		assert.strictEqual(checkFrozen(parsed).frozen, false, `cut at ${cut}`);
	}
	// With two complete dumps before the cut one, the verdict rests on those two.
	const three = HEADER + dump(FROZEN_MAIN) + dump(FROZEN_MAIN) + full.slice(0, full.length - 40);
	assert.strictEqual(checkFrozen(parseStackFile(three)).frozen, true);
});

test('a dump without a main thread is incomplete', () => {
	const parsed = parseStackFile(HEADER + `Timeout (0:00:30)!\n${LOOP_THREAD}`);
	assert.deepStrictEqual(parsed.dumps, [{ complete: false, frames: [], elapsed: 30 }]);
});

test('a healthy idle child is not frozen', () => {
	const parsed = parseStackFile(HEADER + dump(IDLE_MAIN) + dump(IDLE_MAIN, '0:01:00') + dump(IDLE_MAIN, '0:01:30'));
	assert.strictEqual(checkFrozen(parsed).frozen, false);
});

test('a child waiting for the install lock is not frozen, with Windows and POSIX paths', () => {
	for (const file of [DEPENDS_WIN, DEPENDS_POSIX]) {
		const wait = lockWaitMain(file);
		assert.strictEqual(checkFrozen(parseStackFile(HEADER + dump(wait) + dump(wait))).frozen, false, file);
	}
	// Another function in depends.py, and __enter__ in another file, still count.
	const other = lockWaitMain(DEPENDS_WIN).replace('__enter__', 'install');
	assert.ok(checkFrozen(parseStackFile(HEADER + dump(other) + dump(other))).frozen);
	const elsewhere = lockWaitMain(`${WIN}\\Lib\\other.py`);
	assert.ok(checkFrozen(parseStackFile(HEADER + dump(elsewhere) + dump(elsewhere))).frozen);
});

test('the silent limit is 2.5 intervals, from the header or the default, with the last complete dump', () => {
	const parsed = parseStackFile(HEADER + dump(FROZEN_MAIN) + dump(IDLE_MAIN));
	assert.strictEqual(checkSilent(parsed, 74_000).silent, false);
	const silent = checkSilent(parsed, 80_000);
	assert.strictEqual(silent.silent, true);
	assert.strictEqual(silent.seconds, 80);
	assert.strictEqual(silent.frames[0].func, 'run');
	const noInterval = parseStackFile(HEADER.replace(' interval=30s', ''));
	assert.strictEqual(checkSilent(noInterval, 74_000).silent, false);
	assert.deepStrictEqual(checkSilent(noInterval, 76_000), { silent: true, seconds: 76, frames: [] });
	assert.strictEqual(checkSilent(parseStackFile(HEADER.replace('30s', '60s')), 140_000).silent, false);
});

test('times are parsed with the header offset and with .NET fractions; a zone is required', () => {
	const utc = Date.parse('2026-11-06T18:31:51Z');
	assert.strictEqual(parseTime('2026-11-06T18:31:51+0000'), utc);
	assert.strictEqual(parseTime('2026-11-06T19:31:51+0100'), utc);
	assert.strictEqual(parseTime('2026-11-06T13:31:51-05:00'), utc);
	assert.strictEqual(parseTime('2026-11-06T18:31:51.1234567Z\r\n'), utc + 123);
	for (const bad of ['', null, 'NATIVE STACK', '2026-11-06T18:31:51']) assert.ok(Number.isNaN(parseTime(bad)), bad);
});

test('a changing stack is not frozen, whether the line, the function or the depth changes', () => {
	const moved = FROZEN_MAIN.replace('line 488', 'line 489');
	const renamed = FROZEN_MAIN.replace('create_module', 'exec_module');
	const extra = frame(`${WIN}\\x.py`, 1, 'f');
	const deeper = FROZEN_MAIN.replace(frame(NODE_PY, 453, 'run'), extra + frame(NODE_PY, 453, 'run'));
	for (const other of [moved, renamed, deeper, IDLE_MAIN]) {
		assert.strictEqual(checkFrozen(parseStackFile(HEADER + dump(FROZEN_MAIN) + dump(other))).frozen, false);
	}
});

test('a frozen stack is reported with its frames; only the last two dumps count', () => {
	const result = checkFrozen(parseStackFile(HEADER + dump(IDLE_MAIN) + dump(FROZEN_MAIN) + dump(FROZEN_MAIN)));
	assert.strictEqual(result.frozen, true);
	assert.strictEqual(result.frames[1].func, 'create_module');
	// The loop thread changing does not matter: only the main thread is compared.
	const loop = LOOP_THREAD.replace('774', '775');
	const other = HEADER + dump(FROZEN_MAIN) + `Timeout (0:01:00)!\n${loop}${FROZEN_MAIN}\n`;
	assert.strictEqual(checkFrozen(parseStackFile(other)).frozen, true);
});

test('cdb is searched at the Windows Kits paths and the override comes first', () => {
	const x86 = 'C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe';
	const x64 = 'C:\\Program Files\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe';
	assert.strictEqual(findCdb({}, (p) => p === x86), x86);
	assert.strictEqual(findCdb({}, (p) => p === x64), x64);
	assert.strictEqual(findCdb({}, () => false), null);
	assert.strictEqual(findCdb({ ROCKETRIDE_TEST_CDB: 'E:\\dbg\\cdb.exe' }, () => true), 'E:\\dbg\\cdb.exe');
});

test('the watcher is a no-op off Windows', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-stackwatch-test-'));
	const watch = startStackWatch(dir, { platform: 'linux' });
	await watch.scan();
	watch.stop();
	assert.deepStrictEqual(fs.readdirSync(dir), []);
});

/**
 * Start a watcher over a temp directory with a fake execFile.
 *
 * @param {object} files - File name to content
 * @param {object} opts - Extra startStackWatch options
 * @returns {{dir: string, calls: object[], watch: object}} The directory, the commands run and the watcher
 */
function makeWatch(files, opts = {}) {
	// The process start time the fake powershell reports; the header says 18:31:51 UTC.
	const { startTime = '2026-11-06T18:31:49.5000000Z', ...watchOpts } = opts;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-stackwatch-test-'));
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
	const calls = [];
	const exec = (file, args, options, cb) => {
		calls.push({ file, args });
		if (file === 'tasklist') cb(null, `"engine.exe","${args[1].split(' ').pop()}","Console","1","10,000 K"\n`, '');
		else if (file === 'powershell') cb(null, `${startTime}\r\n`, '');
		else cb(null, 'NATIVE STACK', '');
		return { kill() {} };
	};
	const watch = startStackWatch(dir, {
		platform: 'win32',
		...WITH_CDB,
		exec,
		alive: () => true,
		intervalMs: 3_600_000,
		...watchOpts,
	});
	return { dir, calls, watch };
}

test('scan captures a frozen live child once and writes native_<pid>.txt and the log', async () => {
	const frozen = HEADER + dump(FROZEN_MAIN) + dump(FROZEN_MAIN, '0:01:00');
	const idle = HEADER.replace('9280', '4336') + dump(IDLE_MAIN) + dump(IDLE_MAIN);
	const { dir, calls, watch } = makeWatch({ 'stacks_9280.txt': frozen, 'stacks_4336.txt': idle });
	await watch.scan();
	await watch.scan();
	watch.stop();
	const cdbCalls = calls.filter((c) => c.file === __filename);
	assert.strictEqual(cdbCalls.length, 1);
	assert.deepStrictEqual(cdbCalls[0].args.slice(0, 3), ['-pv', '-p', '9280']);
	assert.ok(calls.some((c) => c.file === 'powershell' && c.args.join(' ').includes('Get-Process -Id 9280')));
	assert.ok(cdbCalls[0].args[4].includes('rr-symcache') && cdbCalls[0].args[4].startsWith('srv*'));
	const native = fs.readFileSync(path.join(dir, 'native_9280.txt'), 'utf8');
	assert.match(native, /pid=9280/);
	assert.match(native, /create_module/);
	assert.match(native, /NATIVE STACK/);
	assert.match(native, /trigger: main thread unchanged/);
	assert.ok(!fs.existsSync(path.join(dir, 'native_4336.txt')));
	const log = fs.readFileSync(path.join(dir, 'stackwatch.log'), 'utf8').split('\n');
	assert.match(log[0], /started, cdb=/);
	assert.match(log[1], /captured native_9280\.txt pid=9280 exit=0/);
});

test('scan skips a dead child, a pid whose header differs and a pid that is not an engine', async () => {
	const frozen = HEADER + dump(FROZEN_MAIN) + dump(FROZEN_MAIN);
	const dead = makeWatch({ 'stacks_9280.txt': frozen }, { alive: () => false });
	await dead.watch.scan();
	const mismatch = makeWatch({ 'stacks_1111.txt': frozen });
	await mismatch.watch.scan();
	const notEngine = makeWatch({ 'stacks_9280.txt': frozen }, {
		exec: (file, args, options, cb) => {
			cb(null, 'INFO: No tasks are running which match the specified criteria.', '');
			return { kill() {} };
		},
	});
	await notEngine.watch.scan();
	for (const w of [dead, mismatch, notEngine]) {
		w.watch.stop();
		assert.ok(!fs.readdirSync(w.dir).some((n) => n.startsWith('native_')));
	}
});

/**
 * Age a file's mtime.
 *
 * @param {string} file - The file
 * @param {number} ageS - Seconds to go back from now
 */
function age(file, ageS) {
	const old = new Date(Date.now() - ageS * 1000);
	fs.utimesSync(file, old, old);
}

test('scan captures a silent file of a live matching process, even with fewer than two dumps', async () => {
	const cases = [
		[HEADER + dump(FROZEN_MAIN) + dump(IDLE_MAIN), 80, /no dump for 8\d s.*\n\s+\S+node\.py:465 run/s],
		[HEADER + dump(FROZEN_MAIN), 80, /no dump for 8\d s/],
		[HEADER, 80, /no dump for 8\d s; no complete dump/],
		[HEADER.replace(' interval=30s', ''), 80, /no dump for 8\d s/],
		[HEADER.replace('30s', '60s'), 170, /no dump for 17\d s/],
	];
	for (const [text, ageS, expected] of cases) {
		const { dir, watch } = makeWatch({ 'stacks_9280.txt': text });
		age(path.join(dir, 'stacks_9280.txt'), ageS);
		await watch.scan();
		watch.stop();
		assert.match(fs.readFileSync(path.join(dir, 'native_9280.txt'), 'utf8'), expected, text.split('\n')[0]);
	}
});

test('scan does not capture a file that is written in time with changing stacks', async () => {
	const cases = [
		[HEADER + dump(FROZEN_MAIN) + dump(IDLE_MAIN), 1],
		[HEADER + dump(FROZEN_MAIN), 70],
		[HEADER.replace('30s', '60s') + dump(FROZEN_MAIN), 140],
	];
	for (const [text, ageS] of cases) {
		const { dir, watch } = makeWatch({ 'stacks_9280.txt': text });
		age(path.join(dir, 'stacks_9280.txt'), ageS);
		await watch.scan();
		watch.stop();
		assert.ok(!fs.existsSync(path.join(dir, 'native_9280.txt')), `age ${ageS}s`);
	}
});

test('scan skips a silent file of a dead pid', async () => {
	const { dir, calls, watch } = makeWatch({ 'stacks_9280.txt': HEADER }, { alive: () => false });
	age(path.join(dir, 'stacks_9280.txt'), 200);
	await watch.scan();
	watch.stop();
	assert.strictEqual(calls.length, 0);
	assert.ok(!fs.existsSync(path.join(dir, 'native_9280.txt')));
});

test('scan skips a reused pid and an unreadable start time, for silent and frozen files', async () => {
	const frozen = HEADER + dump(FROZEN_MAIN) + dump(FROZEN_MAIN);
	// The header says 18:31:51 UTC: 60 s later is a new process; 5 s later is within the slack.
	const starts = [
		['2026-11-06T18:32:51.0000000Z', false],
		['2026-11-06T18:31:56.0000000Z', true],
		['2026-11-06T18:30:00.0000000Z', true],
		['NATIVE STACK', false],
		['', false],
	];
	for (const [startTime, captured] of starts) {
		for (const [text, ageS] of [[frozen, 1], [HEADER, 200]]) {
			const { dir, watch } = makeWatch({ 'stacks_9280.txt': text }, { startTime });
			age(path.join(dir, 'stacks_9280.txt'), ageS);
			await watch.scan();
			watch.stop();
			assert.strictEqual(fs.existsSync(path.join(dir, 'native_9280.txt')), captured, `${startTime} age ${ageS}`);
		}
	}
	// An unparsable `started=` in the header is a mismatch too.
	const bad = makeWatch({ 'stacks_9280.txt': frozen.replace('started=2026-11-06T18:31:51+0000', 'started=soon') });
	await bad.watch.scan();
	bad.watch.stop();
	assert.ok(!fs.existsSync(path.join(bad.dir, 'native_9280.txt')));
});

test('scan claims a pid before cdb runs and leaves a pid another watcher claimed', async () => {
	const frozen = HEADER + dump(FROZEN_MAIN) + dump(FROZEN_MAIN);
	const taken = makeWatch({ 'stacks_9280.txt': frozen, 'native_9280.txt': 'claimed by another\n' });
	await taken.watch.scan();
	taken.watch.stop();
	assert.strictEqual(taken.calls.length, 0);
	assert.strictEqual(fs.readFileSync(path.join(taken.dir, 'native_9280.txt'), 'utf8'), 'claimed by another\n');

	// The claim exists while cdb runs; the capture then replaces it.
	let during = null;
	let dirOfRun = null;
	const exec = (file, args, options, cb) => {
		if (file === 'tasklist') cb(null, '"engine.exe","9280","Console","1","10,000 K"\n', '');
		else if (file === 'powershell') cb(null, '2026-11-06T18:31:50.0000000Z', '');
		else {
			during = fs.readFileSync(path.join(dirOfRun, 'native_9280.txt'), 'utf8');
			cb(null, 'NATIVE STACK', '');
		}
		return { kill() {} };
	};
	const run = makeWatch({ 'stacks_9280.txt': frozen }, { exec });
	dirOfRun = run.dir;
	await run.watch.scan();
	run.watch.stop();
	assert.match(during, /^claimed time=.* pid=9280 by watcher \d+\n$/);
	assert.match(fs.readFileSync(path.join(run.dir, 'native_9280.txt'), 'utf8'), /NATIVE STACK/);
});

test('scan takes at most three captures', async () => {
	const files = {};
	for (const pid of [101, 102, 103, 104]) {
		files[`stacks_${pid}.txt`] = HEADER.replace('9280', String(pid)) + dump(FROZEN_MAIN) + dump(FROZEN_MAIN);
	}
	const { dir, watch } = makeWatch(files);
	await watch.scan();
	await watch.scan();
	watch.stop();
	assert.strictEqual(fs.readdirSync(dir).filter((n) => n.startsWith('native_')).length, 3);
});

test('scan logs once and stops when cdb is missing, and never throws', async () => {
	const frozen = HEADER + dump(FROZEN_MAIN) + dump(FROZEN_MAIN);
	const noKits = { 'ProgramFiles(x86)': 'Z:\\none', ProgramFiles: 'Z:\\none' };
	const { dir, watch } = makeWatch({ 'stacks_9280.txt': frozen }, { env: noKits });
	await watch.scan();
	await watch.scan();
	watch.stop();
	assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'stackwatch.log'), 'utf8').trim().split('\n').length, 1);
	assert.match(fs.readFileSync(path.join(dir, 'stackwatch.log'), 'utf8'), /cdb not found/);

	const missing = path.join(dir, 'missing');
	const gone = startStackWatch(missing, { platform: 'win32', ...WITH_CDB, intervalMs: 3_600_000 });
	await assert.doesNotReject(gone.scan());
	gone.stop();
});

test('parseStackFile keeps the elapsed time of each dump', () => {
	const parsed = parseStackFile(HEADER + dump(FROZEN_MAIN, '0:00:30') + dump(FROZEN_MAIN, '1:02:03'));
	assert.deepStrictEqual(
		parsed.dumps.map((d) => d.elapsed),
		[30, 3723]
	);
	assert.strictEqual(parseElapsed('nonsense'), null);
});

test('lockWait measures the trailing run of install.lock waits', () => {
	const wait = lockWait(
		parseStackFile(
			HEADER +
				dump(IDLE_MAIN, '0:01:00') +
				dump(lockWaitMain(DEPENDS_WIN), '0:02:00') +
				dump(lockWaitMain(DEPENDS_WIN), '0:05:00')
		)
	);
	assert.deepStrictEqual(wait, { waiting: true, seconds: 180 });
	// A single dump is a wait of unknown length; a child that moved on is not waiting.
	assert.deepStrictEqual(lockWait(parseStackFile(HEADER + dump(lockWaitMain(DEPENDS_WIN), '0:02:00'))), {
		waiting: true,
		seconds: 0,
	});
	const moved = HEADER + dump(lockWaitMain(DEPENDS_WIN), '0:01:00') + dump(IDLE_MAIN, '0:02:00');
	assert.deepStrictEqual(lockWait(parseStackFile(moved)), { waiting: false, seconds: 0 });
	assert.deepStrictEqual(lockWait(parseStackFile(HEADER)), { waiting: false, seconds: 0 });
});

test('longLockWait starts the capture at 180 s and picks the longest waiter', () => {
	assert.strictEqual(longLockWait([]), null);
	assert.strictEqual(longLockWait([{ pid: 1, seconds: 179 }]), null);
	assert.deepStrictEqual(
		longLockWait([
			{ pid: 1, seconds: 200 },
			{ pid: 2, seconds: 400 },
			{ pid: 3, seconds: 10 },
		]),
		{ pid: 2, seconds: 400 }
	);
	assert.deepStrictEqual(longLockWait([{ pid: 1, seconds: 180 }]), { pid: 1, seconds: 180 });
});

test('claimFile succeeds once per directory', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackwatch-claim-'));
	assert.strictEqual(claimFile(dir, 'lockholders.txt', 'pid=1'), true);
	assert.strictEqual(claimFile(dir, 'lockholders.txt', 'pid=2'), false);
	assert.match(fs.readFileSync(path.join(dir, 'lockholders.txt'), 'utf8'), /^claimed time=.* pid=1 by watcher \d+\n$/);
});

test('parseLockHolders reads the lock path and the samples', () => {
	const lines = [
		'lock=C:\\e\\cache\\install.lock',
		'sample 1',
		'P 10 engine.exe',
		'sample 2',
		'sample 3',
		'P 10 engine.exe',
		'P 11 python.exe',
	];
	const out = parseLockHolders(lines.join('\r\n') + '\r\n');
	assert.strictEqual(out.lock, 'C:\\e\\cache\\install.lock');
	assert.deepStrictEqual(
		out.samples.map((s) => s.map((p) => p.pid)),
		[[10], [], [10, 11]]
	);
	assert.strictEqual(parseLockHolders('lock=none\nexes=\n').lock, null);
});

test('selectHolderTargets takes the holders, then engines that are not waiters', () => {
	const p = (...pids) => pids.map((pid) => ({ pid, name: 'x' }));
	const base = { enginePids: [10, 20, 30, 40], waiterPids: [30, 40], selfPid: 99 };
	// 10 is open in every sample; 20 and 50 only in some; waiters and the watcher never count.
	const all = selectHolderTargets({ ...base, samples: [p(10, 20, 30), p(10, 50), p(10, 99)] });
	assert.deepStrictEqual(all, [
		{ pid: 10, why: 'open in every sample' },
		{ pid: 20, why: 'engine.exe, not a waiter' },
	]);
	// No process in all samples: every process seen is a candidate.
	const some = selectHolderTargets({ ...base, samples: [p(50), p(51), p(30)] });
	assert.deepStrictEqual(
		some.map((t) => t.pid),
		[50, 51, 10, 20]
	);
	assert.strictEqual(some[0].why, 'open in some samples');
	// No samples at all (the listing failed): the engines that are not waiters.
	assert.deepStrictEqual(
		selectHolderTargets({ ...base, samples: [] }).map((t) => t.pid),
		[10, 20]
	);
	assert.strictEqual(selectHolderTargets({ ...base, samples: [], max: 1 }).length, 1);
});

test('lockHoldersScript embeds the waiter pid and the sample count', () => {
	const script = lockHoldersScript(4242, 3);
	assert.match(script, /Get-Process -Id 4242/);
	assert.match(script, /\$n -le 3/);
	assert.match(script, /^'@$/m);
});
