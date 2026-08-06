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
import { icons } from '../../shared/util/icons';

const execFileAsync = promisify(execFile);

/** Root install directory — system-level, requires sudo to create. */
const INSTALL_ROOT = '/Library/RocketRide';

/** Directory for engine stdout/stderr log files. */
const LOGS_DIR = path.join(INSTALL_ROOT, 'logs');

/** Application Support directory for shared config files. */
const CONFIG_DIR = '/Library/Application Support/RocketRide';

/** Reverse-DNS label used in the launchd plist. */
const PLIST_LABEL = 'com.rocketride.engine';

/** Full path to the LaunchDaemon plist file. */
const PLIST_PATH = `/Library/LaunchDaemons/${PLIST_LABEL}.plist`;

/**
 * MacServiceManager — manages the engine as a macOS LaunchDaemon via launchd.
 *
 * The plist is installed to /Library/LaunchDaemons/ (system-wide daemon),
 * which requires sudo. The engine runs as root and listens on localhost only.
 * All privileged operations pipe the sudo password via stdin (`sudo -S`).
 */
export class MacServiceManager extends ServiceManager {

	/** Sudo password provided by the UI, piped to `sudo -S` via stdin. */
	private sudoPassword: string | undefined;

	/** @returns The system-level install root (/Library/RocketRide). */
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

	/**
	 * Creates /Library directories and chowns only user-writable subdirs.
	 * INSTALL_ROOT stays root-owned so the daemon binary can't be replaced
	 * by an unprivileged user.
	 */
	public async prepareInstallRoot(): Promise<void> {
		const enginesDir = path.join(INSTALL_ROOT, 'engine');
		await this.runSudo('mkdir', ['-p', enginesDir, LOGS_DIR, CONFIG_DIR]);
		const user = os.userInfo().username;
		await this.runSudo('chown', ['-R', user, enginesDir, LOGS_DIR, CONFIG_DIR]);
	}

	/**
	 * Writes a launchd plist and loads it to start the service.
	 * The plist is written to a temp dir first, then copied to
	 * /Library/LaunchDaemons/ via sudo.
	 *
	 * @param executablePath - Full path to the engine executable
	 * @param engineDir - Working directory for the engine process
	 */
	public async install(executablePath: string, engineDir: string): Promise<void> {
		const plistContent = this.buildPlist(executablePath, engineDir);
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketride-'));
		const tmpPlist = path.join(tmpDir, 'rocketride.plist');
		fs.writeFileSync(tmpPlist, plistContent, { encoding: 'utf8', mode: 0o600 });

		try {
			await this.runSudo('cp', [tmpPlist, PLIST_PATH]);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}

		await this.runSudo('launchctl', ['load', PLIST_PATH]);

		this.logger.output(`${icons.success} Service registered and started`);
	}

	/** Unloads the daemon, removes the plist, and deletes the install root and config dir. */
	public async remove(): Promise<void> {
		try { await this.runSudo('launchctl', ['unload', PLIST_PATH]); } catch { /* ignore */ }
		try { await this.runSudo('rm', ['-f', PLIST_PATH]); } catch { /* ignore */ }

		// Remove the entire install root and config dir
		try { await this.runSudo('rm', ['-rf', INSTALL_ROOT]); } catch { /* ignore */ }
		try { await this.runSudo('rm', ['-rf', CONFIG_DIR]); } catch { /* ignore */ }

		this.logger.output(`${icons.success} Service removed`);
	}

	/**
	 * Unloads the daemon, rewrites the plist with new paths, and reloads.
	 *
	 * @param executablePath - Full path to the updated engine executable
	 * @param engineDir - Working directory for the engine process
	 */
	public async update(executablePath: string, engineDir: string): Promise<void> {
		await this.runSudo('launchctl', ['unload', PLIST_PATH]);

		const plistContent = this.buildPlist(executablePath, engineDir);
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketride-'));
		const tmpPlist = path.join(tmpDir, 'rocketride.plist');
		fs.writeFileSync(tmpPlist, plistContent, { encoding: 'utf8', mode: 0o600 });
		try {
			await this.runSudo('cp', [tmpPlist, PLIST_PATH]);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}

		await this.runSudo('launchctl', ['load', PLIST_PATH]);

		this.logger.output(`${icons.success} Service updated and restarted`);
	}

	/** Loads the launchd plist (starts the daemon). */
	public async start(): Promise<void> {
		await this.runSudo('launchctl', ['load', PLIST_PATH]);
		this.logger.output(`${icons.success} Service started`);
	}

	/** Unloads the launchd plist (stops the daemon). */
	public async stop(): Promise<void> {
		await this.runSudo('launchctl', ['unload', PLIST_PATH]);
		this.logger.output(`${icons.info} Service stopped`);
	}

	/**
	 * Checks whether the plist file exists, whether the daemon is loaded,
	 * and whether the port is accepting connections.
	 */
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

	/** Escapes a string for safe embedding in XML/plist values. */
	private static escapeXml(s: string): string {
		return s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&apos;');
	}

	/**
	 * Generates a launchd plist that runs the engine on localhost.
	 * Configured with KeepAlive (restart on non-zero exit) and 5-second throttle.
	 */
	private buildPlist(executablePath: string, workingDir: string): string {
		const x = MacServiceManager.escapeXml;
		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${x(PLIST_LABEL)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${x(executablePath)}</string>
		<string>./ai/eaas.py</string>
		<string>--host=127.0.0.1</string>
		<string>--port=${x(String(SERVICE_PORT))}</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${x(workingDir)}</string>
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
	<string>${x(path.join(LOGS_DIR, 'stdout.log'))}</string>
	<key>StandardErrorPath</key>
	<string>${x(path.join(LOGS_DIR, 'stderr.log'))}</string>
</dict>
</plist>
`;
	}

	/**
	 * Runs a command with `sudo -S`, piping the stored password via stdin.
	 * Strips the macOS password prompt from stderr before surfacing errors.
	 *
	 * @param command - The command to execute (e.g., 'launchctl', 'mkdir')
	 * @param args - Arguments to pass to the command
	 */
	private runSudo(command: string, args: string[]): Promise<void> {
		return new Promise((resolve, reject) => {
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
					const clean = stderr.replace(/^Password:/m, '').trim();
					reject(new Error(clean || `sudo exited with code ${code}`));
				}
			});
		});
	}
}
