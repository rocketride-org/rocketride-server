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
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
	ServiceManager,
	ServiceStatus,
	SERVICE_NAME,
	SERVICE_DISPLAY_NAME,
	SERVICE_PORT
} from './service-manager';
import { icons } from '../../shared/util/icons';

const execFileAsync = promisify(execFile);

/** Root install directory under ProgramData — shared across all Windows users. */
const INSTALL_ROOT = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'RocketRide');

/** Directory for third-party tools (currently just nssm.exe). */
const NSSM_DIR = path.join(INSTALL_ROOT, 'tools');

/** Full path to the NSSM executable used for service management. */
const NSSM_PATH = path.join(NSSM_DIR, 'nssm.exe');

/** Directory for engine stdout/stderr log files. */
const LOGS_DIR = path.join(INSTALL_ROOT, 'logs');

/** Pinned NSSM download URL (64-bit build). */
const NSSM_DOWNLOAD_URL = 'https://nssm.cc/release/nssm-2.24.zip';

/** SHA-256 hash of the NSSM zip — verified after download to prevent tampering. */
const NSSM_SHA256 = '727d1e42275c605e0f04aba98095c38a8e1e46def453cdffce42869428aa6743';

/** Escape a string for use inside PowerShell single quotes */
function psEscape(s: string): string {
	return s.replace(/'/g, "''");
}

/** Build a PowerShell line: & 'exe' 'arg1' 'arg2' ... */
function psCmd(...args: string[]): string {
	return `& ${args.map(a => `'${psEscape(a)}'`).join(' ')}`;
}

/**
 * WindowsServiceManager — manages the engine as a Windows service via NSSM.
 *
 * All service operations (install, start, stop, remove) run through elevated
 * PowerShell scripts to get a single UAC prompt per operation. The scripts
 * are written to disk so users can also run them manually.
 */
export class WindowsServiceManager extends ServiceManager {

	/** @returns The ProgramData install root (C:\ProgramData\RocketRide). */
	public getInstallPath(): string {
		return INSTALL_ROOT;
	}

	// =========================================================================
	// Install — register service pointing to the given executable
	// =========================================================================

	/**
	 * Registers and starts the engine as a Windows service via NSSM.
	 * Downloads NSSM if not already present, then runs an elevated PowerShell
	 * script that configures and starts the service (single UAC prompt).
	 *
	 * @param executablePath - Full path to the engine executable
	 * @param engineDir - Working directory for the engine process
	 */
	public async install(executablePath: string, engineDir: string): Promise<void> {
		// Create directories and download NSSM. On first install these dirs
		// don't exist yet so mkdirSync succeeds. On re-install after a previous
		// removal the elevated script will fix permissions via icacls.
		try {
			fs.mkdirSync(INSTALL_ROOT, { recursive: true });
			fs.mkdirSync(LOGS_DIR, { recursive: true });
		} catch {
			// SYSTEM-owned from previous install — the elevated script will create them
		}

		if (!fs.existsSync(NSSM_PATH)) {
			await this.downloadNssm();
		}

		// Register and configure the service (single UAC prompt).
		// Directories and NSSM are already in place (created above as current user).
		await this.runElevatedScript('install.ps1', [
			psCmd(NSSM_PATH, 'install', SERVICE_NAME, executablePath, './ai/eaas.py', '--host=127.0.0.1', `--port=${SERVICE_PORT}`),
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

		// Now that INSTALL_ROOT is user-writable, write the control scripts
		// from Node.js (simple file writes, no PowerShell escaping gymnastics).
		this.writeServiceScripts(executablePath, engineDir);

		this.logger.output(`${icons.success} Service registered and started`);
	}

	// =========================================================================
	// Remove — unregister service, delete SYSTEM-owned dirs
	// =========================================================================

	/**
	 * Stops and unregisters the service, then deletes the entire install directory.
	 * Runs an elevated script that waits for the service to fully stop before
	 * removing it. Falls back to unelevated cleanup if UAC is cancelled.
	 */
	public async remove(): Promise<void> {
		const nssm = NSSM_PATH.replace(/'/g, "''");
		const svcName = SERVICE_NAME.replace(/'/g, "''");

		// Build a PowerShell script that stops the service, waits for it to
		// fully terminate, removes the service, then deletes the entire install
		// directory (engines, logs, tools, scripts). The entire cleanup runs
		// elevated so it can remove SYSTEM-owned files.
		const installRoot = INSTALL_ROOT.replace(/'/g, "''");
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
			`# Remove the entire install directory (engines, logs, tools, scripts)`,
			`Remove-Item -Recurse -Force '${installRoot}' -ErrorAction SilentlyContinue`,
		].join('\n');

		try {
			await this.runElevatedScript('remove.ps1', script);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (
				!/not installed|service does not exist|does not exist as an installed|1060/i.test(msg) &&
				!/cancell?ed by the user|1223|0x4c7/i.test(msg)
			) {
				throw err;
			}
			// Service missing or elevation cancelled — proceed with best-effort local cleanup
		}

		// Best-effort fallback: if the elevated script couldn't fully clean up
		// (e.g., user cancelled UAC), try removing what we can without elevation.
		try {
			if (fs.existsSync(INSTALL_ROOT)) {
				fs.rmSync(INSTALL_ROOT, { recursive: true, force: true });
			}
		} catch {
			// Expected if SYSTEM-owned files remain — not an error
		}

		this.logger.output(`${icons.success} Service removed`);
	}

	// =========================================================================
	// Uninstall script — written to disk for manual use by the user
	// =========================================================================

	/**
	 * Writes all service control scripts to the install root so users can
	 * manage the service from the command line without VS Code.
	 *
	 * Scripts written:
	 *   start.ps1     — start the service
	 *   stop.ps1      — stop the service
	 *   update.ps1    — re-point service to a new engine binary and restart
	 *   uninstall.ps1 — stop, unregister service, delete engines and logs
	 *
	 * All scripts require Administrator privileges (right-click → "Run with PowerShell").
	 */
	/**
	 * Writes service control scripts (.ps1 + .cmd wrappers) to INSTALL_ROOT.
	 * Called after the elevated install script has created the directory and
	 * granted the current user write access via icacls.
	 *
	 * Scripts written:
	 *   start.ps1/.cmd     — start the service
	 *   stop.ps1/.cmd      — stop the service
	 *   update.ps1/.cmd    — re-point service to a new engine binary and restart
	 *   uninstall.ps1/.cmd — stop, unregister service, delete engines and logs
	 */
	private writeServiceScripts(executablePath: string, engineDir: string): void {
		const nssm = psEscape(NSSM_PATH);
		const svcName = psEscape(SERVICE_NAME);
		const enginesDir = psEscape(path.join(INSTALL_ROOT, 'engine'));
		const logsDir = psEscape(LOGS_DIR);

		const scripts: Record<string, string> = {
			'start.ps1': [
				`# RocketRide Engine — Start Service`,
				`# Run as Administrator: right-click → "Run with PowerShell"`,
				``,
				`Write-Host "Starting RocketRide service..."`,
				`& '${nssm}' 'start' '${svcName}'`,
				`Write-Host "Done."`,
			].join('\n'),

			'stop.ps1': [
				`# RocketRide Engine — Stop Service`,
				`# Run as Administrator: right-click → "Run with PowerShell"`,
				``,
				`Write-Host "Stopping RocketRide service..."`,
				`& '${nssm}' 'stop' '${svcName}'`,
				`Write-Host "Done."`,
			].join('\n'),

			'update.ps1': [
				`# RocketRide Engine — Update Service`,
				`# Run as Administrator: right-click → "Run with PowerShell"`,
				``,
				`Write-Host "Stopping RocketRide service..."`,
				psCmd(NSSM_PATH, 'stop', SERVICE_NAME),
				`Write-Host "Updating service configuration..."`,
				psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'Application', executablePath),
				psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'AppParameters', `./ai/eaas.py --host=127.0.0.1 --port=${SERVICE_PORT}`),
				psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'AppDirectory', engineDir),
				`Write-Host "Starting RocketRide service..."`,
				psCmd(NSSM_PATH, 'start', SERVICE_NAME),
				`Write-Host "Done."`,
			].join('\n'),

			'uninstall.ps1': [
				`# RocketRide Engine — Uninstall Script`,
				`# Run as Administrator: right-click → "Run with PowerShell"`,
				``,
				`Write-Host "Stopping RocketRide service..."`,
				`& '${nssm}' 'stop' '${svcName}'`,
				``,
				`# Wait for the service to fully stop (up to 30 seconds)`,
				`$timeout = 30; $elapsed = 0`,
				`while ($elapsed -lt $timeout) {`,
				`    $result = & sc.exe query '${svcName}' 2>&1`,
				`    if ($result -match 'STOPPED' -or $LASTEXITCODE -ne 0) { break }`,
				`    Start-Sleep -Seconds 1; $elapsed++`,
				`}`,
				``,
				`Write-Host "Removing RocketRide service..."`,
				`& '${nssm}' 'remove' '${svcName}' 'confirm'`,
				`Start-Sleep -Seconds 2`,
				``,
				`Write-Host "Cleaning up install directory..."`,
				`Remove-Item -Recurse -Force '${psEscape(INSTALL_ROOT)}' -ErrorAction SilentlyContinue`,
				``,
				`Write-Host "RocketRide service uninstalled successfully."`,
				`Write-Host "Press any key to close..."`,
				`$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')`,
			].join('\n'),
		};

		for (const [name, content] of Object.entries(scripts)) {
			try {
				fs.writeFileSync(path.join(INSTALL_ROOT, name), content, 'utf8');
			} catch {
				// Best effort — non-critical
			}
		}

		// Write .cmd wrappers so users can double-click to run.
		// Each wrapper checks for admin, re-launches elevated if needed,
		// then executes the corresponding .ps1 script.
		for (const name of Object.keys(scripts)) {
			const cmdName = name.replace(/\.ps1$/, '.cmd');
			const cmdContent = [
				`@echo off`,
				`:: RocketRide Engine — ${name.replace('.ps1', '')} (double-click to run as Administrator)`,
				`net session >nul 2>&1`,
				`if %errorlevel% neq 0 (`,
				`    powershell -NoProfile -Command "Start-Process cmd.exe -ArgumentList '/c \"%~f0\"' -Verb RunAs"`,
				`    exit /b`,
				`)`,
				`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0${name}"`,
				`pause`,
			].join('\r\n');
			try {
				fs.writeFileSync(path.join(INSTALL_ROOT, cmdName), cmdContent, 'utf8');
			} catch {
				// Best effort — non-critical
			}
		}
	}

	// =========================================================================
	// Update — point service to new executable, restart
	// =========================================================================

	/**
	 * Stops the service, reconfigures NSSM to point to the new executable, and restarts.
	 *
	 * @param executablePath - Full path to the updated engine executable
	 * @param engineDir - Working directory for the engine process
	 */
	public async update(executablePath: string, engineDir: string): Promise<void> {
		await this.runElevatedScript('update.ps1', [
			psCmd(NSSM_PATH, 'stop', SERVICE_NAME),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'Application', executablePath),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'AppParameters', `./ai/eaas.py --host=127.0.0.1 --port=${SERVICE_PORT}`),
			psCmd(NSSM_PATH, 'set', SERVICE_NAME, 'AppDirectory', engineDir),
			psCmd(NSSM_PATH, 'start', SERVICE_NAME),
		].join('\n'));

		this.logger.output(`${icons.success} Service updated and restarted`);
	}

	// =========================================================================
	// Start / Stop
	// =========================================================================

	/** Starts the service via an elevated NSSM command (triggers UAC). */
	public async start(): Promise<void> {
		await this.runElevatedScript('start.ps1', psCmd(NSSM_PATH, 'start', SERVICE_NAME));
		this.logger.output(`${icons.success} Service started`);
	}

	/** Stops the service via an elevated NSSM command (triggers UAC). */
	public async stop(): Promise<void> {
		await this.runElevatedScript('stop.ps1', psCmd(NSSM_PATH, 'stop', SERVICE_NAME));
		this.logger.output(`${icons.info} Service stopped`);
	}

	// =========================================================================
	// Status
	// =========================================================================

	/**
	 * Queries the service state from `sc query`, then verifies the port is
	 * actually accepting connections before reporting 'running'.
	 */
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

	/**
	 * Downloads NSSM to INSTALL_ROOT/tools/nssm.exe.
	 * Retries up to 5 times and verifies the ZIP SHA-256 before extraction.
	 */
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

		// Verify ZIP integrity before extraction
		const zipBuffer = fs.readFileSync(zipPath);
		const zipHash = crypto.createHash('sha256').update(zipBuffer).digest('hex');
		if (zipHash !== NSSM_SHA256) {
			try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
			throw new Error('NSSM integrity check failed — expected ' + NSSM_SHA256 + ', got ' + zipHash);
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

	/**
	 * Downloads a file from a URL to disk, following HTTP redirects.
	 *
	 * @param url - Source URL (http or https)
	 * @param destPath - Local filesystem path to write to
	 * @param maxRedirects - Maximum redirect hops before failing
	 */
	private downloadFile(url: string, destPath: string, maxRedirects: number = 10): Promise<void> {
		return new Promise((resolve, reject) => {
			const protocol = url.startsWith('https') ? https : http;
			const req = protocol.get(url, { headers: { 'User-Agent': 'RocketRide-VSCode' } }, (response) => {
				if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
					response.destroy();
					if (maxRedirects <= 0) {
						reject(new Error('Too many redirects'));
						return;
					}
					this.downloadFile(response.headers.location, destPath, maxRedirects - 1).then(resolve, reject);
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

	/**
	 * Writes a .ps1 script to INSTALL_ROOT, executes it with UAC elevation
	 * (RunAs), and waits for completion. The script is left on disk so the
	 * user can run it manually if needed (start.ps1, stop.ps1, etc.).
	 */
	private runElevatedScript(scriptName: string, scriptContent: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const scriptPath = path.join(INSTALL_ROOT, scriptName);
			fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
			fs.writeFileSync(scriptPath, scriptContent, 'utf8');

			this.logger.output(`${icons.info} Wrote ${scriptPath}`);

			const psCommand = `$p = Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${psEscape(scriptPath)}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;

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
