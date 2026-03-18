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
import { icons } from '../shared/util/icons';

const execFileAsync = promisify(execFile);

const INSTALL_ROOT = '/opt/rocketride';
const UNIT_NAME = 'rocketride';
const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}.service`;

export class LinuxServiceManager extends ServiceManager {

	private sudoPassword: string | undefined;

	public getInstallPath(): string {
		return INSTALL_ROOT;
	}

	public setElevationPassword(password: string): void {
		this.sudoPassword = password;
	}

	public async needsElevation(): Promise<boolean> {
		try {
			await execFileAsync('sudo', ['-n', 'true']);
			return false;
		} catch {
			return true;
		}
	}

	// Runtime dependencies required by the engine binary
	private static readonly ENGINE_DEPS = ['ca-certificates', 'libc++1', 'libc++abi1', 'libgomp1'];

	public async prepareInstallRoot(): Promise<void> {
		await this.runSudo('apt-get', ['install', '-y', '--no-install-recommends', ...LinuxServiceManager.ENGINE_DEPS]);

		const enginesDir = path.join(INSTALL_ROOT, 'engines');
		await this.runSudo('mkdir', ['-p', enginesDir]);
		const username = os.userInfo().username;
		await this.runSudo('chown', ['-R', username, INSTALL_ROOT]);
	}

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

	public async remove(): Promise<void> {
		try { await this.runSudo('systemctl', ['stop', UNIT_NAME]); } catch { /* ignore */ }
		try { await this.runSudo('systemctl', ['disable', UNIT_NAME]); } catch { /* ignore */ }
		try { await this.runSudo('rm', ['-f', UNIT_PATH]); } catch { /* ignore */ }
		try { await this.runSudo('systemctl', ['daemon-reload']); } catch { /* ignore */ }

		// Remove the entire install root
		try { await this.runSudo('rm', ['-rf', INSTALL_ROOT]); } catch { /* ignore */ }

		this.logger.output(`${icons.success} Service removed`);
	}

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

	public async start(): Promise<void> {
		await this.runSudo('systemctl', ['start', UNIT_NAME]);
		this.logger.output(`${icons.success} Service started`);
	}

	public async stop(): Promise<void> {
		await this.runSudo('systemctl', ['stop', UNIT_NAME]);
		this.logger.output(`${icons.info} Service stopped`);
	}

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
