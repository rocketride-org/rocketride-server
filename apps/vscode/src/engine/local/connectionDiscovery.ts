// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Pure helpers for the local engine's connection discovery file.
 *
 * `--port=0` gives the local engine a fresh OS-assigned port every time it
 * (re)starts, and that port previously lived only in this VS Code window's
 * in-memory state (plus, since #1413/#1492, the workspace `.env`). Neither
 * helps a process that isn't this specific window's own connect flow: a
 * long-running external script keeps whatever URI it read at its own
 * startup and has no signal that the engine restarted underneath it, and a
 * script not tied to this workspace has no `.env` to read at all. The only
 * previously-documented way to find the live port was `lsof` against the
 * engine's process name.
 *
 * This writes the resolved URI to a small, fixed, workspace-independent file
 * under the engine's own install directory (`getUserConfigDir()` from
 * `../config/config-migration`, i.e. `~/Library/Application Support/RocketRide`
 * on macOS, already the canonical "where does the local engine live"
 * directory that `version.json`/`engine-<pid>.pid` also live in) so any
 * process on the machine can find the currently-running local engine without
 * being the one that started it.
 *
 * Scope/limitation, deliberately: this is a single "last-connected" file, not
 * a registry of every concurrently-running engine across multiple VS Code
 * windows. For the reported problem -- one developer, one local engine,
 * losing track of it across reloads -- "last connected" is exactly the
 * right answer. Disambiguating multiple simultaneous local engines is a
 * separate, harder problem nobody asked for here; `pid` is included so a
 * consumer that cares can at least check the writer is still alive.
 *
 * These functions are deliberately free of any `vscode` import so they can
 * be unit-tested standalone with `node:test` (see connectionDiscovery.test.ts).
 * The actual filesystem read/write lives in EngineLocal, which already uses
 * `fs` synchronously for its PID files.
 */

import * as path from 'path';

/** Shape of the connection discovery file's contents. */
export interface ConnectionDiscoveryInfo {
	uri: string;
	/** Local mode always uses the fixed default; see `writeConnectionDiscovery`. */
	apiKey: string;
	/** PID of the writer, so a stale entry left behind by a crash (no clean
	 * `stop()`) can be told apart from a live one. */
	pid: number;
	updatedAt: string;
}

/** Filename of the discovery file within the engine's install directory. */
export const CONNECTION_DISCOVERY_FILENAME = 'connection.json';

/**
 * Path to the discovery file given the local engine's install directory
 * (the same directory `EngineInstaller`/`engine-<pid>.pid` already use).
 */
export function connectionDiscoveryPath(engineDir: string): string {
	return path.join(engineDir, CONNECTION_DISCOVERY_FILENAME);
}

/** Serializes discovery info to the file's on-disk JSON text. */
export function serializeConnectionDiscovery(info: ConnectionDiscoveryInfo): string {
	return JSON.stringify(info, null, 2) + '\n';
}

/**
 * Parses the discovery file's text, returning `null` for anything that isn't
 * a well-formed `ConnectionDiscoveryInfo` (missing file, invalid JSON, or a
 * shape from some future/incompatible version) rather than throwing --
 * callers on the read side should treat this purely as an optional hint.
 */
export function parseConnectionDiscovery(text: string): ConnectionDiscoveryInfo | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (
		!data ||
		typeof data !== 'object' ||
		typeof (data as Record<string, unknown>).uri !== 'string' ||
		typeof (data as Record<string, unknown>).pid !== 'number'
	) {
		return null;
	}
	const record = data as Record<string, unknown>;
	return {
		uri: record.uri as string,
		apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
		pid: record.pid as number,
		updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
	};
}
