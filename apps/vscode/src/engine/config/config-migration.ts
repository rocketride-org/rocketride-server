// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * config-migration.ts — Migrates engine binaries and config from legacy locations.
 *
 * Handles upgrades from the old engine layout (develop branch) to the new one:
 *
 * Old layout (local):
 *   globalStorage/engines/
 *     current-stable.json          → pointer { dir, tag, publishedAt }
 *     current-pre.json             → pointer (prerelease channel)
 *     server-3.2.0--abc123/        → versioned install dir
 *       engine.exe
 *       ai/eaas.py
 *
 * New layout (local):
 *   %LOCALAPPDATA%/RocketRide/engine/
 *     engine.exe
 *     ai/eaas.py
 *     version.json                 → { tag, publishedAt }
 *
 * Old layout (service):
 *   %PROGRAMDATA%/RocketRide/
 *     config.json                  → { versionSpec, version, publishedAt }
 *     engine/engine.exe            → (unchanged)
 *
 * New layout (service):
 *   %PROGRAMDATA%/RocketRide/
 *     engine/engine.exe            → (unchanged)
 *     version.local.json / version.service.json          → { tag, publishedAt }
 *
 * All operations are best-effort and never throw. Safe to call multiple times.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLogger } from '../../shared/util/output';

// =============================================================================
// PATH HELPERS — canonical engine storage directories per platform
// =============================================================================

/**
 * Returns the per-user config directory (no elevation needed).
 *   Windows: %LOCALAPPDATA%\RocketRide
 *   macOS:   ~/Library/Application Support/RocketRide
 *   Linux:   ~/.config/RocketRide
 */
export function getUserConfigDir(): string {
	switch (process.platform) {
		case 'win32':
			return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'RocketRide');
		case 'darwin':
			return path.join(os.homedir(), 'Library', 'Application Support', 'RocketRide');
		default:
			return path.join(os.homedir(), '.config', 'RocketRide');
	}
}

/**
 * Returns the system-level install directory (shared, elevation required to write).
 *   Windows: C:\ProgramData\RocketRide
 *   macOS:   /Library/RocketRide
 *   Linux:   /opt/rocketride
 */
export function getSystemInstallDir(): string {
	switch (process.platform) {
		case 'win32':
			return path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'RocketRide');
		case 'darwin':
			return '/Library/RocketRide';
		default:
			return '/opt/rocketride';
	}
}

const logger = getLogger();

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Migrates the local engine from the old globalStorage layout to the new
 * per-user directory. Call once during extension activation.
 *
 * Steps:
 *   1. Read the active pointer (current-stable.json or current-pre.json)
 *   2. Copy the contents of the active versioned dir into engine/
 *   3. Write version.local.json with { tag, publishedAt }
 *   4. Move install.lock if present
 *   5. Clean up the old directory
 *
 * @param globalStorageEnginesDir - The old VS Code globalStorage engines path
 *   (e.g., context.globalStorageUri.fsPath + '/engines')
 */
export function migrateLocalEngine(globalStorageEnginesDir: string): void {
	try {
		const userDir = getUserConfigDir();
		const newEngineDir = path.join(userDir, 'engine');
		const versionJsonPath = path.join(userDir, 'version.local.json');

		// Already migrated or fresh install — version.json exists
		if (fs.existsSync(versionJsonPath)) return;

		// Nothing to migrate
		if (!fs.existsSync(globalStorageEnginesDir)) return;

		// Find the active pointer (prefer stable over pre)
		const pointer = readLegacyPointer(globalStorageEnginesDir);
		if (!pointer) return;

		// Validate pointer.dir to prevent directory traversal
		const sourceDir = path.resolve(globalStorageEnginesDir, pointer.dir);
		if (!sourceDir.startsWith(path.resolve(globalStorageEnginesDir) + path.sep)) return;
		if (!fs.existsSync(sourceDir)) return;

		logger.output(`Migrating local engine from ${sourceDir}...`);

		// Copy contents of the versioned dir into the flat engine/ directory
		fs.mkdirSync(newEngineDir, { recursive: true });
		copyDirContents(sourceDir, newEngineDir);

		// Write version.local.json at the parent level (the format EngineInstaller reads)
		const versionData = JSON.stringify({ tag: pointer.tag, publishedAt: pointer.publishedAt }, null, 2);
		fs.mkdirSync(userDir, { recursive: true });
		fs.writeFileSync(versionJsonPath, versionData, 'utf8');

		// Move install.lock if present
		const oldLock = path.join(globalStorageEnginesDir, 'install.lock');
		const newLock = path.join(userDir, '.installing');
		if (fs.existsSync(oldLock) && !fs.existsSync(newLock)) {
			try { fs.renameSync(oldLock, newLock); } catch { /* cross-volume */ }
		}

		// Clean up old directory
		try { fs.rmSync(globalStorageEnginesDir, { recursive: true, force: true }); } catch { /* best effort */ }

		logger.output(`Local engine migration complete: ${pointer.tag}`);
	} catch (err) {
		logger.output(`Local engine migration failed (non-fatal): ${err}`);
	}
}

