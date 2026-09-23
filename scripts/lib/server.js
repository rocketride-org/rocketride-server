/**
 * Test Server Utilities
 *
 * Provides functions to start/stop Python servers for testing.
 * Used by test tasks that need a running server.
 *
 * Usage:
 *   const { startServer, stopServer } = require('../../../scripts/lib');
 *
 *   // Start EAAS server
 *   const { server, port } = await startServer({ script: 'ai/eaas.py' });
 *
 *   // Start model server
 *   const { server, port } = await startServer({ script: '-m model_server' });
 *
 *   // ... run tests with port ...
 *   stopServer({ server });
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { exists } = require('./fs');
const { DIST_ROOT } = require('./paths');

const SERVER_DIR = path.join(DIST_ROOT, 'server');
const READY_MESSAGE = 'Application startup complete.';

// How many trailing output lines to retain from the server process. The server's
// output is otherwise only forwarded to the optional onOutput callback, which
// callers typically stop consuming once startup completes - so when the process
// dies mid-test-run its final output was previously lost. Bounded so a chatty
// server can't grow this without limit over a long run.
const OUTPUT_TAIL_LINES = 200;

/**
 * Snapshot whatever the OS will cheaply tell us about resource pressure.
 *
 * Only meaningful on Linux (and only there is it read); every read is guarded so
 * this can never throw on Windows/macOS, where the paths simply don't exist.
 * `memory.events` is the decisive one: its oom_kill counter is non-zero if the
 * cgroup OOM killer fired, which is otherwise invisible (SIGKILL leaves no trace
 * in the process's own output, and dmesg needs privileges we don't have in a
 * container).
 *
 * @returns {string[]} Human-readable lines, empty when nothing could be read
 */
function readResourcePressure() {
	if (process.platform !== 'linux') return [];

	const lines = [];
	const readFirst = (file, matcher) => {
		try {
			const content = fs.readFileSync(file, 'utf8');
			for (const line of content.split('\n')) {
				if (matcher.test(line)) lines.push(`${path.basename(file)}: ${line.trim()}`);
			}
		} catch {
			// Not present (non-cgroup-v2 host, different kernel, macOS/Windows) - skip.
		}
	};

	readFirst('/proc/meminfo', /^(MemTotal|MemAvailable|SwapFree):/);
	readFirst('/sys/fs/cgroup/memory.events', /^oom(_kill)?\s/);
	readFirst('/sys/fs/cgroup/memory.max', /./);
	readFirst('/sys/fs/cgroup/memory.current', /./);

	return lines;
}

/**
 * Try a bare TCP connect to one address, so we learn what a client would see.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} family 4 or 6
 * @returns {Promise<string>} 'connected', or the failing errno (e.g. ECONNREFUSED)
 */
function probeAddress(host, port, family) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(result);
		};
		const socket = net.connect({ host, port, family });
		socket.setTimeout(2000);
		socket.once('connect', () => finish('connected'));
		socket.once('timeout', () => finish('timeout'));
		socket.once('error', (err) => finish(err.code || 'error'));
	});
}

/**
 * Verify the port the server just advertised is actually reachable the way a
 * client will reach it, over both address families.
 *
 * The server binds whatever `--host` resolves to, and that default is the *name*
 * `localhost` - so in an environment where localhost prefers IPv6 the listener
 * can end up on ::1 while Node's client dials 127.0.0.1 and gets an instant
 * ECONNREFUSED from a perfectly healthy server. That failure is otherwise
 * indistinguishable from "the server died", so measure it rather than infer it.
 *
 * @param {number} port
 * @returns {Promise<{ipv4: string, ipv6: string, reachable: boolean}>}
 */
async function probeReachability(port) {
	const [ipv4, ipv6] = await Promise.all([probeAddress('127.0.0.1', port, 4), probeAddress('::1', port, 6)]);
	return { ipv4, ipv6, reachable: ipv4 === 'connected' || ipv6 === 'connected' };
}

/**
 * Describe how a process exited, in terms that distinguish the cases we care about.
 *
 * Node reports (code, signal); on Windows signal is always null and abnormal
 * termination shows up as a large code instead, so both are reported raw and the
 * interpretation is additive rather than assumed.
 *
 * @param {number|null} code
 * @param {string|null} signal
 * @returns {string}
 */
