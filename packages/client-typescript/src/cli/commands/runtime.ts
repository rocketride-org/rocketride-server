/**
 * CLI commands for runtime management.
 *
 * Registered as `rocketride runtime <command>` (alias `rocketride r <command>`).
 *
 * Commands:
 *   list                    List tracked runtime instances
 *   start [id]              Start a runtime instance
 *   stop <id>               Stop a running runtime instance
 *   install [version]       Download a runtime binary
 *   delete <id>             Stop and deregister a runtime instance (--purge to remove binary)
 *   logs <id>               Tail runtime log output
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { logsDir } from '../../client/runtime/paths.js';
import { StateDB, InstanceRecord, isRuntimeProcess, getProcessMemory } from '../../client/runtime/state.js';
import { DockerRuntime } from '../../client/runtime/docker.js';
import { RuntimeService } from '../../client/runtime/service.js';
import { getCompatRange } from '../../client/runtime/resolver.js';

// ── UI helpers ──────────────────────────────────────────────────────

function printProgress(msg: string): void {
	process.stdout.write(`\r\x1b[K${msg}`);
}

function endProgress(msg: string): void {
	process.stdout.write(`\r\x1b[K${msg}\n`);
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Command registration ────────────────────────────────────────────

export function registerRuntimeCommand(program: Command): void {
	const runtime = program.command('runtime').alias('r').description('Manage runtime instances');

	runtime
		.command('list')
		.description('List tracked runtime instances')
		.action(async () => {
			await cmdList();
		});

	runtime
		.command('start [id]')
		.description('Start a runtime instance')
		.option('--port <port>', 'Explicit port (default: auto)', parseInt)
		.option('--version <version>', 'Runtime version to use')
		.action(async (id, opts) => {
			const code = await cmdStart(id ?? null, opts.port ?? null, opts.version ?? null);
			if (code === 0) {
				console.log();
				await cmdList();
			}
			process.exit(code);
		});

	runtime
		.command('stop <id>')
		.description('Stop a running runtime instance')
		.action(async (id) => {
			const code = await cmdStop(id);
			if (code === 0) {
				console.log();
				await cmdList();
			}
			process.exit(code);
		});

	runtime
		.command('install [version]')
		.description('Download a runtime binary')
		.option('--force', 'Skip compatibility check')
		.option('--local', 'Install as Local type (manual start/stop)')
		.option('--docker', 'Pull and run as a Docker container')
		.option('--port <port>', 'Explicit host port for Docker installs', parseInt)
		.option('--new', 'Create a new instance even if one exists for this version')
		.action(async (version, opts) => {
			if (opts.local && opts.docker) {
				console.log('--local and --docker are mutually exclusive');
				process.exit(1);
			}
			const code = await cmdInstall(version ?? null, opts.force ?? false, opts.local ?? false, opts.docker ?? false, opts.port ?? null, opts.new ?? false);
			if (code === 0) {
				console.log();
				await cmdList();
			}
			process.exit(code);
		});

	runtime
		.command('delete <id>')
		.description('Stop and remove a runtime instance')
		.option('--purge', 'Also remove the runtime binary (or Docker image) from disk')
		.action(async (id, opts) => {
			const code = await cmdDelete(id, opts.purge ?? false);
			console.log();
			await cmdList();
			process.exit(code);
		});

	runtime
		.command('versions')
		.description('List available runtime versions')
		.option('--prerelease', 'Include pre-release versions')
		.action(async (opts) => {
			const code = await cmdVersions(opts.prerelease ?? false);
			process.exit(code);
		});

	runtime
		.command('logs <id>')
		.description('Tail runtime log output')
		.action(async (id) => {
			const code = await cmdLogs(id);
			process.exit(code);
		});
}

// ── Command handlers ────────────────────────────────────────────────

async function cmdList(): Promise<number> {
	const db = new StateDB();
	db.open();
	let instances: InstanceRecord[];
	try {
		instances = db.getAll();
	} finally {
		db.close();
	}

	const useColor = process.stdout.isTTY ?? false;

	// Brand palette
	const HORIZON = useColor ? '\x1b[38;2;65;182;230m' : '';
	const AMETHYST = useColor ? '\x1b[38;2;95;33;103m' : '';
	const GREEN = useColor ? '\x1b[38;2;80;220;100m' : '';
	const RED = useColor ? '\x1b[38;2;220;80;80m' : '';
	const DIM = useColor ? '\x1b[2m' : '';
	const BOLD = useColor ? '\x1b[1m' : '';
	const RESET = useColor ? '\x1b[0m' : '';
	const GRAY = useColor ? '\x1b[38;2;100;100;100m' : '';

	const colNames = ['version', 'id', 'pid', 'port', 'type', 'status', 'restarted', 'uptime', 'memory'] as const;
	const minWidths: Record<string, number> = {
		version: 7,
		id: 2,
		pid: 3,
		port: 4,
		type: 6,
		status: 6,
		restarted: 9,
		uptime: 6,
		memory: 6,
	};

	const now = Date.now();
	let dockerRuntime: DockerRuntime | null = null;

	type Row = Record<string, string | [string, string]>;
	const rows: Row[] = [];

	for (const inst of instances) {
		const pid = inst.pid;
		const instType = inst.type || 'Local';
		let alive: boolean;
		let statusText: string;

		if (instType === 'Docker') {
			if (!dockerRuntime) dockerRuntime = new DockerRuntime();
			try {
				const ds = dockerRuntime.getStatus(inst.id);
				alive = ds.state === 'running';
				statusText = ds.state;
			} catch {
				alive = false;
				statusText = 'unknown';
			}
		} else {
			alive = isRuntimeProcess(pid);
			statusText = alive ? 'running' : 'stopped';
		}

		const statusColor = alive ? GREEN : RED;

		// Uptime
		let uptime = '0s';
		if (alive) {
			try {
				const started = new Date(inst.started_at).getTime();
				const totalSecs = Math.floor((now - started) / 1000);
				if (totalSecs < 60) uptime = `${totalSecs}s`;
				else if (totalSecs < 3600) uptime = `${Math.floor(totalSecs / 60)}m`;
				else if (totalSecs < 86400) uptime = `${Math.floor(totalSecs / 3600)}h ${Math.floor((totalSecs % 3600) / 60)}m`;
				else uptime = `${Math.floor(totalSecs / 86400)}d ${Math.floor((totalSecs % 86400) / 3600)}h`;
			} catch {
				uptime = '-';
			}
		}

		// Memory
		let memory = '-';
		if (instType !== 'Docker') {
			const memBytes = alive ? getProcessMemory(pid) : null;
			if (memBytes !== null) {
				memory = formatSize(memBytes);
			}
		}

		rows.push({
			version: inst.version,
			id: inst.id,
			pid: pid ? String(pid) : '-',
			port: inst.port ? String(inst.port) : '-',
			type: instType,
			status: [statusColor, statusText],
			restarted: String(inst.restart_count ?? 0),
			uptime,
			memory,
		});
	}

	// Compute column widths
	const colWidths: Record<string, number> = {};
	for (const name of colNames) {
		colWidths[name] = Math.max(minWidths[name], name.length);
	}
	for (const row of rows) {
		for (const name of colNames) {
			const val = row[name];
			const text = Array.isArray(val) ? val[1] : (val as string);
			colWidths[name] = Math.max(colWidths[name], text.length);
		}
	}

	const cols = colNames.map((name) => ({ name, width: colWidths[name] }));

	if (useColor) {
		const B = GRAY;
		const hRule = (left: string, mid: string, right: string) => {
			const segments = cols.map((c) => '\u2500'.repeat(c.width + 2));
			return `${B}${left}${segments.join(mid)}${right}${RESET}`;
		};

		const top = hRule('\u250c', '\u252c', '\u2510');
		const sep = hRule('\u251c', '\u253c', '\u2524');
		const bot = hRule('\u2514', '\u2534', '\u2518');

		const headerCells = cols.map((c) => ` ${BOLD}${HORIZON}${c.name.toUpperCase().padEnd(c.width)}${RESET} `);
		const header = `${B}\u2502${RESET}${headerCells.join(`${B}\u2502${RESET}`)}${B}\u2502${RESET}`;

		console.log(`${AMETHYST}${BOLD} RocketRide${RESET} ${DIM}Runtime instances${RESET}`);
		console.log(top);
		console.log(header);

		if (instances.length === 0) {
			console.log(bot);
			return 0;
		}

		console.log(sep);

		for (const row of rows) {
			const cells = cols.map((c) => {
				const val = row[c.name];
				if (Array.isArray(val)) {
					const [color, text] = val;
					return ` ${color}${text.padEnd(c.width)}${RESET} `;
				}
				return ` ${(val as string).padEnd(c.width)} `;
			});
			console.log(`${B}\u2502${RESET}${cells.join(`${B}\u2502${RESET}`)}${B}\u2502${RESET}`);
		}

		console.log(bot);
	} else {
		// Plain text
		console.log(cols.map((c) => c.name.toUpperCase().padEnd(c.width)).join('  '));
		if (instances.length === 0) return 0;
		for (const row of rows) {
			const parts = cols.map((c) => {
				const val = row[c.name];
				const text = Array.isArray(val) ? val[1] : (val as string);
				return text.padEnd(c.width);
			});
			console.log(parts.join('  '));
		}
	}

	return 0;
}

async function cmdStart(instanceId: string | null, explicitPort: number | null, versionArg: string | null): Promise<number> {
	const service = new RuntimeService();
	try {
		const inst = await service.start(instanceId, {
			port: explicitPort ?? undefined,
			version: versionArg ?? undefined,
			onProgress: (msg) => printProgress(msg),
		});
		endProgress(`Runtime v${inst.version} is online (port ${inst.port}, PID ${inst.pid})`);
		return 0;
	} catch (e) {
		endProgress('');
		console.log(String((e as Error).message ?? e));
		return 1;
	}
}

async function cmdStop(instanceId: string): Promise<number> {
	const service = new RuntimeService();
	try {
		console.log(`Stopping runtime ${instanceId}...`);
		await service.stop(instanceId);
		console.log('Stopped.');
		return 0;
	} catch (e) {
		console.log(String((e as Error).message ?? e));
		return 1;
	}
}

async function cmdInstall(versionArg: string | null, force: boolean, useLocal: boolean, useDocker: boolean, explicitPort: number | null, allowNew: boolean): Promise<number> {
	const instType = useDocker ? 'Docker' : useLocal ? 'Local' : 'Service';
	const service = new RuntimeService();
	try {
		const inst = await service.install({
			version: versionArg ?? undefined,
			type: instType,
			force,
			port: explicitPort ?? undefined,
			allowDuplicate: allowNew,
			onProgress: (msg) => {
				// Download progress uses \r, others use newline
				if (msg.includes('Downloading') || msg.includes('Extracting')) {
					printProgress(msg);
				} else {
					endProgress(msg);
				}
			},
		});
		endProgress(`Installed runtime v${inst.version} (id: ${inst.id})`);
		return 0;
	} catch (e) {
		endProgress('');
		console.log(String((e as Error).message ?? e));
		return 1;
	}
}

async function cmdDelete(instanceId: string, purge: boolean): Promise<number> {
	const service = new RuntimeService();
	try {
		await service.delete(instanceId, {
			purge,
			onProgress: (msg) => console.log(msg),
		});
		return 0;
	} catch (e) {
		console.log(String((e as Error).message ?? e));
		return 1;
	}
}

async function cmdVersions(includePrerelease: boolean): Promise<number> {
	const service = new RuntimeService();
	try {
		const versions = await service.listVersions({ includePrerelease });

		const useColor = process.stdout.isTTY ?? false;
		const BOLD = useColor ? '\x1b[1m' : '';
		const GREEN = useColor ? '\x1b[38;2;80;220;100m' : '';
		const DIM = useColor ? '\x1b[2m' : '';
		const RESET = useColor ? '\x1b[0m' : '';

		const compat = getCompatRange();
		console.log(`${BOLD}RocketRide Runtime Versions${RESET} ${DIM}(compatible: ${compat})${RESET}\n`);

		if (versions.length === 0) {
			console.log('  No compatible versions found.');
			return 0;
		}

		// Build rows
		const header = ['VERSION', 'STATUS'];
		const rows: string[][] = [];

		for (const v of versions) {
			const parts: string[] = [];
			if (v.instances.length > 0) {
				for (const inst of v.instances) {
					const status = inst.running ? 'running' : 'stopped';
					parts.push(`${status} (id: ${inst.id}${inst.running ? `, port ${inst.port}` : ''})`);
				}
			} else if (v.installed) {
				parts.push('installed');
			} else {
				parts.push('available');
			}
			rows.push([v.version, parts.join(', ')]);
		}

		// Compute widths
		const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));

		console.log(`  ${header.map((h, i) => `${BOLD}${h.padEnd(widths[i])}${RESET}`).join('    ')}`);
		for (const row of rows) {
			const versionStr = row[0].padEnd(widths[0]);
			const statusStr = row[1];
			const isInstalled = statusStr.includes('installed') || statusStr.includes('running') || statusStr.includes('stopped');
			const color = isInstalled ? GREEN : DIM;
			console.log(`  ${versionStr}    ${color}${statusStr}${RESET}`);
		}

		return 0;
	} catch (e) {
		console.log(String((e as Error).message ?? e));
		return 1;
	}
}

async function cmdLogs(instanceId: string): Promise<number> {
	const logFile = join(logsDir(instanceId), 'stdout.log');

	if (!existsSync(logFile)) {
		console.log(`No log file found for instance ${instanceId}`);
		return 1;
	}

	console.log(`Tailing ${logFile} (Ctrl+C to stop)\n`);

	let stopped = false;
	const originalHandler = process.listeners('SIGINT')[0] as (() => void) | undefined;
	const stopHandler = () => {
		stopped = true;
	};
	process.removeAllListeners('SIGINT');
	process.on('SIGINT', stopHandler);

	try {
		let pos = 0;

		// Print existing content
		const content = readFileSync(logFile, 'utf-8');
		if (content) {
			process.stdout.write(content);
			pos = content.length;
		}

		// Tail new content
		while (!stopped) {
			try {
				const current = readFileSync(logFile, 'utf-8');
				if (current.length > pos) {
					process.stdout.write(current.slice(pos));
					pos = current.length;
				}
			} catch {
				// File may be temporarily unavailable
			}
			await sleep(200);
		}
	} finally {
		process.removeAllListeners('SIGINT');
		if (originalHandler) process.on('SIGINT', originalHandler);
	}

	console.log();
	return 0;
}