/**
 * Migrates the service engine config from the old format to the new one.
 * Call once during extension activation (reads are non-elevated).
 *
 * Release layout (c094fa6b):
 *   %PROGRAMDATA%/RocketRide/
 *     config.json         → { versionSpec, version, publishedAt, installedAt }
 *     engines/server-3.2.0--abc123/engine.exe   (versioned dir, NSSM points here)
 *
 * New layout:
 *   %PROGRAMDATA%/RocketRide/
 *     version.service.json → { tag, publishedAt }
 *     engine/engine.exe    (flat dir)
 *
 * We migrate the config metadata only — writing version.service.json so the
 * panel shows the installed version. The binary path change happens when the
 * user clicks Update, which re-registers the NSSM service to point at engine/.
 *
 * If the old engines/ dir exists with a versioned binary but no engine/ dir,
 * we also copy the active version into engine/ so the new code can find it.
 */
export function migrateServiceConfig(): void {
	try {
		const systemDir = getSystemInstallDir();
		const engineDir = path.join(systemDir, 'engine');
		const versionJsonPath = path.join(systemDir, 'version.service.json');

		// Already migrated or fresh install
		if (fs.existsSync(versionJsonPath)) return;

		// Check for old config.json at the system root
		const legacyConfigPath = path.join(systemDir, 'config.json');
		if (!fs.existsSync(legacyConfigPath)) return;

		try {
			const data = JSON.parse(fs.readFileSync(legacyConfigPath, 'utf8'));
			if (!data || !data.version) return;

			const tag = data.tag || `server-${data.version}`;
			const publishedAt = data.publishedAt || '';

			// If the old engines/ dir has the binary but engine/ doesn't exist yet,
			// copy the active version into the flat engine/ directory
			const oldEnginesDir = path.join(systemDir, 'engines');
			if (fs.existsSync(oldEnginesDir) && !fs.existsSync(engineDir)) {
				// Find the versioned dir (e.g., server-3.2.0--abc123)
				const entries = fs.readdirSync(oldEnginesDir, { withFileTypes: true });
				const versionDir = entries.find(e => e.isDirectory() && e.name.includes('--'));
				if (versionDir) {
					const sourceDir = path.join(oldEnginesDir, versionDir.name);
					fs.mkdirSync(engineDir, { recursive: true });
					copyDirContents(sourceDir, engineDir);
					logger.output(`  Copied service engine from ${versionDir.name} to engine/`);
				}
			}

			// Write version.service.json at the parent level so EngineInstaller knows what's installed
			fs.writeFileSync(versionJsonPath, JSON.stringify({ tag, publishedAt }, null, 2), 'utf8');
			logger.output(`Service config migrated: ${tag}`);

			// Keep old config.json around (don't delete) — the NSSM service
			// still points to the old engines/ path until the user updates
		} catch { /* corrupt, skip */ }
	} catch (err) {
		logger.output(`Service config migration failed (non-fatal): ${err}`);
	}
}

// =============================================================================
// HELPERS
// =============================================================================

/** Legacy pointer file shape (current-stable.json / current-pre.json). */
interface LegacyPointer {
	dir: string;
	tag: string;
	publishedAt: string;
}

/**
 * Reads the legacy pointer files from the old engines directory.
 * Prefers stable channel, falls back to prerelease.
 */
function readLegacyPointer(enginesDir: string): LegacyPointer | null {
	for (const channel of ['stable', 'pre']) {
		const pointerPath = path.join(enginesDir, `current-${channel}.json`);
		try {
			if (fs.existsSync(pointerPath)) {
				const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
				if (pointer && pointer.tag && pointer.dir) {
					return {
						dir: pointer.dir,
						tag: pointer.tag,
						publishedAt: pointer.publishedAt || '',
					};
				}
			}
		} catch { /* corrupt, skip */ }
	}
	return null;
}

/**
 * Copies the contents of one directory into another (non-recursive top-level
 * files + recursive subdirectories). Does not copy the source dir itself.
 */
function copyDirContents(src: string, dst: string): void {
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const srcPath = path.join(src, entry.name);
		const dstPath = path.join(dst, entry.name);
		if (entry.isDirectory()) {
			copyDirRecursive(srcPath, dstPath);
		} else {
			fs.copyFileSync(srcPath, dstPath);
		}
	}
}

/** Recursively copies a directory tree. */
function copyDirRecursive(src: string, dst: string): void {
	fs.mkdirSync(dst, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const srcPath = path.join(src, entry.name);
		const dstPath = path.join(dst, entry.name);
		if (entry.isDirectory()) {
			copyDirRecursive(srcPath, dstPath);
		} else {
			fs.copyFileSync(srcPath, dstPath);
		}
	}
}
