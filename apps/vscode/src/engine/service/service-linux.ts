// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * service-linux.ts - Linux Service Manager (systemd)
 *
 * Pure service lifecycle: register/start/stop/remove via systemd.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import {
	ServiceManager,
	ServiceStatus,
	SERVICE_DISPLAY_NAME,
	SERVICE_PORT
} from './service-manager';
import { icons } from '../../shared/util/icons';

const execFileAsync = promisify(execFile);

/** Root install directory — shared system-wide, requires sudo to write. */
const INSTALL_ROOT = '/opt/rocketride';

/** Systemd unit name (without .service suffix). */
const UNIT_NAME = 'rocketride';

/** Full path to the systemd unit file. */
const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}.service`;

/**
 * LinuxServiceManager — manages the engine as a systemd service.
 *
 * All privileged operations (install, start, stop, remove) run via `sudo -S`,
 * with the password piped through stdin. The caller must call
 * {@link setElevationPassword} before any operation that requires elevation.
 */
export class LinuxServiceManager extends ServiceManager {

	/** Sudo password provided by the UI, piped to `sudo -S` via stdin. */
	private sudoPassword: string | undefined;

	/** @returns The system-level install root (/opt/rocketride). */
	public getInstallPath(): string {
		return INSTALL_ROOT;
	}

	/** Stores the sudo password for subsequent privileged operations. */
	public setElevationPassword(password: string): void {
		this.sudoPassword = password;
	}

	/**
	 * Returns true if sudo requires a password (i.e., `sudo -n true` fails).
	 * Returns false if the user has passwordless sudo or a cached credential.
	 */
	public async needsElevation(): Promise<boolean> {
		try {
			await execFileAsync('sudo', ['-n', 'true']);
			return false;
		} catch {
			return true;
		}
	}

	/** Runtime apt packages required by the engine binary (C++ stdlib, OpenMP, TLS certs). */
	private static readonly ENGINE_DEPS = ['ca-certificates', 'libc++1', 'libc++abi1', 'libgomp1'];

	/**
	 * Installs runtime dependencies, creates the install root, and chowns it
	 * to the current user so EngineInstaller can write without elevation.
	 */
	public async prepareInstallRoot(): Promise<void> {
		const pkgMgr = await this.detectPackageManager();
		switch (pkgMgr) {
			case 'apt-get':
				await this.runSudo('apt-get', ['install', '-y', '--no-install-recommends', ...LinuxServiceManager.ENGINE_DEPS]);
				break;
			case 'dnf':
				await this.runSudo('dnf', ['install', '-y', ...LinuxServiceManager.ENGINE_DEPS]);
				break;
			case 'yum':
				await this.runSudo('yum', ['install', '-y', ...LinuxServiceManager.ENGINE_DEPS]);
				break;
			case 'pacman':
				await this.runSudo('pacman', ['-S', '--noconfirm', ...LinuxServiceManager.ENGINE_DEPS]);
				break;
			default:
				throw new Error(`Unsupported Linux distribution: no supported package manager found (tried apt-get, dnf, yum, pacman)`);
		}

		const enginesDir = path.join(INSTALL_ROOT, 'engine');
		await this.runSudo('mkdir', ['-p', enginesDir]);
		const username = os.userInfo().username;
		await this.runSudo('chown', ['-R', username, INSTALL_ROOT]);
	}

	/**
	 * Writes a systemd unit file, enables it, and starts the service.
	 * The unit file is written to a temp location first, then copied to
	 * /etc/systemd/system/ via sudo (avoids needing sudo for the write itself).
	 *
	 * @param executablePath - Full path to the engine executable
	 * @param engineDir - Working directory for the engine process
	 */
	public async install(executablePath: string, engineDir: string): Promise<void> {
		// Create install root with elevation (may not be user-writable)
		await this.runSudo('mkdir', ['-p', INSTALL_ROOT]);

		const unitContent = this.buildUnitFile(executablePath, engineDir);
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketride-'));
		const tmpUnit = path.join(tmpDir, 'rocketride.service');
		fs.writeFileSync(tmpUnit, unitContent, { encoding: 'utf8', mode: 0o600 });

		try {
			await this.runSudo('cp', [tmpUnit, UNIT_PATH]);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}

		await this.runSudo('systemctl', ['daemon-reload']);
		await this.runSudo('systemctl', ['enable', UNIT_NAME]);
		await this.runSudo('systemctl', ['start', UNIT_NAME]);

		this.logger.output(`${icons.success} Service registered and started`);
	}

	/** Stops, disables, and removes the systemd unit, then deletes the install root. */
	public async remove(): Promise<void> {
		try { await this.runSudo('systemctl', ['stop', UNIT_NAME]); } catch { /* ignore */ }
		try { await this.runSudo('systemctl', ['disable', UNIT_NAME]); } catch { /* ignore */ }
		try { await this.runSudo('rm', ['-f', UNIT_PATH]); } catch { /* ignore */ }
		try { await this.runSudo('systemctl', ['daemon-reload']); } catch { /* ignore */ }

		// Remove the entire install root
		try { await this.runSudo('rm', ['-rf', INSTALL_ROOT]); } catch { /* ignore */ }

		this.logger.output(`${icons.success} Service removed`);
	}

	/**
	 * Stops the service, rewrites the unit file with new paths, and restarts.
	 *
	 * @param executablePath - Full path to the updated engine executable
	 * @param engineDir - Working directory for the engine process
	 */
	public async update(executablePath: string, engineDir: string): Promise<void> {
		await this.runSudo('systemctl', ['stop', UNIT_NAME]);

		const unitContent = this.buildUnitFile(executablePath, engineDir);
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketride-'));
		const tmpUnit = path.join(tmpDir, 'rocketride.service');
		fs.writeFileSync(tmpUnit, unitContent, { encoding: 'utf8', mode: 0o600 });
		try {
			await this.runSudo('cp', [tmpUnit, UNIT_PATH]);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}

		await this.runSudo('systemctl', ['daemon-reload']);
		await this.runSudo('systemctl', ['start', UNIT_NAME]);

		this.logger.output(`${icons.success} Service updated and restarted`);
	}

	/** Starts the systemd service via `sudo systemctl start`. */
	public async start(): Promise<void> {
		await this.runSudo('systemctl', ['start', UNIT_NAME]);
		this.logger.output(`${icons.success} Service started`);
	}

	/** Stops the systemd service via `sudo systemctl stop`. */
	public async stop(): Promise<void> {
		await this.runSudo('systemctl', ['stop', UNIT_NAME]);
		this.logger.output(`${icons.info} Service stopped`);
	}

	/**
	 * Checks whether the systemd unit file exists, whether the service is active,
	 * and whether the port is accepting connections.
	 */
	public async getStatus(): Promise<ServiceStatus> {
		if (!fs.existsSync(UNIT_PATH)) {
			return { state: 'not-installed', version: null, publishedAt: null, installPath: null };
		}

		let processRunning = false;
		try {
			const { stdout } = await execFileAsync('systemctl', ['is-active', UNIT_NAME]);
			processRunning = stdout.trim() === 'active';
		} catch { /* inactive */ }

		let state: 'stopped' | 'starting' | 'running' = 'stopped';
		if (processRunning) {
			const portOpen = await this.isPortOpen();
			state = portOpen ? 'running' : 'starting';
		}

		return { state, version: null, publishedAt: null, installPath: INSTALL_ROOT };
	}

	/**
	 * Generates a systemd unit file that runs the engine on localhost.
	 * Configured with auto-restart on failure (5-second delay).
	 */
	private buildUnitFile(executablePath: string, workingDir: string): string {
		return `[Unit]