function describeExit(code, signal) {
	const parts = [`code=${code === null ? 'null' : code}`, `signal=${signal || 'none'}`];

	// SIGKILL is what the Linux/macOS OOM killer uses, and it's indistinguishable
	// from a deliberate `kill -9` - so flag it as a hint, not a conclusion.
	if (signal === 'SIGKILL' || code === 137) {
		parts.push('(SIGKILL/137 - consistent with an OOM kill or an external kill -9)');
	} else if (signal) {
		parts.push(`(terminated by signal ${signal})`);
	} else if (code !== 0 && code !== null) {
		parts.push('(exited non-zero on its own)');
	}

	return parts.join(' ');
}

/**
 * Start a Python server using the engine executable
 *
 * Waits indefinitely for the server to emit "Application startup complete."
 * This is necessary because server startup time is unpredictable - it may need
 * to install Python dependencies, download models, etc. The server will still
 * fail fast if the process exits unexpectedly or encounters an error.
 *
 * @param {Object} options - Options
 * @param {string} options.script - Python script to run (relative to dist/server), e.g. 'ai/eaas.py'
 * @param {number} [options.port] - Use existing server on this port (skip starting)
 * @param {Function} [options.onOutput] - Callback for server output (for logging)
 * @param {string[]} [options.trace] - Trace categories to enable (passed as --trace=a,b,c)
 * @param {number} [options.basePort] - Base port for task allocation
 * @param {string[]} [options.args] - Additional arguments to pass to the script
 * @returns {Promise<{server: ChildProcess|null, port: number, diagnostics?: object}>}
 *   `diagnostics` (also reachable as `server.rocketrideDiagnostics`) carries the
 *   retained output tail and, once it exits, the exit code/signal. If the server
 *   dies after reporting ready without stopServer being called, that is reported
 *   to stderr at the moment of death.
 */
