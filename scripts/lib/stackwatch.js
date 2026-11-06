/**
 * Native stack of a task child that is frozen in startup (Windows only).
 *
 * The Python dumps in <dir>/stacks_<pid>.txt (see stackdumps.js) cannot show native
 * frames. The watcher reads those files; when the main thread of a child shows the
 * same stack in two complete dumps in a row, and that stack is not the idle wait of
 * a ready child, it attaches cdb.exe (Debugging Tools for Windows) to the child and
 * writes native_<pid>.txt next to the dumps. Events go to <dir>/stackwatch.log.
 *
 * The watcher never throws into the builder: every failure is logged and ignored.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SCAN_MS = 30_000;
const CDB_TIMEOUT_MS = 120_000;
const MAX_CAPTURES = 3;
const SYMBOL_URL = 'https://msdl.microsoft.com/download/symbols';
const CDB_COMMANDS = '~*kn 80; !locks; lm; qd';
const CDB_OVERRIDE_VAR = 'ROCKETRIDE_TEST_CDB';
const CHILD_IMAGE = 'engine.exe';

const THREAD_RE = /^(?:Current thread|Thread) 0x[0-9a-fA-F]+(?: \[.*\])? \(most recent call first\):$/;
const FRAME_RE = /^ {2}File "(.*)", line (\d+) in (.+)$/;
const NODE_PY_RE = /[\\/]ai[\\/]node\.py$/;

/**
 * Parse one faulthandler dump block (the text after a "Timeout" line).
 *
 * @param {string[]} lines - The lines of the block
 * @returns {{complete: boolean, frames: object[]}} The main thread's frames, most
 *   recent first, and whether the block is complete. The main thread is the thread
 *   whose oldest frame is `<module>` in ai/node.py; a block without such a thread is
 *   incomplete (the dump was cut) and has no frames.
 */
function parseDump(lines) {
	let thread = null;
	const threads = [];
	for (const line of lines) {
		if (THREAD_RE.test(line)) {
			thread = [];
			threads.push(thread);
			continue;
		}
		const m = thread && FRAME_RE.exec(line);
		if (m) thread.push({ file: m[1], line: Number(m[2]), func: m[3] });
	}
	const main = threads.find((frames) => {
		const last = frames[frames.length - 1];
		return last && last.func === '<module>' && NODE_PY_RE.test(last.file);
	});
	return main ? { complete: true, frames: main } : { complete: false, frames: [] };
}

/**
 * Parse the text of a stacks_<pid>.txt file.
 *
 * @param {string} text - The file content
 * @returns {{pid: number|null, started: string|null, argv: string|null, dumps: object[]}}
 *   The header fields and one parseDump result per dump block, oldest first
 */
function parseStackFile(text) {
	const parts = text.replace(/\r\n/g, '\n').split(/^Timeout \(.*\)!$/m);
	const header = parts[0];
	const pid = /^pid=(\d+)/m.exec(header);
	const started = /\bstarted=(\S+)/.exec(header);
	const argv = /^argv=(.*)$/m.exec(header);
	return {
		pid: pid ? Number(pid[1]) : null,
		started: started ? started[1] : null,
		argv: argv ? argv[1] : null,
		dumps: parts.slice(1).map((block) => parseDump(block.split('\n'))),
	};
}

/**
 * Tell whether the main thread's top frame is the idle wait of a ready child.
 * A ready child blocks in the native processArguments(), called straight from
 * node.py's run(), so its most recent Python frame is in node.py itself.
 *
 * @param {object[]} frames - Main-thread frames, most recent first
 * @returns {boolean} True when the child is idle in processArguments
 */
function isIdleFrame(frames) {
	return frames.length > 0 && NODE_PY_RE.test(frames[0].file) && frames[0].func === 'run';
}

/**
 * Decide whether a child is frozen in startup.
 *
 * @param {{dumps: object[]}} parsed - A parseStackFile result
 * @returns {{frozen: boolean, frames: object[]}} frozen is true when the last two
 *   complete dumps have identical main-thread frames and the top frame is not the
 *   idle wait; frames are those main-thread frames (empty when not frozen)
 */