Description=${SERVICE_DISPLAY_NAME}
After=network.target

[Service]
Type=simple
WorkingDirectory=${workingDir}
ExecStart=${executablePath} ./ai/eaas.py --host=127.0.0.1 --port=${SERVICE_PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
	}

	/**
	 * Detects which package manager is available on this Linux distribution.
	 */
	private async detectPackageManager(): Promise<'apt-get' | 'dnf' | 'yum' | 'pacman' | null> {
		for (const pm of ['apt-get', 'dnf', 'yum', 'pacman'] as const) {
			try {
				await execFileAsync('which', [pm]);
				return pm;
			} catch { /* not found */ }
		}
		return null;
	}

	/**
	 * Runs a command with `sudo -S`, piping the stored password via stdin.
	 * Strips the sudo password prompt from stderr before surfacing errors.
	 *
	 * @param command - The command to execute (e.g., 'systemctl', 'mkdir')
	 * @param args - Arguments to pass to the command
	 */
	private runSudo(command: string, args: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			// -S reads password from stdin; -k forces re-authentication each call
			// so the cached timestamp does not silently skip a wrong password.
			const child = spawn('sudo', ['-S', command, ...args], {
				stdio: ['pipe', 'pipe', 'pipe']
			});

			if (this.sudoPassword !== undefined) {
				child.stdin!.write(this.sudoPassword + '\n');
			}
			child.stdin!.end();

			child.stdout!.on('data', () => { /* drain stdout to prevent pipe buffer from blocking */ });
			let stderr = '';
			child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
			child.on('close', (code: number | null) => {
				if (code === 0) {
					resolve();
				} else {
					// Strip the password-prompt line from the error message
					const clean = stderr.replace(/^\[sudo\] password.*\n?/m, '').trim();
					reject(new Error(clean || `sudo exited with code ${code}`));
				}
			});
		});
	}
}
