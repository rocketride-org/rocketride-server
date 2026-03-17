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
import { execFile } from 'child_process';
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

	public getInstallPath(): string {
		return INSTALL_ROOT;
	}

	public async install(executablePath: string, engineDir: string): Promise<void> {
		// Create install root with elevation (may not be user-writable)
		await this.runSudo('mkdir', ['-p', INSTALL_ROOT]);

		const unitContent = this.buildUnitFile(executablePath, engineDir);
		const tmpUnit = path.join(os.tmpdir(), 'rocketride.service.tmp');
		fs.writeFileSync(tmpUnit, unitContent, 'utf8');

		await this.runSudo('cp', [tmpUnit, UNIT_PATH]);
		fs.unlinkSync(tmpUnit);

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

		// Delete SYSTEM-owned dirs
		try { await this.runSudo('rm', ['-rf', path.join(INSTALL_ROOT, 'engines')]); } catch { /* ignore */ }

		// Clean up the rest
		if (fs.existsSync(INSTALL_ROOT)) {
			fs.rmSync(INSTALL_ROOT, { recursive: true, force: true });
		}

		this.logger.output(`${icons.success} Service removed`);
	}

	public async update(executablePath: string, engineDir: string): Promise<void> {
		await this.runSudo('systemctl', ['stop', UNIT_NAME]);

		const unitContent = this.buildUnitFile(executablePath, engineDir);
		const tmpUnit = path.join(os.tmpdir(), 'rocketride.service.tmp');
		fs.writeFileSync(tmpUnit, unitContent, 'utf8');
		await this.runSudo('cp', [tmpUnit, UNIT_PATH]);
		fs.unlinkSync(tmpUnit);

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
ExecStart=${executablePath} ./ai/eaas.py --host=0.0.0.0 --port=${SERVICE_PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
	}

	private runSudo(command: string, args: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			execFile('pkexec', [command, ...args], (error, _stdout, stderr) => {
				if (error) {
					reject(new Error(stderr?.trim() || error.message));
					return;
				}
				resolve();
			});
		});
	}
}
