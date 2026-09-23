// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Default-browser resolution for app debug launches.
 *
 * js-debug can only drive Chromium browsers over CDP, through its 'chrome'
 * and 'msedge' launch types. This module maps the developer's OS default
 * browser onto one of those types so F5 opens the browser they actually
 * use: Chrome and Edge map to their native types, other Chromium browsers
 * (Brave, Vivaldi, Opera, Arc) launch through the 'chrome' type with an
 * explicit runtimeExecutable, and a non-Chromium default (Firefox) falls
 * back to Edge — the one debuggable browser every Windows install carries
 * — with a log line explaining why.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import { getLogger } from '../shared/util/output';

const execFileAsync = promisify(execFile);

// =============================================================================
// TYPES
// =============================================================================

/** A js-debug browser launch target: the debug type plus, when the default
 * browser is a Chromium other than Chrome/Edge, the executable to run. */
export interface BrowserDebugTarget {
	/** js-debug launch type — the only two CDP-capable types. */
	type: 'chrome' | 'msedge';
	/** Explicit browser binary when the type alone would launch the wrong
	 * Chromium (e.g. Brave resolved through the 'chrome' type). */
	runtimeExecutable?: string;
}

// =============================================================================
// WINDOWS REGISTRY
// =============================================================================

/**
 * Reads the Windows default-browser ProgId for http URLs from the
 * per-user UserChoice registry key (the value the Settings app writes).
 *
 * @returns The ProgId (e.g. "ChromeHTML", "MSEdgeHTM"), or undefined when
 *          the key is absent or unreadable.
 */
async function readDefaultBrowserProgId(): Promise<string | undefined> {
	// step: query the UserChoice key — the authoritative per-user default
	const key = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice';
	try {
		const { stdout } = await execFileAsync('reg', ['query', key, '/v', 'ProgId']);
		// step: the value line reads "    ProgId    REG_SZ    ChromeHTML"
		const match = stdout.match(/ProgId\s+REG_SZ\s+(\S+)/);
		return match?.[1];
	} catch {
		// No UserChoice key (or reg unavailable) — caller falls back
		return undefined;
	}
}

/**
 * Resolves a ProgId's registered open command to its executable path, so a
 * non-Chrome Chromium default (Brave, Vivaldi, ...) can be launched as the
 * js-debug runtimeExecutable.
 *
 * @param progId - The browser's ProgId from UserChoice.
 * @returns An existing executable path, or undefined when it cannot be
 *          resolved (missing key, unparseable command, file gone).
 */
async function resolveProgIdExecutable(progId: string): Promise<string | undefined> {
	try {
		// step: the ProgId's shell open command names the browser binary
		const { stdout } = await execFileAsync('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve']);
		// step: command is `"C:\...\browser.exe" -- "%1"` — take the quoted
		// path, or the first token ending in .exe when unquoted
		const match = stdout.match(/REG_SZ\s+(?:"([^"]+)"|(\S+\.exe))/i);
		const exe = match?.[1] || match?.[2];
		return exe && fs.existsSync(exe) ? exe : undefined;
	} catch {
		return undefined;
	}
}

// =============================================================================
// RESOLUTION
// =============================================================================

/** Resolved once per session — the default browser does not change under a
 * running editor often enough to justify re-querying the registry per F5. */
let cachedTarget: Promise<BrowserDebugTarget> | undefined;

/**
 * Resolves the OS default browser to a js-debug launch target.
 *
 * Windows resolves through the registry as documented in the module
 * header. Non-Windows platforms return the 'chrome' type — Edge is rarely
 * installed on macOS/Linux developer machines, and js-debug's own Chrome
 * discovery handles the common Chromium installs there.
 *
 * @returns The launch target; never rejects — every failure path falls
 *          back to a usable type with a log line.
 */
export function resolveBrowserDebugTarget(): Promise<BrowserDebugTarget> {
	cachedTarget ??= resolveUncached();
	return cachedTarget;
}

/**
 * The uncached resolution behind resolveBrowserDebugTarget().
 *
 * @returns The launch target for this machine's default browser.
 */
async function resolveUncached(): Promise<BrowserDebugTarget> {
	const logger = getLogger();

	// step: non-Windows — let js-debug's Chrome discovery do the work
	if (process.platform !== 'win32') return { type: 'chrome' };

	// step: map the default browser's ProgId onto a debuggable type
	const progId = await readDefaultBrowserProgId();
	if (!progId) {
		logger.output('[appdev] could not read the default browser from the registry — debugging with Edge');
		return { type: 'msedge' };
	}
	if (/^Chrome/i.test(progId)) return { type: 'chrome' };
	if (/^MSEdge/i.test(progId)) return { type: 'msedge' };

	// step: other Chromium browsers run through the 'chrome' type with the
	// registered binary as runtimeExecutable
	if (/^(Brave|Opera|Vivaldi|Arc|Chromium)/i.test(progId)) {
		const exe = await resolveProgIdExecutable(progId);
		if (exe) return { type: 'chrome', runtimeExecutable: exe };
		logger.output(`[appdev] default browser "${progId}" is Chromium-based but its executable could not be resolved — debugging with Edge`);
		return { type: 'msedge' };
	}

	// step: non-Chromium default (Firefox etc.) — js-debug cannot attach
	logger.output(`[appdev] default browser "${progId}" is not Chromium-based (js-debug requires CDP) — debugging with Edge`);
	return { type: 'msedge' };
}
