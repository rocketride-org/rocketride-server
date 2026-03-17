// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * service-windows.ts - Windows Service Manager (NSSM)
 *
 * Pure service lifecycle: register/start/stop/remove via NSSM.
 * No engine downloading or versioning — that's the caller's job.
 *
 * On remove, deletes SYSTEM-owned directories (engines/, logs/) via
 * elevated PowerShell, then the caller cleans up the rest.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
	ServiceManager,
	ServiceStatus,
	SERVICE_NAME,
	SERVICE_DISPLAY_NAME,
	SERVICE_PORT
} from './service-manager';
import { icons } from '../shared/util/icons';

const execFileAsync = promisify(execFile);

const INSTALL_ROOT = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'RocketRide');
const NSSM_DIR = path.join(INSTALL_ROOT, 'tools');
const NSSM_PATH = path.join(NSSM_DIR, 'nssm.exe');
const LOGS_DIR = path.join(INSTALL_ROOT, 'logs');

// NSSM download URL (64-bit)
const NSSM_DOWNLOAD_URL = 'https://nssm.cc/release/nssm-2.24.zip';

/** Escape a string for use inside PowerShell single quotes */
function psEscape(s: string): string {
	return s.replace(/'/g, "''");
}

/** Build a PowerShell line: & 'exe' 'arg1' 'arg2' ... */
function psCmd(...args: string[]): string {
	return `& ${args.map(a => `'${psEscape(a)}'`).join(' ')}`;
}

export class WindowsServiceManager extends ServiceManager {

	public getInstallPath(): string {
		return INSTALL_ROOT;
	}

	// =========================================================================
	// Install — register service pointing to the given executable
	// =========================================================================

	public async install(executablePath: string, engineDir: string): Promise<void> {
		// Ensure directories exist
		fs.mkdirSync(INSTALL_ROOT, { recursive: true });
		fs.mkdirSync(LOGS_DIR, { recursive: true });

		// Download NSSM if not present
		if (!fs.existsSync(NSSM_PATH)) {
			await this.downloadNssm();
		}

		// Register and configure the service (single UAC prompt)
		await this.runElevatedScript('install.ps1', [
			psCmd(NSSM_PATH, 'install', SERVICE_NAME, executablePath, './ai/eaas.py', `--host=0.0.0.0`, `--port=${SERVICE_PORT}`),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'AppDirectory', engineDir),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'DisplayName', SERVICE_DISPLAY_NAME),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'Description', 'RocketRide pipeline execution engine'),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'AppStdout', path.join(LOGS_DIR, 'stdout.log')),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'AppStderr', path.join(LOGS_DIR, 'stderr.log')),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'AppStdoutCreationDisposition', '4'),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'AppStderrCreationDisposition', '4'),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'AppRestartDelay', '5000'),
			psCmd(NSSM_PATH, 'start', SERVICE_NAME),
		].join('\n'));

		this.logger.output(`${icons.success} Service registered and started`);
	}

	// =========================================================================
	// Remove — unregister service, delete SYSTEM-owned dirs
	// =========================================================================

	public async remove(): Promise<void> {
		const enginesDir = path.join(INSTALL_ROOT, 'engines');
		const nssm = NSSM_PATH.replace(/'/g, "''");
		const svcName = SERVICE_NAME.replace(/'/g, "''");

		// Build a PowerShell script that stops the service, waits for it to
		// fully terminate, removes the service, then deletes SYSTEM-owned dirs.
		const script = [
			`& '${nssm}' 'stop' '${svcName}'`,
			`# Wait for service to fully stop (up to 30s)`,
			`$timeout = 30; $elapsed = 0`,
			`while ($elapsed -lt $timeout) {`,
			`    $result = & sc.exe query '${svcName}' 2>&1`,
			`    if ($result -match 'STOPPED' -or $LASTEXITCODE -ne 0) { break }`,
			`    Start-Sleep -Seconds 1; $elapsed++`,
			`}`,
			`& '${nssm}' 'remove' '${svcName}' 'confirm'`,
			`Start-Sleep -Seconds 2`,
			`Remove-Item -Recurse -Force '${enginesDir.replace(/'/g, "''")}'`,
			`Remove-Item -Recurse -Force '${LOGS_DIR.replace(/'/g, "''")}'`,
		].join('\n');

		await this.runElevatedScript('remove.ps1', script).catch(() => { /* service may not be installed */ });

		// Clean up the rest (config, tools, scripts) — owned by current user
		if (fs.existsSync(INSTALL_ROOT)) {
			fs.rmSync(INSTALL_ROOT, { recursive: true, force: true });
		}

		this.logger.output(`${icons.success} Service removed`);
	}

	// =========================================================================
	// Update — point service to new executable, restart
	// =========================================================================

	public async update(executablePath: string, engineDir: string): Promise<void> {
		await this.runElevatedScript('update.ps1', [
			psCmd(NSSM_PATH, 'stop', SERVICE_NAME),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'Application', executablePath),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'AppParameters', `./ai/eaas.py --host=0.0.0.0 --port=${SERVICE_PORT}`),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'AppDirectory', engineDir),
			psCmd(NSSM_PATH, 'start', SERVICE_NAME),
		].join('\n'));

		this.logger.output(`${icons.success} Service updated and restarted`);
	}

	// =========================================================================
	// Start / Stop
	// =========================================================================

	public async start(): Promise<void> {
		await this.runElevatedScript('start.ps1', psCmd(NSSM_PATH, 'start', SERVICE_NAME));
		this.logger.output(`${icons.success} Service started`);
	}

	public async stop(): Promise<void> {
		await this.runElevatedScript('stop.ps1', psCmd(NSSM_PATH, 'stop', SERVICE_NAME));
		this.logger.output(`${icons.info} Service stopped`);
	}

	// =========================================================================
	// Status
	// =========================================================================

	public async getStatus(): Promise<ServiceStatus> {
		const scState = await this.getScState();

		let state: ServiceStatus['state'];

		if (scState === null) {
			state = 'not-installed';
		} else if (scState === 'STOPPED') {
			state = 'stopped';
		} else if (scState === 'START_PENDING') {
			state = 'starting';
		} else if (scState === 'STOP_PENDING') {
			state = 'stopping';
		} else if (scState === 'RUNNING') {
			const portOpen = await this.isPortOpen();
			state = portOpen ? 'running' : 'starting';
		} else {
			state = 'stopped';
		}

		return {
			state,
			version: null,
			publishedAt: null,
			installPath: state === 'not-installed' ? null : INSTALL_ROOT
		};
	}

	/**
	 * Returns the SC state string (RUNNING, STOPPED, START_PENDING, STOP_PENDING, etc.)
	 * or null if the service is not registered.
	 */
	private async getScState(): Promise<string | null> {
		try {
			const { stdout } = await execFileAsync('sc', ['query', SERVICE_NAME]);
			const match = stdout.match(/STATE\s+:\s+\d+\s+(\w+)/);
			return match ? match[1] : null;
		} catch {
			return null;
		}
	}

	// =========================================================================
	// NSSM download
	// =========================================================================

	private async downloadNssm(): Promise<void> {
		fs.mkdirSync(NSSM_DIR, { recursive: true });

		const zipPath = path.join(NSSM_DIR, 'nssm.zip');

		const MAX_RETRIES = 5;
		const RETRY_DELAY_MS = 3000;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				await this.downloadFile(NSSM_DOWNLOAD_URL, zipPath);
				break;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logger.output(`${icons.warning} NSSM download attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);
				if (attempt === MAX_RETRIES) {
					throw new Error(`NSSM download failed after ${MAX_RETRIES} attempts: ${msg}`);
				}
				await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
			}
		}

		const AdmZip = require('adm-zip');
		const zip = new AdmZip(zipPath);
		const entries = zip.getEntries();

		const nssmEntry = entries.find((e: { entryName: string }) =>
			e.entryName.includes('win64/nssm.exe') || e.entryName.includes('win64\\nssm.exe')
		);

		if (!nssmEntry) {
			throw new Error('Could not find nssm.exe in downloaded archive');
		}

		zip.extractEntryTo(nssmEntry, NSSM_DIR, false, true);
		try { fs.unlinkSync(zipPath); } catch { /* ignore */ }

		if (!fs.existsSync(NSSM_PATH)) {
			throw new Error(`NSSM extraction failed — expected at ${NSSM_PATH}`);
		}

		this.logger.output(`${icons.success} NSSM downloaded to ${NSSM_PATH}`);
	}

	private downloadFile(url: string, destPath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const protocol = url.startsWith('https') ? https : http;
			const req = protocol.get(url, { headers: { 'User-Agent': 'RocketRide-VSCode' } }, (response) => {
				if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
					response.destroy();
					this.downloadFile(response.headers.location, destPath).then(resolve, reject);
					return;
				}

				if (response.statusCode !== 200) {
					response.destroy();
					reject(new Error(`Download failed: HTTP ${response.statusCode}`));
					return;
				}

				const file = fs.createWriteStream(destPath);
				response.pipe(file);
				file.on('finish', () => { file.close(); resolve(); });
				file.on('error', (err) => { file.close(); reject(err); });
			});
			req.on('error', reject);
		});
	}

	// =========================================================================
	// Elevated execution (UAC)
	// =========================================================================

	private runElevatedScript(scriptName: string, scriptContent: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const scriptPath = path.join(INSTALL_ROOT, scriptName);
			fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
			fs.writeFileSync(scriptPath, scriptContent, 'utf8');

			this.logger.output(`${icons.info} Wrote ${scriptPath}`);

			const psCommand = `Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${scriptPath}' -Verb RunAs -Wait -WindowStyle Hidden`;

			execFile('powershell.exe', ['-NoProfile', '-Command', psCommand], (error, _stdout, stderr) => {
				if (error) {
					const msg = stderr?.trim() || error.message;
					this.logger.output(`${icons.error} Elevated command failed: ${msg}`);
					reject(new Error(`Elevated command failed: ${msg}`));
					return;
				}
				resolve();
			});
		});
	}
}
