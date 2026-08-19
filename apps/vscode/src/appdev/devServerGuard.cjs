// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * devServerGuard — the dev server's liveness tether to its editor.
 *
 * The extension host spawns this wrapper instead of rsbuild directly; the
 * wrapper spawns rsbuild as its child and guarantees the server can never
 * outlive the editor that owns it. A window reload, crash, EDH stop, or a
 * hard kill of the extension host all close the guard's STDIN pipe (the
 * OS releases the write end with the dying process); the guard reacts by
 * felling its own process tree — dev-server orphans are structurally
 * impossible, which is what replaced boot-time orphan hunting.
 *
 * Duties:
 *   1. Die with the owner — stdin EOF (event-driven, catches every death
 *      mode) plus a slow owner-pid liveness poll as a backstop.
 *   2. Pass output through untouched — the child inherits the guard's
 *      stdout/stderr, so the extension's banner/build parsing sees
 *      rsbuild verbatim.
 *   3. Mirror the exit — the guard exits with the child's code, so the
 *      extension's crash detection treats the guard as the server.
 *
 * argv: [ownerPid, useShell(0|1), cmd, ...args]
 * cwd:  the app folder (set by the spawner).
 */

'use strict';

const { spawn } = require('child_process');

// =============================================================================
// ARGUMENTS
// =============================================================================

const [ownerPidArg, shellArg, cmd, ...args] = process.argv.slice(2);
const ownerPid = Number(ownerPidArg);

// =============================================================================
// CHILD — the actual dev server
// =============================================================================

// NOT detached: the child shares the guard's process group (the extension
// spawns the guard detached on POSIX, making the guard the group leader),
// so one group signal — from the extension's stop() or from die() below —
// fells guard and server together. Windows uses taskkill /T for the same
// whole-tree guarantee.
const child = spawn(cmd, args, {
	shell: shellArg === '1',
	stdio: ['ignore', 'inherit', 'inherit'],
	// The shell fallback runs through cmd.exe (console subsystem) — without
	// this, Windows allocates a visible console window that sits on the
	// user's desktop for the dev server's whole lifetime.
	windowsHide: true,
});

let dying = false;

// =============================================================================
// TREE CLEANUP — the guard owns EVERYTHING below itself
// =============================================================================
// The watcher's whole stop contract is "close the guard's stdin (or, last
// resort, kill the guard)"; every process below the guard is the guard's own
// responsibility. Windows has NO parent-death cascade and closing stdio kills
// nobody — the cascade here is built from direct TerminateProcess syscalls,
// never from a spawned taskkill (a spawned killer is exactly as mortal as
// the guard and reproducibly died mid-walk during editor-exit sweeps,
// leaking the pnpm->cmd->rsbuild chain).

/**
 * Snapshots the descendant pids of `rootPid`, LEAF-FIRST, via one CIM query.
 * Calls back [] on any failure — by then the caller's direct child kill has
 * already covered the flattened primary spawn (node -> rsbuild.js).
 *
 * @param rootPid - Subtree root (the walk excludes the root itself).
 * @param callback - Receives the ordered pid list (children before parents).
 */
function enumerateDescendants(rootPid, callback) {
	const ps = spawn(
		'powershell',
		[
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
		],
		{ windowsHide: true }
	);
	let out = '';
	let done = false;
	const finish = () => {
		if (done) return;
		done = true;
		const children = new Map();
		for (const line of out.split(/\r?\n/)) {
			const parts = line.trim().split(/\s+/);
			if (parts.length !== 2) continue;
			const pid = Number(parts[0]);
			const ppid = Number(parts[1]);
			if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
			if (!children.has(ppid)) children.set(ppid, []);
			children.get(ppid).push(pid);
		}
		const ordered = [];
		const walk = (pid) => {
			for (const c of children.get(pid) || []) {
				walk(c);
				ordered.push(c); // children before parents — leaf-first
			}
		};
		walk(rootPid);
		callback(ordered);
	};
	ps.stdout.on('data', (chunk) => { out += chunk; });
	ps.on('exit', finish);
	ps.on('error', finish);
	setTimeout(finish, 2000);
}

/**
 * Fells the guard's own process tree, guard included — total by design:
 * the tether dropped, so nothing here may survive.
 */
function die() {
	if (dying) return;
	dying = true;
	if (process.platform === 'win32') {
		// STEP 1 — the syscall, before anything mortal: process.kill() is
		// TerminateProcess, a few microseconds, no subprocess. During an
		// editor-exit sweep the guard may only get microseconds — and on
		// the flattened primary spawn the child IS the dev server, so this
		// single syscall completes the tether even mid-slaughter.
		try { if (child.pid) process.kill(child.pid); } catch { /* already gone */ }
		if (!child.pid) {
			process.exit(1);
		}
		// STEP 2 — verified sweep of the subtree for the pnpm-exec fallback
		// chain (cmd -> pnpm -> cmd -> rsbuild), whose grandchildren the
		// direct kill cannot reach. Enumerate from the CHILD (the powershell
		// helper is OUR child, never inside that subtree), kill leaf-first
		// via direct syscalls, re-enumerate for stragglers, then exit.
		const killAll = (pids) => {
			for (const pid of pids) {
				try { process.kill(pid); } catch { /* already dead */ }
			}
		};
		enumerateDescendants(child.pid, (pids) => {
			killAll(pids);
			enumerateDescendants(child.pid, (rest) => {
				killAll(rest);
				process.exit(1);
			});
		});
		// Hard bound — an exited guard at least releases the pipes.
		setTimeout(() => process.exit(1), 5000);
	} else {
		// Group signal: the guard is the group leader, the child is in the
		// group — one SIGKILL fells both (kernel-atomic, no walk needed).
		try { process.kill(-process.pid, 'SIGKILL'); } catch { /* raced our own death */ }
		process.exit(1);
	}
}

// =============================================================================
// TETHER 1 — stdin EOF (event-driven owner-death signal)
// =============================================================================

// The extension host holds the write end of this pipe for as long as it
// lives; ANY death mode releases it and EOF arrives here. resume() starts
// the read so 'end' can fire.
process.stdin.resume();
process.stdin.on('end', die);
process.stdin.on('close', die);
process.stdin.on('error', die);

// =============================================================================
// TETHER 2 — owner-pid poll (backstop for exotic stdin situations)
// =============================================================================

if (Number.isFinite(ownerPid) && ownerPid > 0) {
	const poll = setInterval(() => {
		try {
			process.kill(ownerPid, 0);
		} catch {
			die();
		}
	}, 5000);
	// The poll must not keep the guard alive once the child exits.
	poll.unref();
}

// =============================================================================
// EXIT PASSTHROUGH — the guard IS the server to its spawner
// =============================================================================

child.on('exit', (code) => {
	if (!dying) process.exit(code == null ? 1 : code);
});
child.on('error', () => {
	if (!dying) process.exit(1);
});
