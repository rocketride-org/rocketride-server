/**
 * Native stack of a task child that is stuck in startup (Windows only).
 *
 * The Python dumps in <dir>/stacks_<pid>.txt (see stackdumps.js) cannot show native
 * frames. The watcher reads those files and attaches cdb.exe (Debugging Tools for
 * Windows) to a live child in two cases, then writes native_<pid>.txt next to the dumps:
 *   - frozen: the main thread shows the same stack in two complete dumps in a row, and
 *     that stack is neither the idle wait of a ready child nor a known wait (WAIT_FRAMES);
 *   - silent: the file has not been written for SILENT_INTERVALS dump intervals, which
 *     happens when a thread holds the GIL inside native code and the dumper cannot run.
 * Before attaching, the watcher checks that the pid is an engine.exe that started no
 * later than the file's header says, so a reused pid is never attached.
 *
 * cdb suspends the child only while it reads the threads. It resumes the child when it
 * detaches (qd); the child stays suspended only if cdb is killed before that. Parallel
 * watchers claim a pid by creating native_<pid>.txt exclusively, so one cdb runs per pid.
 * Events go to <dir>/stackwatch.log.
 *
 * Lock holder: a child that waits for install.lock is skipped above, but when one has
 * waited LOCK_WAIT_S or longer the holder is unknown (it may be a server or a pytest worker,
 * which write no dumps). Once per dump directory the watcher then lists the processes that
 * have the lock file open with the Windows Restart Manager (3 samples, written to
 * lockholders.txt) and takes a native stack of each of them and of every engine.exe that is
 * not itself a waiter (holder_<pid>.txt, claimed exclusively like native_<pid>.txt).
 *
 * The watcher never throws into the builder: every failure is logged and ignored.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SCAN_MS = 30_000;
// Generous: a capture that downloads symbols takes several seconds, and a killed cdb
// leaves the child suspended.
const CDB_TIMEOUT_MS = 300_000;
const MAX_CAPTURES = 3;
const SYMBOL_URL = 'https://msdl.microsoft.com/download/symbols';
const CDB_COMMANDS = '~*kn 80; !locks; lm; qd';
const CDB_OVERRIDE_VAR = 'ROCKETRIDE_TEST_CDB';
const CHILD_IMAGE = 'engine.exe';
// A live child rewrites its file every dump interval; a file left unwritten for this many
// intervals means the dumper is stuck.
const SILENT_INTERVALS = 2.5;
const DEFAULT_INTERVAL_S = 30;
// A reused pid belongs to a process that started after the file's header was written;
// this much clock difference is tolerated.
const START_SLACK_MS = 5_000;
// PowerShell can take tens of seconds to start on a loaded runner, which is when a capture is needed.
const START_TIME_TIMEOUT_MS = 60_000;

const THREAD_RE = /^(?:Current thread|Thread) 0x[0-9a-fA-F]+(?: \[.*\])? \(most recent call first\):$/;
const FRAME_RE = /^ {2}File "(.*)", line (\d+) in (.+)$/;
const NODE_PY_RE = /[\\/]ai[\\/]node\.py$/;
// Top frames where a child only waits and reports its status: not a freeze. Each entry
// matches the file path and the function name.
const WAIT_FRAMES = [
	// FileLock.__enter__ polls the shared install.lock once a second.
	{ file: /[\\/]depends\.py$/, func: '__enter__' },
];
// A child that has waited this long for install.lock starts the lock-holder capture.
const LOCK_WAIT_S = 180;
const LOCK_FILE = 'lockholders.txt';
// Restart Manager samples of the lock file, one second apart: a waiter opens the file
// briefly each second, the holder keeps it open and is in every sample.
const LOCK_SAMPLES = 3;
const LOCK_LIST_TIMEOUT_MS = 90_000;
const HOLDER_CDB_TIMEOUT_MS = 120_000;
// Total time for all holder_<pid>.txt captures of one job, and their number.
const HOLDER_BUDGET_MS = 600_000;
const MAX_HOLDER_CAPTURES = 12;
const TIME_RE = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:?\d\d)$/;

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
 * @returns {{pid: number|null, started: string|null, interval: number|null, argv: string|null,
 *   dumps: object[]}} The header fields (interval in seconds) and one parseDump result per
 *   dump block, oldest first, each with `elapsed` (seconds since the dumper started, or null)
 */
