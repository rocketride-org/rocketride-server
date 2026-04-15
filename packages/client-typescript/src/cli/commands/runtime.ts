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
import { existsSync, readFileSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { satisfies, valid as semverValid, rcompare } from 'semver';

import { downloadRuntime } from '../../client/runtime/downloader.js';
import { rocketrideHome, runtimesDir, runtimeBinary, logsDir } from '../../client/runtime/paths.js';
import { normalizeVersion } from '../../client/runtime/platform.js';
import { findAvailablePort } from '../../client/runtime/ports.js';
import { spawnRuntime, stopRuntime, waitReady } from '../../client/runtime/process.js';
import { getCompatRange, resolveCompatibleVersion, resolveDockerTag } from '../../client/runtime/resolver.js';
import { StateDB, InstanceRecord, isPidAlive, isRuntimeProcess, getProcessMemory } from '../../client/runtime/state.js';
import { DockerRuntime } from '../../client/runtime/docker.js';

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
		.action(async (version, opts) => {
			if (opts.local && opts.docker) {
				console.log('--local and --docker are mutually exclusive');
				process.exit(1);
			}
			const code = await cmdInstall(version ?? null, opts.force ?? false, opts.local ?? false, opts.docker ?? false, opts.port ?? null);
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
			if (code === 0) {
				console.log();
				await cmdList();
			}
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
	let version = versionArg ? normalizeVersion(versionArg) : null;

	const db = new StateDB();
	db.open();

	try {
		if (!instanceId && version) {
			const existing = db.findByVersion(version);
			if (existing) {
				instanceId = existing.id;
			} else {
				console.log(`No instance found for version ${version}.`);
				console.log('Use "rocketride runtime install" to create one first.');
				return 1;
			}
		} else if (!instanceId) {
			const all = db.getAll();
			if (all.length > 0) {
				instanceId = all[0].id;
			} else {
				console.log('No runtime instances found.');
				console.log('Use "rocketride runtime install" to create one first.');
				return 1;
			}
		}

		const existing = db.get(instanceId);
		if (!existing) {
			console.log(`No instance found with id: ${instanceId}`);
			console.log('Use "rocketride runtime install" to create a new instance first.');
			return 1;
		}

		// Refuse to start if already running
		if (existing.pid && isPidAlive(existing.pid)) {
			console.log(`Instance ${instanceId} is already running (PID ${existing.pid}, port ${existing.port})`);
			return 1;
		}

		const instType = existing.type || 'Local';

		// Docker start
		if (instType === 'Docker') {
			console.log(`Starting Docker runtime ${instanceId}...`);
			const docker = new DockerRuntime();
			let dockerPort = existing.port;
			try {
				docker.start(instanceId);
			} catch (e: unknown) {
				const msg = String(e);
				if (msg.includes('404') || msg.includes('No such container')) {
					console.log('Container was removed outside the CLI. Re-installing...');
					dockerPort = existing.port || (await findAvailablePort());
					try {
						docker.install(existing.version, instanceId, dockerPort);
					} catch (e2) {
						console.log(`Failed to re-install Docker container: ${e2}`);
						return 1;
					}
				} else {
					console.log(`Failed to start Docker container: ${e}`);
					return 1;
				}
			}
			db.register(instanceId, 0, dockerPort, existing.version, existing.owner, existing.restart_count ?? 0, 'running', 'Docker');
			console.log('Started.');
			return 0;
		}

		if (!version) version = existing.version;

		// Resolve version if still unknown
		if (!version) {
			const compat = getCompatRange();
			const runtimesRoot = join(rocketrideHome(), 'runtimes');
			const installed: Array<[string, string]> = [];
			if (existsSync(runtimesRoot)) {
				for (const entry of readdirSync(runtimesRoot)) {
					const entryPath = join(runtimesRoot, entry);
					try {
						if (!statSync(entryPath).isDirectory()) continue;
					} catch {
						continue;
					}
					if (!semverValid(entry)) continue;
					if (!satisfies(entry, compat)) continue;
					if (!existsSync(runtimeBinary(entry))) continue;
					installed.push([entry, entry]);
				}
			}
			if (installed.length > 0) {
				installed.sort((a, b) => rcompare(a[0], b[0]));
				version = installed[0][1];
				console.log(`Using installed runtime v${version}`);
			} else {
				console.log('No compatible runtime installed. Downloading...');
				version = await resolveCompatibleVersion(compat);
				await downloadRuntime(version);
				console.log(`Downloaded runtime v${version}`);
			}
		}

		const binary = runtimeBinary(version);
		if (!existsSync(binary)) {
			console.log(`Runtime binary not found for v${version}. Run: rocketride runtime install ${version}`);
			return 1;
		}

		const port = explicitPort ?? (await findAvailablePort());

		// Track restarts
		let restartCount = 0;
		const prevCount = existing.restart_count ?? 0;
		const logFile = join(logsDir(instanceId), 'stdout.log');
		const hasRunBefore = prevCount > 0 || existsSync(logFile);
		restartCount = hasRunBefore ? prevCount + 1 : 0;

		console.log(`Starting runtime v${version} on port ${port} (id: ${instanceId})...`);
		const pid = spawnRuntime(binary, port, instanceId);

		// Release the DB lock before waiting
		db.close();

		try {
			const stderrLog = join(logsDir(instanceId), 'stderr.log');
			await waitReady(pid, stderrLog, undefined, (line) => printProgress(`  ${line}`));
			endProgress(`Runtime v${version} is online (port ${port}, PID ${pid})`);

			const db2 = new StateDB();
			db2.open();
			try {
				db2.register(instanceId, pid, port, version, 'cli', restartCount, 'running');
			} finally {
				db2.close();
			}
			return 0;
		} catch (e) {
			console.log(`\nRuntime started but health check failed: ${e}`);
			await stopRuntime(pid);
			const db2 = new StateDB();
			db2.open();
			try {
				db2.register(instanceId, 0, 0, version, 'cli', restartCount, 'stopped');
			} finally {
				db2.close();
			}
			return 1;
		}
	} finally {
		// db may already be closed if we released it above
		try {
			db.close();
		} catch {
			/* already closed */
		}
	}
}

async function cmdStop(instanceId: string): Promise<number> {
	const db = new StateDB();
	db.open();
	try {
		const inst = db.get(instanceId);
		if (!inst) {
			console.log(`No instance found with id: ${instanceId}`);
			return 1;
		}

		const instType = inst.type || 'Local';

		if (instType === 'Docker') {
			console.log(`Stopping Docker runtime ${instanceId}...`);
			const docker = new DockerRuntime();
			try {
				docker.stop(instanceId);
			} catch (e) {
				console.log(`Failed to stop Docker container: ${e}`);
				return 1;
			}
			db.register(instanceId, 0, inst.port, inst.version, inst.owner, inst.restart_count ?? 0, 'stopped', 'Docker');
		} else {
			console.log(`Stopping runtime ${instanceId} (PID: ${inst.pid})...`);
			await stopRuntime(inst.pid);
			db.register(instanceId, 0, 0, inst.version, inst.owner, inst.restart_count ?? 0, 'stopped', instType);
		}

		console.log('Stopped.');
		return 0;
	} finally {
		db.close();
	}
}

async function cmdInstall(versionArg: string | null, force: boolean, useLocal: boolean, useDocker: boolean, explicitPort: number | null): Promise<number> {
	let version = versionArg ? normalizeVersion(versionArg) : null;

	const instType = useDocker ? 'Docker' : useLocal ? 'Local' : 'Service';

	// ── Docker install ──────────────────────────────────────────────
	if (useDocker) {
		const docker = new DockerRuntime();
		const dockerErr = docker.checkDockerStatus();
		if (dockerErr) {
			console.log(dockerErr);
			return 1;
		}

		const versionSpec = version || 'latest';
		console.log(`Resolving Docker image tag for "${versionSpec}"...`);
		const imageTag = await resolveDockerTag(versionSpec);

		const port = explicitPort ?? (await findAvailablePort());

		const db = new StateDB();
		db.open();
		try {
			const existingDocker = db.findByVersionAndType(imageTag, 'Docker');
			if (existingDocker) {
				console.log(`Docker runtime v${imageTag} is already installed (id: ${existingDocker.id})`);
				return 0;
			}
			const instanceId = db.nextId();

			console.log(`Installing Docker runtime (tag: ${imageTag}, port: ${port}, id: ${instanceId})`);
			try {
				docker.install(imageTag, instanceId, port, (msg) => {
					process.stdout.write(`\r${msg}`);
				});
				console.log(); // newline after progress
			} catch (e) {
				console.log(`\nDocker install failed: ${e}`);
				return 1;
			}

			db.register(instanceId, 0, port, imageTag, 'cli', 0, 'running', 'Docker');
			console.log(`Installed Docker runtime (id: ${instanceId})`);
			return 0;
		} finally {
			db.close();
		}
	}

	// ── Local / Service install ─────────────────────────────────────

	// Resolve keyword specs
	if (version === 'latest' || version === 'prerelease') {
		console.log(`Resolving ${version} version...`);
		version = await resolveDockerTag(version);
	}

	if (version) {
		const binary = runtimeBinary(version);
		const db = new StateDB();
		db.open();
		try {
			const existing = db.findByVersionAndType(version, instType);
			if (existsSync(binary) && existing) {
				console.log(`Runtime v${version} (${instType}) is already installed (id: ${existing.id})`);
				return 0;
			}
		} finally {
			db.close();
		}

		// Validate compat range (unless --force)
		if (!force) {
			const compat = getCompatRange();
			const baseV = version
				.replace(/-prerelease$/, '')
				.replace(/-beta$/, '')
				.replace(/-alpha$/, '')
				.replace(/-rc.*$/, '');
			if (semverValid(baseV) && !satisfies(baseV, compat)) {
				console.log(`Runtime v${version} is not compatible with this SDK (requires ${compat})`);
				console.log('Use --force to install anyway.');
				return 1;
			}
		}
	} else {
		console.log('Resolving latest compatible version...');
		const compat = getCompatRange();
		version = await resolveCompatibleVersion(compat);
	}

	const binary = runtimeBinary(version);
	if (!existsSync(binary)) {
		try {
			await downloadRuntime(version, {
				onProgress: (downloaded, total) => {
					const dlStr = formatSize(downloaded);
					if (total) {
						const pct = Math.floor((downloaded * 100) / total);
						const totalStr = formatSize(total);
						printProgress(`Downloading runtime v${version}... ${pct}% (${dlStr}/${totalStr})`);
					} else {
						printProgress(`Downloading runtime v${version}... ${dlStr}`);
					}
				},
				onPhase: (phase) => {
					if (phase === 'extracting') {
						endProgress(`Extracting runtime v${version}...`);
					}
				},
			});
		} catch (e) {
			endProgress('');
			console.log(`\n${e}`);
			return 1;
		}
	}

	// Register in state DB
	const db = new StateDB();
	db.open();
	let instanceId: string;
	try {
		const existing = db.findByVersionAndType(version, instType);
		instanceId = existing ? existing.id : db.nextId();
		db.register(instanceId, 0, 0, version, 'cli', 0, 'stopped', instType);
	} finally {
		db.close();
	}

	console.log(`Installed runtime v${version} (id: ${instanceId})`);

	// Service type auto-starts
	if (instType === 'Service') {
		const port = await findAvailablePort();
		console.log(`Starting service on port ${port}...`);
		const pid = spawnRuntime(binary, port, instanceId);
		try {
			const stderrLog = join(logsDir(instanceId), 'stderr.log');
			await waitReady(pid, stderrLog, undefined, (line) => printProgress(`  ${line}`));
			endProgress(`Runtime v${version} is online (port ${port}, PID ${pid})`);

			const db2 = new StateDB();
			db2.open();
			try {
				db2.register(instanceId, pid, port, version, 'cli', 0, 'running', 'Service');
			} finally {
				db2.close();
			}
		} catch (e) {
			console.log(`\nAuto-start failed: ${e}`);
			console.log(`Start manually: rocketride runtime start ${instanceId}`);
			await stopRuntime(pid);
			const db2 = new StateDB();
			db2.open();
			try {
				db2.register(instanceId, 0, 0, version, 'cli', 0, 'stopped', 'Service');
			} finally {
				db2.close();
			}
			return 1;
		}
	}

	return 0;
}

async function cmdDelete(instanceId: string, purge: boolean): Promise<number> {
	const db = new StateDB();
	db.open();
	try {
		let inst = db.get(instanceId);
		// Try as version string
		if (!inst) {
			inst = db.findByVersion(instanceId, true);
			if (inst) instanceId = inst.id;
		}
		if (!inst) {
			console.log(`No instance found with id or version: ${instanceId}`);
			return 1;
		}

		const pid = inst.pid;
		const version = inst.version;
		const instType = inst.type || 'Local';
		const alreadyDeleted = !!inst.deleted;

		const removeLogDir = async () => {
			const logDir = logsDir(instanceId);
			if (!existsSync(logDir)) return;
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					rmSync(logDir, { recursive: true, force: true });
					return;
				} catch {
					if (attempt < 4) await sleep(1000);
					else console.log(`Warning: could not remove ${logDir} — files may still be locked.`);
				}
			}
		};

		// ── Docker delete ───────────────────────────────────────────
		if (instType === 'Docker') {
			const docker = new DockerRuntime();
			if (purge) {
				console.log(`Purging Docker runtime ${instanceId}...`);
				try {
					docker.remove(instanceId, true);
				} catch (e) {
					console.log(`Failed to remove Docker container: ${e}`);
					return 1;
				}
				await removeLogDir();
				db.unregister(instanceId);
				console.log(`Purged Docker instance ${instanceId} (container and image removed).`);
			} else {
				if (alreadyDeleted) {
					console.log(`Instance ${instanceId} is already deleted. Use --purge to remove the image.`);
					return 0;
				}
				console.log(`Removing Docker runtime ${instanceId}...`);
				try {
					docker.remove(instanceId, false);
				} catch (e) {
					console.log(`Failed to remove Docker container: ${e}`);
					return 1;
				}
				await removeLogDir();
				db.softDelete(instanceId);
				console.log(`Deleted Docker instance ${instanceId} (container removed, image kept).`);
			}
			return 0;
		}

		// ── Local / Service delete ──────────────────────────────────
		if (purge) {
			// Stop if running
			if (pid && isPidAlive(pid)) {
				console.log(`Stopping running runtime ${instanceId}...`);
				await stopRuntime(pid);
			}

			// Check if other instances use same binary
			const allInstances = db.getAll();
			let versionInUse = false;
			for (const other of allInstances) {
				if (other.id === instanceId) continue;
				if (other.version === version && other.pid && isPidAlive(other.pid)) {
					versionInUse = true;
					break;
				}
			}

			// Remove binary directory
			const versionDir = runtimesDir(version);
			if (versionInUse) {
				console.log(`Keeping runtime v${version} binary (still in use by another instance).`);
			} else if (existsSync(versionDir)) {
				for (let attempt = 0; attempt < 5; attempt++) {
					try {
						rmSync(versionDir, { recursive: true, force: true });
						console.log(`Removed runtime v${version} from ${versionDir}`);
						break;
					} catch {
						if (attempt < 4) {
							await sleep(1000);
						} else {
							console.log(`Could not remove ${versionDir} — files may still be locked.`);
							console.log('The instance record has NOT been removed. Try again shortly.');
							return 1;
						}
					}
				}
			}

			await removeLogDir();
			db.unregister(instanceId);
			console.log(`Purged instance ${instanceId}.`);
		} else {
			// Soft delete
			if (alreadyDeleted) {
				console.log(`Instance ${instanceId} is already deleted. Use --purge to remove the binary.`);
				return 0;
			}

			if (pid && isPidAlive(pid)) {
				console.log(`Stopping running runtime ${instanceId}...`);
				await stopRuntime(pid);
			}

			await removeLogDir();
			db.softDelete(instanceId);
			console.log(`Deleted instance ${instanceId}.`);
		}

		return 0;
	} finally {
		db.close();
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