function checkFrozen(parsed) {
	const complete = parsed.dumps.filter((d) => d.complete);
	if (complete.length < 2) return { frozen: false, frames: [] };
	const [a, b] = complete.slice(-2);
	const sameFrame = (f, i) => {
		const g = b.frames[i];
		return f.file === g.file && f.line === g.line && f.func === g.func;
	};
	const same = a.frames.length === b.frames.length && a.frames.every(sameFrame);
	if (!same || isIdleFrame(b.frames)) return { frozen: false, frames: [] };
	return { frozen: true, frames: b.frames };
}

/**
 * Find cdb.exe.
 *
 * @param {object} env - Environment variables
 * @param {(p: string) => boolean} [exists] - File existence check
 * @returns {string|null} The path of cdb.exe, or null when it is not installed
 */
function findCdb(env, exists = fs.existsSync) {
	const candidates = [];
	if (env[CDB_OVERRIDE_VAR]) candidates.push(env[CDB_OVERRIDE_VAR]);
	const roots = [env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', env.ProgramFiles ?? 'C:\\Program Files'];
	for (const root of roots) {
		candidates.push(path.win32.join(root, 'Windows Kits', '10', 'Debuggers', 'x64', 'cdb.exe'));
	}
	return candidates.find((p) => exists(p)) ?? null;
}

/**
 * Run a command and collect its result without ever rejecting.
 *
 * @param {string} file - The executable
 * @param {string[]} args - Its arguments
 * @param {object} options - child_process.execFile options
 * @param {Function} exec - execFile or a stand-in
 * @param {(child: object) => void} [onChild] - Receives the child process
 * @returns {Promise<{stdout: string, stderr: string, code: number|string|null, signal: string|null,
 *   error: string|null}>} The output and how the command ended; error is null on success
 */
function run(file, args, options, exec, onChild) {
	return new Promise((resolve) => {
		try {
			const opts = { windowsHide: true, maxBuffer: 64 << 20, ...options };
			const child = exec(file, args, opts, (err, stdout, stderr) => {
				resolve({
					stdout: String(stdout ?? ''),
					stderr: String(stderr ?? ''),
					code: err ? (err.code ?? null) : 0,
					signal: err?.signal ?? null,
					error: err ? err.message : null,
				});
			});
			if (onChild) onChild(child);
		} catch (err) {
			resolve({ stdout: '', stderr: '', code: null, signal: null, error: err.message });
		}
	});
}

/**
 * Tell whether a process is alive.
 *
 * @param {number} pid - The process id
 * @returns {boolean} True when the process exists
 */
function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === 'EPERM';
	}
}

/**
 * Watch a dump directory and take a native stack of a child frozen in startup.
 *
 * @param {string} dumpDir - The ROCKETRIDE_TEST_STACK_DUMPS directory
 * @param {object} [opts] - Overrides for tests
 * @param {string} [opts.platform] - process.platform
 * @param {object} [opts.env] - Environment used to find cdb
 * @param {number} [opts.intervalMs] - Time between scans
 * @param {Function} [opts.exec] - child_process.execFile
 * @param {(pid: number) => boolean} [opts.alive] - Process liveness check
 * @param {string} [opts.cacheDir] - Symbol cache directory
 * @returns {{stop: Function, scan: Function}} stop() ends the watch and any running
 *   cdb; scan() runs one pass and resolves when it is done
 */
