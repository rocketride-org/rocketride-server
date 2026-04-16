/**
 * Runtime process spawn and teardown.
 *
 * Manages the runtime subprocess lifecycle: start, health-check, stop.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, openSync, readFileSync, closeSync } from 'fs';
import { dirname, join } from 'path';
import { RuntimeManagementError } from '../exceptions/index.js';
import { logsDir } from './paths.js';
import { isPidAlive } from './state.js';

/**
 * Start the runtime binary as a fully detached subprocess.
 *
 * Redirects stdout/stderr to log files under ~/.rocketride/logs/{id}/.
 * Returns the process pid.
 */
export function spawnRuntime(binaryPath: string, port: number, instanceId: string): number {
	const logDir = logsDir(instanceId);
	mkdirSync(logDir, { recursive: true });

	const stdoutLog = join(logDir, 'stdout.log');
	const stderrLog = join(logDir, 'stderr.log');

	const script = join(dirname(binaryPath), 'ai', 'eaas.py');
	const cwd = dirname(binaryPath);

	if (process.platform === 'win32') {
		// CreateProcessW with CREATE_NO_WINDOW prevents console allocation
		// entirely. Node.js spawn() only uses SW_HIDE which still creates a
		// hidden console — child processes (torch → nvidia-smi) flash.
		try {
			const win32: typeof import('./win32.js') = require('./win32.js');
			process.env.PYTHONUNBUFFERED = '1';
			return win32.spawnProcessHidden(binaryPath, [script, '--port', String(port)], cwd, stdoutLog, stderrLog);
		} catch (e) {
			if (e instanceof RuntimeManagementError) throw e;
			throw new RuntimeManagementError(`Failed to start runtime: ${e}`);
		}
	}

	const env = { ...process.env, PYTHONUNBUFFERED: '1' };
	const stdoutFd = openSync(stdoutLog, 'w');
	const stderrFd = openSync(stderrLog, 'w');

	try {
		const child = spawn(binaryPath, [script, '--port', String(port)], {
			stdio: ['ignore', stdoutFd, stderrFd],
			env,
			cwd,
			detached: true,
		});

		child.unref();

		const pid = child.pid;
		if (pid === undefined) {
			throw new RuntimeManagementError('Failed to start runtime: no PID returned');
		}

		return pid;
	} catch (e) {
		throw new RuntimeManagementError(`Failed to start runtime: ${e}`);
	} finally {
		closeSync(stdoutFd);
		closeSync(stderrFd);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stop a runtime process by pid.
 *
 * Sends SIGTERM (Unix) or taskkill (Windows), waits up to timeout ms,
 * then escalates to SIGKILL if still running.
 */
export async function stopRuntime(pid: number, timeout: number = 10000): Promise<void> {
	if (process.platform === 'win32') {
		const win32: typeof import('./win32.js') = require('./win32.js');
		win32.terminateProcessTree(pid, timeout);
		return;
	}

	// Unix: SIGTERM then SIGKILL
	try {
		process.kill(pid, 'SIGTERM');
	} catch {
		return; // Already gone
	}

	const iterations = Math.floor(timeout / 100);
	for (let i = 0; i < iterations; i++) {
		if (!isPidAlive(pid)) return;
		await sleep(100);
	}

	// Still alive — escalate
	try {
		process.kill(pid, 'SIGKILL');
	} catch {
		// Already gone
	}
}

/**
 * Poll the runtime's HTTP endpoint until it responds.
 *
 * If pid is provided, checks that the process is still alive each
 * iteration — exits immediately if the runtime crashes.
 */
export async function waitHealthy(port: number, pid: number = 0, timeout: number = 600000, onStatus?: (elapsed: number) => void): Promise<void> {
	const url = `http://127.0.0.1:${port}`;
	const start = Date.now();
	const deadline = start + timeout;

	while (Date.now() < deadline) {
		const elapsed = (Date.now() - start) / 1000;
		if (onStatus) onStatus(elapsed);

		if (pid && !isPidAlive(pid)) {
			throw new RuntimeManagementError(`Runtime process (PID ${pid}) exited before becoming healthy`);
		}

		try {
			const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
			if (resp.ok) return;
		} catch {
			// Not ready yet
		}
		await sleep(500);
	}

	throw new RuntimeManagementError(`Runtime on port ${port} did not become healthy within ${timeout / 1000}s`);
}

const READY_PATTERN = /Uvicorn running on https?:\/\/[\w.]+:(\d+)/;

/**
 * Wait for the runtime to emit the Uvicorn ready line in its log file.
 *
 * Tails logFile in a tight loop (50ms between reads). Each new line is
 * forwarded to onOutput and checked against READY_PATTERN.
 */
export async function waitReady(pid: number, logFile: string, timeout: number = 600000, onOutput?: (line: string) => void): Promise<void> {
	const deadline = Date.now() + timeout;
	let filePos = 0;
	let buf = '';

	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) {
			throw new RuntimeManagementError(`Runtime process (PID ${pid}) exited before becoming ready`);
		}

		if (existsSync(logFile)) {
			try {
				const content = readFileSync(logFile, 'utf-8');
				if (content.length > filePos) {
					const newContent = content.slice(filePos);
					filePos = content.length;
					buf += newContent;

					while (buf.includes('\n')) {
						const idx = buf.indexOf('\n');
						const line = buf.slice(0, idx);
						buf = buf.slice(idx + 1);
						if (onOutput) onOutput(line);
						if (READY_PATTERN.test(line)) return;
					}
				}
			} catch {
				// File not ready yet
			}
		}

		await sleep(50);
	}

	throw new RuntimeManagementError(`Runtime (PID ${pid}) did not become ready within ${timeout / 1000}s`);
}
