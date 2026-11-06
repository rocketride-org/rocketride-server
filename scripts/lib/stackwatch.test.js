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

const { parseDump, parseStackFile, checkFrozen, findCdb, startStackWatch } = require('./stackwatch');

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

const dump = (main, secs = '0:00:30') => `Timeout (${secs})!\n${LOOP_THREAD}${main}\n`;

test('parses the header and the dump blocks', () => {
	const parsed = parseStackFile(HEADER + dump(FROZEN_MAIN) + dump(FROZEN_MAIN, '0:01:00'));
	assert.strictEqual(parsed.pid, 9280);
	assert.strictEqual(parsed.started, '2026-11-06T18:31:51+0000');
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
	assert.deepStrictEqual(parseStackFile(''), { pid: null, started: null, argv: null, dumps: [] });
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
	assert.deepStrictEqual(parsed.dumps, [{ complete: false, frames: [] }]);
});

test('a healthy idle child is not frozen', () => {
	const parsed = parseStackFile(HEADER + dump(IDLE_MAIN) + dump(IDLE_MAIN, '0:01:00') + dump(IDLE_MAIN, '0:01:30'));
	assert.strictEqual(checkFrozen(parsed).frozen, false);
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-stackwatch-test-'));
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
	const calls = [];
	const exec = (file, args, options, cb) => {
		calls.push({ file, args });
		if (file === 'tasklist') cb(null, `"engine.exe","${args[1].split(' ').pop()}","Console","1","10,000 K"\n`, '');
		else cb(null, 'NATIVE STACK', '');
		return { kill() {} };
	};
	const watch = startStackWatch(dir, {
		platform: 'win32',
		...WITH_CDB,
		exec,
		alive: () => true,
		intervalMs: 3_600_000,
		...opts,
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
	const cdbCalls = calls.filter((c) => c.file !== 'tasklist');
	assert.strictEqual(cdbCalls.length, 1);
	assert.deepStrictEqual(cdbCalls[0].args.slice(0, 3), ['-pv', '-p', '9280']);
	assert.ok(cdbCalls[0].args[4].includes('rr-symcache') && cdbCalls[0].args[4].startsWith('srv*'));
	const native = fs.readFileSync(path.join(dir, 'native_9280.txt'), 'utf8');
	assert.match(native, /pid=9280/);
	assert.match(native, /create_module/);
	assert.match(native, /NATIVE STACK/);
	assert.ok(!fs.existsSync(path.join(dir, 'native_4336.txt')));
	const log = fs.readFileSync(path.join(dir, 'stackwatch.log'), 'utf8').split('\n');
	assert.match(log[0], /started, cdb=/);
	assert.match(log[1], /captured pid=9280 exit=0/);
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