async function startServer(options) {
	const { script, port: existingPort, onOutput, trace, basePort, args = [], env = {} } = options;

	if (!script) {
		throw new Error('startServer: script is required');
	}

	// If a port is specified, use existing server (don't start one)
	if (existingPort) {
		return { server: null, port: existingPort };
	}

	const serverExe = path.join(SERVER_DIR, process.platform === 'win32' ? 'engine.exe' : 'engine');

	if (!(await exists(serverExe))) {
		throw new Error(`Server not found at ${serverExe}. Run: builder build:server`);
	}

	// Build server arguments (split script in case it has flags like '-m module')
	// --autoterm enables stdin monitoring - server exits when parent process dies
	// --port=0 lets the OS assign a free port; we parse the actual port from
	// Uvicorn's stdout to avoid the race between findFreePort() releasing the
	// port and the engine binding to it (same pattern as engine-manager.ts).
	// --host=127.0.0.1 is deliberate: never bind the *name* 'localhost'. Where it
	// resolves to both ::1 and 127.0.0.1 (any container - a bare host usually maps
	// only IPv4), asyncio binds one socket per address family and --port=0 gives
	// each its own ephemeral port, while only the first socket's port is logged.
	// We parse that port and hand it to the tests, so whenever IPv6 sorts first
	// the tests dial a port nothing listens on over IPv4 and every request fails
	// with ECONNREFUSED against a healthy engine.
	const scriptArgs = script.split(/\s+/);
	const serverArgs = ['--autoterm', ...scriptArgs, '--host=127.0.0.1', '--port=0', ...args];
	if (basePort) {
		serverArgs.push(`--base_port=${basePort}`);
	}
	if (trace?.length) {
		serverArgs.push(`--trace=${trace.join(',')}`);
	}

	return new Promise((resolve, reject) => {
		const serverProcess = spawn(serverExe, serverArgs, {
			cwd: SERVER_DIR,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, ...env },
		});

		let resolved = false;
		let outputBuffer = '';
		let actualPort = null;

		// Diagnostics travel on the ChildProcess itself so stopServer (and any
		// caller holding only `server`) can reach them without an API change.
		const diagnostics = {
			exited: false,
			code: null,
			signal: null,
			/** Set by stopServer, so an exit during teardown isn't reported as a death. */
			stopRequested: false,
			outputTail: [],
			port: null,
		};
		serverProcess.rocketrideDiagnostics = diagnostics;

		const recordOutput = (text) => {
			for (const line of text.split('\n')) {
				if (!line.trim()) continue;
				diagnostics.outputTail.push(line);
				if (diagnostics.outputTail.length > OUTPUT_TAIL_LINES) diagnostics.outputTail.shift();
			}
		};

		// Parse the actual bound port from Uvicorn's startup line, then wait
		// for the full "Application startup complete." readiness message.
		const portRegex = /Uvicorn running on https?:\/\/[\w.]+:(\d+)/;

		const checkReady = (data) => {
			const text = data.toString();
			outputBuffer += text;

			// Retain the tail unconditionally. Callers typically stop consuming
			// onOutput once the server is ready, so this is the only thing that
			// preserves the server's final output when it dies mid-run.
			recordOutput(text);

			// Always forward output if callback provided
			if (onOutput) {
				onOutput(text);
			}

			// Extract port from Uvicorn's binding message
			if (!actualPort) {
				const match = outputBuffer.match(portRegex);
				if (match) {
					actualPort = parseInt(match[1], 10);
				}
			}

			if (!resolved && actualPort && outputBuffer.includes(READY_MESSAGE)) {
				resolved = true;
				diagnostics.port = actualPort;

				// The server says it's listening; confirm it before handing the port
				// to tests. "Ready but unreachable" otherwise shows up only as every
				// client connection being refused, far from the cause.
				probeReachability(actualPort).then((reach) => {
					diagnostics.reachability = reach;

					if (!reach.reachable) {
						console.error(['', '='.repeat(78), `SERVER READY BUT UNREACHABLE on port ${actualPort} (${script})`, `  IPv4 127.0.0.1:${actualPort} -> ${reach.ipv4}`, `  IPv6      [::1]:${actualPort} -> ${reach.ipv6}`, '  The process is alive and reported startup, but nothing accepts', '  connections. Every client dial will fail with ECONNREFUSED.', `  Last ${Math.min(diagnostics.outputTail.length, 40)} line(s) of server output:`, ...diagnostics.outputTail.slice(-40).map((l) => `    ${l}`), '='.repeat(78), ''].join('\n'));
					} else if (reach.ipv4 !== 'connected') {
						// Reachable over IPv6 but NOT IPv4. Clients here dial 127.0.0.1,
						// so this is the asymmetry that actually bites. IPv4-only is the
						// normal healthy case and is deliberately silent.
						console.error(`[server] WARNING: port ${actualPort} is reachable over IPv6 but NOT IPv4 (IPv4=${reach.ipv4}). Clients dialing 127.0.0.1 will get ECONNREFUSED.`);
					}

					resolve({ server: serverProcess, port: actualPort, diagnostics });
				});
			}
		};

		serverProcess.stdout.on('data', checkReady);
		serverProcess.stderr.on('data', checkReady);

		serverProcess.on('error', (err) => {
			if (!resolved) {
				resolved = true;
				reject(err);
			}
		});

		serverProcess.on('exit', (code, signal) => {
			diagnostics.exited = true;
			diagnostics.code = code;
			diagnostics.signal = signal;

			if (!resolved) {
				resolved = true;
				reject(new Error(`Server exited unexpectedly with ${describeExit(code, signal)}. Script: ${script}`));
				return;
			}

			// Exited *after* it was reported ready. If we didn't ask it to stop,
			// the server died under us - every subsequent client connection will
			// fail with ECONNREFUSED, which is otherwise the only symptom visible
			// in CI. Report it loudly and immediately, at the moment of death, so
			// the cause is adjacent to the effect in the log.
			if (diagnostics.stopRequested) return;

			const detail = ['', '='.repeat(78), `SERVER DIED UNEXPECTEDLY after reporting ready (${script})`, `  ${describeExit(code, signal)}`, `  port=${diagnostics.port ?? 'unknown'} pid=${serverProcess.pid}`, '  All subsequent client connections will fail with ECONNREFUSED.'];

			const pressure = readResourcePressure();
			if (pressure.length) {
				detail.push('  Resource pressure at time of death:');
				for (const line of pressure) detail.push(`    ${line}`);
			}

			if (diagnostics.outputTail.length) {
				detail.push(`  Last ${Math.min(diagnostics.outputTail.length, 40)} line(s) of server output:`);
				for (const line of diagnostics.outputTail.slice(-40)) detail.push(`    ${line}`);
			} else {
				detail.push('  Server produced no output before dying.');
			}

			detail.push('='.repeat(78), '');
			console.error(detail.join('\n'));
		});
	});
}

