// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * service-mac.ts - macOS Service Manager (launchd)
 *
 * Pure service lifecycle: register/start/stop/remove via launchd.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import {
	ServiceManager,
	ServiceStatus,
	SERVICE_PORT
} from './service-manager';
import { icons } from '../shared/util/icons';

const execFileAsync = promisify(execFile);

const INSTALL_ROOT = '/Library/RocketRide';
const LOGS_DIR = path.join(INSTALL_ROOT, 'logs');
const CONFIG_DIR = '/Library/Application Support/RocketRide';
const PLIST_LABEL = 'com.rocketride.engine';
const PLIST_PATH = `/Library/LaunchDaemons/${PLIST_LABEL}.plist`;

export class MacServiceManager extends ServiceManager {

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

	public async prepareInstallRoot(): Promise<void> {
		// Create all /Library dirs and chown to current user
		// so EngineInstaller and config writes don't need elevation later.
		const enginesDir = path.join(INSTALL_ROOT, 'engines');
		await this.runSudo('mkdir', ['-p', enginesDir, LOGS_DIR, CONFIG_DIR]);
		const user = os.userInfo().username;
		await this.runSudo('chown', ['-R', user, INSTALL_ROOT, CONFIG_DIR]);
	}

	public async install(executablePath: string, engineDir: string): Promise<void> {
		const plistContent = this.buildPlist(executablePath, engineDir);
		const tmpPlist = path.join(os.tmpdir(), 'rocketride.plist.tmp');
		fs.writeFileSync(tmpPlist, plistContent, 'utf8');

		await this.runSudo('cp', [tmpPlist, PLIST_PATH]);
		fs.unlinkSync(tmpPlist);

		await this.runSudo('launchctl', ['load', PLIST_PATH]);

		this.logger.output(`${icons.success} Service registered and started`);
	}

	public async remove(): Promise<void> {
		try { await this.runSudo('launchctl', ['unload', PLIST_PATH]); } catch { /* ignore */ }
		try { await this.runSudo('rm', ['-f', PLIST_PATH]); } catch { /* ignore */ }

		// Remove the entire install root and config dir
		try { await this.runSudo('rm', ['-rf', INSTALL_ROOT]); } catch { /* ignore */ }
		try { await this.runSudo('rm', ['-rf', CONFIG_DIR]); } catch { /* ignore */ }

		this.logger.output(`${icons.success} Service removed`);
	}

	public async update(executablePath: string, engineDir: string): Promise<void> {
		await this.runSudo('launchctl', ['unload', PLIST_PATH]);

		const plistContent = this.buildPlist(executablePath, engineDir);
		const tmpPlist = path.join(os.tmpdir(), 'rocketride.plist.tmp');
		fs.writeFileSync(tmpPlist, plistContent, 'utf8');
		await this.runSudo('cp', [tmpPlist, PLIST_PATH]);
		fs.unlinkSync(tmpPlist);

		await this.runSudo('launchctl', ['load', PLIST_PATH]);

		this.logger.output(`${icons.success} Service updated and restarted`);
	}

	public async start(): Promise<void> {
		await this.runSudo('launchctl', ['load', PLIST_PATH]);
		this.logger.output(`${icons.success} Service started`);
	}

	public async stop(): Promise<void> {
		await this.runSudo('launchctl', ['unload', PLIST_PATH]);
		this.logger.output(`${icons.info} Service stopped`);
	}

	public async getStatus(): Promise<ServiceStatus> {
		if (!fs.existsSync(PLIST_PATH)) {
			return { state: 'not-installed', version: null, publishedAt: null, installPath: null };
		}

		let serviceLoaded = false;
		try {
			// launchctl print works for system daemons without sudo;
			// succeeding means the service is loaded
			await execFileAsync('launchctl', ['print', `system/${PLIST_LABEL}`]);
			serviceLoaded = true;
		} catch { /* not loaded */ }

		let state: 'stopped' | 'starting' | 'running' = 'stopped';
		if (serviceLoaded) {
			const portOpen = await this.isPortOpen();
			state = portOpen ? 'running' : 'starting';
		}

		return { state, version: null, publishedAt: null, installPath: INSTALL_ROOT };
	}

	private buildPlist(executablePath: string, workingDir: string): string {
		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${PLIST_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${executablePath}</string>
		<string>./ai/eaas.py</string>
		<string>--host=0.0.0.0</string>
		<string>--port=${SERVICE_PORT}</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${workingDir}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>StandardOutPath</key>
	<string>${path.join(LOGS_DIR, 'stdout.log')}</string>
	<key>StandardErrorPath</key>
	<string>${path.join(LOGS_DIR, 'stderr.log')}</string>
</dict>
</plist>
`;
	}

	private runSudo(command: string, args: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn('sudo', ['-S', command, ...args], {
				stdio: ['pipe', 'pipe', 'pipe']
			});

			if (this.sudoPassword !== undefined) {
				child.stdin!.write(this.sudoPassword + '\n');
			}
			child.stdin!.end();

			let stderr = '';
			child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
			child.on('close', (code: number | null) => {
				if (code === 0) {
					resolve();
				} else {
					const clean = stderr.replace(/^Password:/m, '').trim();
					reject(new Error(clean || `sudo exited with code ${code}`));
				}
			});
		});
	}
}