function startStackWatch(dumpDir, opts = {}) {
	const platform = opts.platform ?? process.platform;
	if (platform !== 'win32') return { stop() {}, async scan() {} };

	const env = opts.env ?? process.env;
	const exec = opts.exec ?? execFile;
	const alive = opts.alive ?? isAlive;
	// Outside dumpDir, so the symbols are not uploaded with the dumps.
	const cacheDir = opts.cacheDir ?? path.join(os.tmpdir(), 'rr-symcache');
	const attempted = new Set();
	let running = null;
	let busy = false;
	let stopped = false;
	let cdb = null;
	let ready = false;
	let timer = null;

	const log = (msg) => {
		try {
			fs.appendFileSync(path.join(dumpDir, 'stackwatch.log'), `${new Date().toISOString()} ${msg}\n`);
		} catch {
			// The log is best effort.
		}
	};

	const halt = () => {
		stopped = true;
		clearInterval(timer);
	};

	/**
	 * Attach cdb to one frozen child and write native_<pid>.txt. The attach is
	 * noninvasive (-pv): the child keeps its state and is not killed with cdb.
	 *
	 * @param {number} pid - The child's process id
	 * @param {object[]} frames - The main-thread frames that matched
	 * @returns {Promise<void>}
	 */
	const capture = async (pid, frames) => {
		const sympath = `srv*${cacheDir}*${SYMBOL_URL}`;
		const started = Date.now();
		const args = ['-pv', '-p', String(pid), '-y', sympath, '-c', CDB_COMMANDS];
		const options = { timeout: CDB_TIMEOUT_MS, killSignal: 'SIGKILL' };
		const res = await run(cdb, args, options, exec, (child) => (running = child));
		running = null;
		const trigger = frames.map((f) => `  ${f.file}:${f.line} ${f.func}`).join('\n');
		const text = [
			`time=${new Date(started).toISOString()} pid=${pid} cdb=${cdb}`,
			`trigger: main thread unchanged in the last two dumps, most recent frame first:\n${trigger}`,
			`exit=${res.code} signal=${res.signal} error=${res.error} duration_ms=${Date.now() - started}`,
			'--- stdout ---',
			res.stdout,
			'--- stderr ---',
			res.stderr,
			'',
		].join('\n');
		fs.writeFileSync(path.join(dumpDir, `native_${pid}.txt`), text);
		log(`captured pid=${pid} exit=${res.code} signal=${res.signal} error=${res.error}`);
	};

	/**
	 * Check that a pid still belongs to an engine.exe. A pid can be reused after the
	 * child exits; this narrows that to another engine.exe, and the few seconds between
	 * this check and the attach stay a residual risk.
	 *
	 * @param {number} pid - The process id
	 * @returns {Promise<boolean>} True when the pid belongs to an engine.exe
	 */
	const isEngine = async (pid) => {
		const res = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 15_000 }, exec);
		return res.error === null && res.stdout.toLowerCase().includes(`"${CHILD_IMAGE}"`);
	};

	const scan = async () => {
		if (stopped || busy) return;
		busy = true;
		try {
			if (!ready) {
				ready = true;
				cdb = findCdb(env);
				log(cdb ? `started, cdb=${cdb}` : 'started, cdb not found');
			}
			if (!cdb) {
				halt();
				return;
			}
			for (const name of fs.readdirSync(dumpDir)) {
				const m = /^stacks_(\d+)\.txt$/.exec(name);
				if (!m || stopped) continue;
				const pid = Number(m[1]);
				// Another watcher (a parallel test server) may have captured it already.
				if (attempted.has(pid) || fs.existsSync(path.join(dumpDir, `native_${pid}.txt`))) continue;
				const parsed = parseStackFile(fs.readFileSync(path.join(dumpDir, name), 'utf8'));
				const verdict = checkFrozen(parsed);
				if (!verdict.frozen || parsed.pid !== pid || !alive(pid)) continue;
				if (!(await isEngine(pid))) continue;
				attempted.add(pid);
				await capture(pid, verdict.frames);
				if (attempted.size >= MAX_CAPTURES) {
					log(`stopped after ${MAX_CAPTURES} captures`);
					halt();
				}
			}
		} catch (err) {
			log(`error: ${err.message}`);
		} finally {
			busy = false;
		}
	};

	// scan() catches everything itself, so the promise it returns never rejects.
	timer = setInterval(() => void scan(), opts.intervalMs ?? SCAN_MS);
	timer.unref();

	return {
		scan,
		stop() {
			halt();
			try {
				running?.kill();
			} catch {
				// Already gone.
			}
		},
	};
}

module.exports = { parseDump, parseStackFile, checkFrozen, isIdleFrame, findCdb, startStackWatch };