/**
 * Stop the test server
 *
 * Uses graceful shutdown by closing stdin. When --autoterm is specified,
 * the engine monitors stdin and exits automatically when it closes.
 * This is cleaner than taskkill and avoids accidentally killing sibling processes.
 *
 * Waits for the process to actually exit before resolving, ensuring clean
 * lifecycle and preventing callbacks from firing after teardown completes.
 *
 * @param {{server: ChildProcess|null}} serverObj - Server object from startServer
 * @param {number} [timeout=5000] - Timeout in ms to wait for graceful shutdown before force kill
 * @returns {Promise<void>} Resolves when the server has exited
 */
async function stopServer(serverObj, timeout = 5000) {
	// Skip if no server object or if server is null (using existing server)
	if (!serverObj || !serverObj.server) return;

	const serverProcess = serverObj.server;
	const diagnostics = serverProcess.rocketrideDiagnostics;

	// Mark before any exit can happen, so the 'exit' handler treats what follows
	// as a requested shutdown rather than a death.
	if (diagnostics) diagnostics.stopRequested = true;

	// If already exited, nothing to do - but if it exited without us asking, say
	// so here too: teardown is where a caller that missed the live report looks.
	if (serverProcess.killed || serverProcess.exitCode !== null) {
		if (diagnostics && diagnostics.exited && diagnostics.code !== 0) {
			console.error(`[server] NOTE: server was already gone at teardown - ${describeExit(diagnostics.code, diagnostics.signal)}`);
		}
		return;
	}

	return new Promise((resolve) => {
		let resolved = false;

		// Resolve when process exits
		const onExit = () => {
			if (!resolved) {
				resolved = true;
				resolve();
			}
		};

		serverProcess.on('exit', onExit);
		serverProcess.on('close', onExit);

		try {
			// Close stdin to trigger graceful shutdown
			// Engine monitors stdin and exits when it closes (default behavior)
			if (serverProcess.stdin) {
				serverProcess.stdin.end();
			}
		} catch {
			// Ignore stdin errors
		}

		// Force kill after timeout if still running
		setTimeout(() => {
			if (!resolved) {
				try {
					if (!serverProcess.killed) {
						serverProcess.kill('SIGKILL');
					}
				} catch {
					// Ignore - process may have already exited
				}
				// Resolve anyway after force kill attempt
				if (!resolved) {
					resolved = true;
					resolve();
				}
			}
		}, timeout);
	});
}

/**
 * Parse a server address string into host, port, and full URI.
 *
 * Accepts two formats:
 *   - Bare port: "5565" → { host: 'localhost', port: 5565, uri: 'http://localhost:5565' }
 *   - Host:port: "myhost:5590" → { host: 'myhost', port: 5590, uri: 'http://myhost:5590' }
 *
 * @param {string|number} value - The address to parse
 * @returns {{ host: string, port: number, uri: string }}
 */
function parseServerAddress(value) {
	const s = String(value);
	// Bare port number
	if (/^\d+$/.test(s)) {
		const port = parseInt(s, 10);
		return { host: 'localhost', port, uri: `http://localhost:${port}` };
	}
	// host:port
	const idx = s.lastIndexOf(':');
	if (idx === -1) {
		throw new Error(`Invalid server address: "${s}" (expected port or host:port)`);
	}
	const host = s.substring(0, idx);
	const port = parseInt(s.substring(idx + 1), 10);
	if (isNaN(port)) {
		throw new Error(`Invalid port in server address: "${s}"`);
	}
	return { host, port, uri: `http://${host}:${port}` };
}

module.exports = {
	startServer,
	stopServer,
	parseServerAddress,
};