function parseStackFile(text) {
	// The capture group puts each dump's elapsed time in front of its block.
	const parts = text.replace(/\r\n/g, '\n').split(/^Timeout \((.*)\)!$/m);
	const header = parts[0];
	const dumps = [];
	for (let i = 1; i + 1 < parts.length; i += 2) {
		dumps.push({ ...parseDump(parts[i + 1].split('\n')), elapsed: parseElapsed(parts[i]) });
	}
	const pid = /^pid=(\d+)/m.exec(header);
	const started = /\bstarted=(\S+)/.exec(header);
	const interval = /\binterval=(\d+)s\b/.exec(header);
	const argv = /^argv=(.*)$/m.exec(header);
	return {
		pid: pid ? Number(pid[1]) : null,
		started: started ? started[1] : null,
		interval: interval ? Number(interval[1]) : null,
		argv: argv ? argv[1] : null,
		dumps,
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
 * Tell whether the main thread's top frame is a known wait (see WAIT_FRAMES).
 *
 * @param {object[]} frames - Main-thread frames, most recent first
 * @returns {boolean} True when the child is only waiting
 */
function isWaitFrame(frames) {
	const top = frames[0];
	return !!top && WAIT_FRAMES.some((w) => w.func === top.func && w.file.test(top.file));
}

/**
 * Parse a timestamp with a zone, as the dump header writes it (`2026-11-06T18:31:51+0100`)
 * or as .NET writes it (`2026-11-06T17:31:51.1234567Z`).
 *
 * @param {string|null} text - The timestamp
 * @returns {number} Milliseconds since the epoch, or NaN when the text is not a timestamp with a zone
 */
function parseTime(text) {
	const m = TIME_RE.exec(String(text ?? '').trim());
	if (!m) return NaN;
	const zone = m[4] === 'Z' || m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
	return Date.parse(`${m[1]}T${m[2]}.${(m[3] ?? '').padEnd(3, '0').slice(0, 3)}${zone}`);
}

/**
 * Decide whether a child is frozen in startup.
 *
 * @param {{dumps: object[]}} parsed - A parseStackFile result
 * @returns {{frozen: boolean, frames: object[]}} frozen is true when the last two
 *   complete dumps have identical main-thread frames and the top frame is neither the
 *   idle wait nor a known wait; frames are those main-thread frames (empty when not frozen)
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
	if (!same || isIdleFrame(b.frames) || isWaitFrame(b.frames)) return { frozen: false, frames: [] };
	return { frozen: true, frames: b.frames };
}

/**
 * Decide whether the dumper of a child has gone silent.
 *
 * @param {{interval: number|null, dumps: object[]}} parsed - A parseStackFile result
 * @param {number} ageMs - Time since the file was last written
 * @returns {{silent: boolean, seconds: number, frames: object[]}} silent is true when the
 *   file is older than SILENT_INTERVALS dump intervals (the header's, or the default);
 *   seconds is the age; frames are the main-thread frames of the last complete dump
 *   (empty when there is none)
 */
function checkSilent(parsed, ageMs) {
	const limitMs = SILENT_INTERVALS * (parsed.interval ?? DEFAULT_INTERVAL_S) * 1000;
	const last = parsed.dumps.filter((d) => d.complete).at(-1);
	return { silent: ageMs > limitMs, seconds: Math.round(ageMs / 1000), frames: last ? last.frames : [] };
}

/**
 * Parse the elapsed time of a dump heading (`0:01:30`, hours unpadded).
 *
 * @param {string} text - The text between the parentheses of `Timeout (...)!`
 * @returns {number|null} Seconds, or null when the text is not h:mm:ss
 */
function parseElapsed(text) {
	const m = /^(\d+):(\d\d):(\d\d)(?:\.\d+)?$/.exec(String(text).trim());
	return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/**
 * Measure how long a child has been waiting for install.lock: the trailing run of complete
 * dumps whose main thread is in a known wait (see WAIT_FRAMES), from the first dump of the
 * run to the last.
 *
 * @param {{dumps: object[]}} parsed - A parseStackFile result
 * @returns {{waiting: boolean, seconds: number}} waiting is true when the last complete dump
 *   shows the wait; seconds is the dump-time span of the run (0 for a single dump)
 */
function lockWait(parsed) {
	const dumps = parsed.dumps.filter((d) => d.complete && d.elapsed !== null);
	let first = dumps.length;
	while (first > 0 && isWaitFrame(dumps[first - 1].frames)) first--;
	if (first === dumps.length) return { waiting: false, seconds: 0 };
	return { waiting: true, seconds: dumps[dumps.length - 1].elapsed - dumps[first].elapsed };
}

/**
 * Decide whether the lock-holder capture starts.
 *
 * @param {{pid: number, seconds: number}[]} waits - The children currently waiting for the lock
 * @param {number} [limitS] - The wait that starts the capture
 * @returns {{pid: number, seconds: number}|null} The longest waiter when its wait reaches
 *   the limit, else null
 */
function longLockWait(waits, limitS = LOCK_WAIT_S) {
	const longest = waits.reduce((a, b) => (!a || b.seconds > a.seconds ? b : a), null);
	return longest && longest.seconds >= limitS ? longest : null;
}

/**
 * Parse the output of the Restart Manager script (see lockHoldersScript).
 *
 * @param {string} text - Script output: `lock=<path>`, then per sample a `sample <n>` line
 *   followed by `P <pid> <name>` lines
 * @returns {{lock: string|null, samples: {pid: number, name: string}[][]}} The lock path
 *   (null when it was not found) and the processes seen in each sample
 */
function parseLockHolders(text) {
	const out = { lock: null, samples: [] };
	for (const line of String(text).replace(/\r/g, '').split('\n')) {
		const lock = /^lock=(.+)$/.exec(line);
		const proc = /^P (\d+) (.*)$/.exec(line);
		if (lock) out.lock = lock[1] === 'none' ? null : lock[1];
		else if (/^sample \d+$/.test(line)) out.samples.push([]);
		else if (proc && out.samples.length) out.samples.at(-1).push({ pid: Number(proc[1]), name: proc[2] });
	}
	return out;
}

/**
 * Choose the processes to capture: the lock-file holders and every engine.exe that is not
 * itself waiting for the lock.
 *
 * @param {object} args - The inputs
 * @param {{pid: number}[][]} args.samples - Restart Manager samples
 * @param {number[]} args.enginePids - Every running engine.exe
 * @param {number[]} args.waiterPids - Children waiting for the lock
 * @param {number} args.selfPid - The watcher's own process, never captured
 * @param {number} [args.max] - Upper bound on the result
 * @returns {{pid: number, why: string}[]} Holders first (a pid in every sample, or in any
 *   sample when none is in all), then the other engines
 */
function selectHolderTargets({ samples, enginePids, waiterPids, selfPid, max = MAX_HOLDER_CAPTURES }) {
	const skip = new Set([...waiterPids, selfPid]);
	const seen = samples.map((s) => new Set(s.map((p) => p.pid)));
	const any = [...new Set(seen.flatMap((s) => [...s]))].filter((pid) => !skip.has(pid));
	const all = any.filter((pid) => seen.every((s) => s.has(pid)));
	const holders = all.length ? all : any;
	const targets = holders.map((pid) => ({ pid, why: all.length ? 'open in every sample' : 'open in some samples' }));
	for (const pid of enginePids) {
		if (!skip.has(pid) && !targets.some((t) => t.pid === pid)) {
			targets.push({ pid, why: 'engine.exe, not a waiter' });
		}
	}
	return targets.slice(0, max);
}

/**
 * Claim a file by creating it exclusively. A parallel watcher on the same directory that
 * loses the race gets false and leaves the work to the winner.
 *
 * @param {string} dir - The dump directory
 * @param {string} name - The file name
 * @param {string} note - Written into the new file
 * @returns {boolean} True when this call created the file
 */
function claimFile(dir, name, note) {
	let fd;
	try {
		fd = fs.openSync(path.join(dir, name), 'wx');
	} catch (err) {
		if (err.code === 'EEXIST') return false;
		throw err;
	}
	try {
		fs.writeSync(fd, `claimed time=${new Date().toISOString()} ${note} by watcher ${process.pid}\n`);
	} finally {
		fs.closeSync(fd);
	}
	return true;
}

const RM_CSHARP = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class RmHolders {
	[StructLayout(LayoutKind.Sequential)]
	struct RM_UNIQUE_PROCESS {
		public int dwProcessId;
		public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
	}
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	struct RM_PROCESS_INFO {
		public RM_UNIQUE_PROCESS Process;
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
		public int ApplicationType; public uint AppStatus; public uint TSSessionId;
		[MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
	}
	[DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
	static extern int RmStartSession(out uint h, int flags, StringBuilder key);
	[DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
	static extern int RmRegisterResources(
		uint h, uint nFiles, string[] files, uint nApps, RM_UNIQUE_PROCESS[] apps, uint nSvc, string[] svc);
	[DllImport("rstrtmgr.dll")]
	static extern int RmGetList(
		uint h, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, out uint reasons);
	[DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
	public static List<string> Of(string file) {
		var result = new List<string>();
		uint h; var key = new StringBuilder(33);
		int rc = RmStartSession(out h, 0, key);
		if (rc != 0) { result.Add("ERR RmStartSession " + rc); return result; }
		try {
			rc = RmRegisterResources(h, 1, new string[] { file }, 0, null, 0, null);
			if (rc != 0) { result.Add("ERR RmRegisterResources " + rc); return result; }
			uint needed = 0, count = 0, reasons;
			rc = RmGetList(h, out needed, ref count, null, out reasons);
			for (int attempt = 0; rc == 234 && attempt < 5; attempt++) {
				var info = new RM_PROCESS_INFO[needed + 4];
				count = (uint)info.Length;
				rc = RmGetList(h, out needed, ref count, info, out reasons);
				if (rc == 0) for (int i = 0; i < count; i++)
					result.Add(info[i].Process.dwProcessId + " " + info[i].strAppName);
			}
			if (rc != 0 && rc != 234) result.Add("ERR RmGetList " + rc);
		} finally { RmEndSession(h); }
		return result;
	}
}
`;

/**
 * Build the PowerShell script that lists the processes holding install.lock open. It finds
 * the lock the way depends.py does: <directory of the engine executable>/cache/install.lock.
 * The waiter's own executable is tried first, then every engine.exe. Output format: see
 * parseLockHolders.
 *
 * @param {number} waiterPid - A child waiting for the lock
 * @param {number} [samples] - How many Restart Manager samples to take, one second apart
 * @returns {string} The script text
 */
function lockHoldersScript(waiterPid, samples = LOCK_SAMPLES) {
	return [
		"$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
		`Add-Type -TypeDefinition @'${RM_CSHARP}'@`,
		`$exes = @(); try { $exes += (Get-Process -Id ${waiterPid}).Path } catch {}`,
		'try { $exes += (Get-Process -Name engine).Path } catch {}',
		"$lock = $exes | Where-Object { $_ } | " +
			"ForEach-Object { Join-Path (Join-Path (Split-Path $_) 'cache') 'install.lock' } | " +
			'Where-Object { Test-Path $_ } | Select-Object -First 1',
		"if (-not $lock) { Write-Output 'lock=none'; Write-Output ('exes=' + ($exes -join ';')); exit 0 }",
		'Write-Output "lock=$lock"',
		`for ($n = 1; $n -le ${samples}; $n++) {`,
		'\tWrite-Output "sample $n"',
		'\tforeach ($h in [RmHolders]::Of($lock)) { ' +
			'if ($h -like \'ERR *\') { Write-Output $h } else { Write-Output "P $h" } }',
		`\tif ($n -lt ${samples}) { Start-Sleep -Seconds 1 }`,
		'}',
	].join('\n');
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
	let captures = 0;
	// Running cdb processes; stop() kills them.
	const children = new Set();
	let capped = false;
	let lockHandled = false;
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
	 * Claim a pid by creating native_<pid>.txt exclusively. A parallel watcher on the same
	 * directory that loses the race gets false and leaves the pid alone.
	 *
	 * @param {number} pid - The child's process id
	 * @returns {boolean} True when this watcher created the file
	 */
	const claim = (pid) => claimFile(dumpDir, `native_${pid}.txt`, `pid=${pid}`);

	/**
	 * Attach cdb to one stuck child and write native_<pid>.txt over the claim. cdb
	 * suspends the child while it reads every thread, and resumes it when it detaches
	 * (qd). The child stays suspended only if cdb is killed first, which happens on the
	 * timeout or on stop().
	 *
	 * @param {number} pid - The child's process id
	 * @param {string} trigger - Why the child was captured; written to the file
	 * @param {{file?: string, timeoutMs?: number}} [where] - The output file (default
	 *   native_<pid>.txt) and the cdb time limit
	 * @returns {Promise<void>}
	 */
	const capture = async (pid, trigger, where = {}) => {
		const outName = where.file ?? `native_${pid}.txt`;
		const sympath = `srv*${cacheDir}*${SYMBOL_URL}`;
		const started = Date.now();
		const args = ['-pv', '-p', String(pid), '-y', sympath, '-c', CDB_COMMANDS];
		const options = { timeout: where.timeoutMs ?? CDB_TIMEOUT_MS, killSignal: 'SIGKILL' };
		let mine = null;
		const res = await run(cdb, args, options, exec, (child) => children.add((mine = child)));
		children.delete(mine);
		const text = [
			`time=${new Date(started).toISOString()} pid=${pid} cdb=${cdb}`,
			`trigger: ${trigger}`,
			`exit=${res.code} signal=${res.signal} error=${res.error} duration_ms=${Date.now() - started}`,
			'--- stdout ---',
			res.stdout,
			'--- stderr ---',
			res.stderr,
			'',
		].join('\n');
		fs.writeFileSync(path.join(dumpDir, outName), text);
		log(`captured ${outName} pid=${pid} exit=${res.code} signal=${res.signal} error=${res.error}`);
	};

	/**
	 * Check that a pid belongs to an engine.exe. A pid can be reused after the child
	 * exits; this is the first filter, sameProcess() the precise one.
	 *
	 * @param {number} pid - The process id
	 * @returns {Promise<boolean>} True when the pid belongs to an engine.exe
	 */
	const isEngine = async (pid) => {
		const res = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 15_000 }, exec);
		return res.error === null && res.stdout.toLowerCase().includes(`"${CHILD_IMAGE}"`);
	};

	/**
	 * Check that a pid is the process the dump header describes: the process started no
	 * later than the header's `started=` (plus START_SLACK_MS). A process that started
	 * after the header was written is a reused pid. An unreadable start time on either
	 * side counts as no match.
	 *
	 * @param {number} pid - The process id
	 * @param {string|null} headerStarted - The `started=` value of the file header
	 * @returns {Promise<boolean>} True when the pid is the process of the header
	 */
	const sameProcess = async (pid, headerStarted) => {
		const command = `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`;
		const args = ['-NoProfile', '-Command', command];
		const res = await run('powershell', args, { timeout: START_TIME_TIMEOUT_MS }, exec);
		if (res.error !== null) return false;
		const processMs = parseTime(res.stdout);
		const headerMs = parseTime(headerStarted);
		return Number.isFinite(processMs) && Number.isFinite(headerMs) && processMs - headerMs <= START_SLACK_MS;
	};

	/**
	 * Read every live child's dump file and report those waiting for install.lock.
	 *
	 * @returns {{pid: number, seconds: number}[]} One entry per live waiter
	 */
	const collectLockWaits = () => {
		const waits = [];
		for (const name of fs.readdirSync(dumpDir)) {
			const m = /^stacks_(\d+)\.txt$/.exec(name);
			if (!m || !alive(Number(m[1]))) continue;
			try {
				const parsed = parseStackFile(fs.readFileSync(path.join(dumpDir, name), 'utf8'));
				const wait = lockWait(parsed);
				if (parsed.pid === Number(m[1]) && wait.waiting) waits.push({ pid: parsed.pid, seconds: wait.seconds });
			} catch (err) {
				log(`lock wait check of ${name} failed: ${err.message}`);
			}
		}
		return waits;
	};

	/**
	 * Name and capture the holder of install.lock. Runs once per dump directory (lockholders.txt
	 * is the claim): lists the processes that have the lock file open (3 Restart Manager
	 * samples, written to lockholders.txt), then takes a native stack of each of them and of
	 * every engine.exe that is not a waiter into holder_<pid>.txt, within HOLDER_BUDGET_MS.
	 *
	 * @param {{pid: number, seconds: number}[]} waits - The children waiting for the lock
	 * @param {{pid: number, seconds: number}} longest - The longest waiter
	 * @returns {Promise<void>}
	 */
	const captureLockHolders = async (waits, longest) => {
		const began = Date.now();
		if (!claimFile(dumpDir, LOCK_FILE, `pid=${longest.pid} waiting ${longest.seconds} s`)) {
			log(`skipped lock holders: claimed by another watcher`);
			return;
		}
		const script = Buffer.from(lockHoldersScript(longest.pid), 'utf16le').toString('base64');
		const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', script];
		const listed = await run('powershell', args, { timeout: LOCK_LIST_TIMEOUT_MS }, exec);
		const listing = parseLockHolders(listed.stdout);
		const tasks = await run(
			'tasklist',
			['/FI', `IMAGENAME eq ${CHILD_IMAGE}`, '/FO', 'CSV', '/NH'],
			{ timeout: 15_000 },
			exec
		);
		const enginePids = [...tasks.stdout.matchAll(/^"engine\.exe","(\d+)"/gim)].map((m) => Number(m[1]));
		const targets = selectHolderTargets({
			samples: listing.samples,
			enginePids,
			waiterPids: waits.map((w) => w.pid),
			selfPid: process.pid,
		});
		const seen = new Map();
		listing.samples.forEach((sample, i) => {
			for (const p of sample) {
				seen.set(p.pid, { name: p.name, samples: [...(seen.get(p.pid)?.samples ?? []), i + 1] });
			}
		});
		const text = [
			`time=${new Date(began).toISOString()} trigger: pid=${longest.pid} ` +
				`has waited ${longest.seconds} s for install.lock`,
			`waiters: ${waits.map((w) => `${w.pid} (${w.seconds} s)`).join(', ')}`,
			`lock=${listing.lock}`,
			`exit=${listed.code} signal=${listed.signal} error=${listed.error}`,
			`samples: ${listing.samples.length}`,
			'--- processes with the lock open (pid name samples) ---',
			...[...seen].map(([pid, v]) => `${pid} ${v.name} ${v.samples.join(',')}`),
			'--- capture targets (pid why) ---',
			...targets.map((t) => `${t.pid} ${t.why}`),
			'--- script output ---',
			listed.stdout,
			'--- script stderr ---',
			listed.stderr,
			'',
		].join('\n');
		fs.writeFileSync(path.join(dumpDir, LOCK_FILE), text);
		log(`lock holders: lock=${listing.lock} targets=${targets.map((t) => t.pid).join(',') || 'none'}`);
		for (const t of targets) {
			const left = HOLDER_BUDGET_MS - (Date.now() - began);
			if (stopped || left <= 0) {
				log('lock holder captures stopped: out of time or watcher stopped');
				return;
			}
			const file = `holder_${t.pid}.txt`;
			if (!alive(t.pid) || !claimFile(dumpDir, file, `pid=${t.pid}`)) continue;
			await capture(t.pid, `install.lock: ${t.why}`, { file, timeoutMs: Math.min(HOLDER_CDB_TIMEOUT_MS, left) });
		}
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
			if (!lockHandled) {
				const waits = collectLockWaits();
				const longest = longLockWait(waits);
				if (longest) {
					lockHandled = true;
					// In the background: the captures can take minutes and must not delay the scans.
					void captureLockHolders(waits, longest).catch((err) => log(`lock holder error: ${err.message}`));
				}
			}
			for (const name of fs.readdirSync(dumpDir)) {
				const m = /^stacks_(\d+)\.txt$/.exec(name);
				if (!m || stopped || capped) continue;
				const pid = Number(m[1]);
				// Another watcher (a parallel test server) may have captured it already.
				if (attempted.has(pid) || fs.existsSync(path.join(dumpDir, `native_${pid}.txt`))) continue;
				if (!alive(pid)) continue;
				const file = path.join(dumpDir, name);
				const parsed = parseStackFile(fs.readFileSync(file, 'utf8'));
				if (parsed.pid !== pid) continue;
				const ageMs = Date.now() - fs.statSync(file).mtimeMs;
				const silent = checkSilent(parsed, ageMs);
				const list = (frames) => frames.map((f) => `  ${f.file}:${f.line} ${f.func}`).join('\n');
				let trigger;
				if (silent.silent) {
					const last = silent.frames.length
						? `main thread in the last complete dump, most recent frame first:\n${list(silent.frames)}`
						: 'no complete dump';
					trigger = `no dump for ${silent.seconds} s; ${last}`;
				} else {
					const verdict = checkFrozen(parsed);
					if (!verdict.frozen) continue;
					const head = 'main thread unchanged in the last two dumps, most recent frame first:';
					trigger = `${head}\n${list(verdict.frames)}`;
				}
				if (!(await isEngine(pid)) || !(await sameProcess(pid, parsed.started))) continue;
				attempted.add(pid);
				// Another watcher may have claimed the pid since the first check of this pass.
				if (!claim(pid)) {
					log(`skipped pid=${pid}: claimed by another watcher`);
					continue;
				}
				await capture(pid, trigger);
				if (++captures >= MAX_CAPTURES) {
					log(`stopped after ${MAX_CAPTURES} captures`);
					// The lock-holder check keeps running.
					capped = true;
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
				for (const child of children) child.kill();
			} catch {
				// Already gone.
			}
		},
	};
}

module.exports = {
	parseDump,
	parseStackFile,
	parseElapsed,
	lockWait,
	longLockWait,
	parseLockHolders,
	selectHolderTargets,
	claimFile,
	lockHoldersScript,
	checkFrozen,
	checkSilent,
	isIdleFrame,
	isWaitFrame,
	parseTime,
	findCdb,
	startStackWatch,
};
