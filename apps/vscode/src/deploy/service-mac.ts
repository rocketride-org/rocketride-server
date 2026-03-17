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
import { execFile } from 'child_process';
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
const PLIST_LABEL = 'com.rocketride.engine';
const PLIST_PATH = `/Library/LaunchDaemons/${PLIST_LABEL}.plist`;

export class MacServiceManager extends ServiceManager {

	public getInstallPath(): string {
		return INSTALL_ROOT;
	}

	public async install(executablePath: string, engineDir: string): Promise<void> {
		// Create logs directory with elevation (/Library paths require root)
		await this.runSudo('mkdir', ['-p', LOGS_DIR]);

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

		// Delete root-owned dirs
		try { await this.runSudo('rm', ['-rf', path.join(INSTALL_ROOT, 'engines')]); } catch { /* ignore */ }
		try { await this.runSudo('rm', ['-rf', LOGS_DIR]); } catch { /* ignore */ }

		// Clean up the rest
		if (fs.existsSync(INSTALL_ROOT)) {
			fs.rmSync(INSTALL_ROOT, { recursive: true, force: true });
		}

		this.logger.output(`${icons.success} Service removed`);
	}

	public async update(executablePath: string, engineDir: string): Promise<void> {
		try { await this.runSudo('launchctl', ['unload', PLIST_PATH]); } catch { /* ignore */ }

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

		let processRunning = false;
		try {
			const { stdout } = await execFileAsync('launchctl', ['list', PLIST_LABEL]);
			processRunning = stdout.includes(PLIST_LABEL);
		} catch { /* not loaded */ }

		let state: 'stopped' | 'starting' | 'running' = 'stopped';
		if (processRunning) {
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
	<true/>
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
			// Escape single quotes within args for safe AppleScript shell quoting
			const escapeArg = (a: string) => `'${a.replace(/'/g, "'\\''")}'`;
			const script = `do shell script "${command} ${args.map(escapeArg).join(' ')}" with administrator privileges`;
			execFile('osascript', ['-e', script], (error, _stdout, stderr) => {
				if (error) {
					reject(new Error(stderr?.trim() || error.message));
					return;
				}
				resolve();
			});
		});
	}
}
