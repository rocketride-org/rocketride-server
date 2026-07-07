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
 * Pure helpers for maintaining the workspace `.env` file that the RocketRide
 * SDK/CLI read (`ROCKETRIDE_URI` / `ROCKETRIDE_APIKEY`).
 *
 * These functions are deliberately free of any `vscode` import so they can be
 * unit-tested standalone with `node:test` (see envFile.test.ts). The actual
 * filesystem read/write lives in the ConnectionManager, which already depends
 * on `vscode`.
 */

import { connectionModeUsesOAuth } from './connectionModeAuth';

/** The two keys the RocketRide SDK/CLI look up to reach the engine. */
export const ROCKETRIDE_URI_KEY = 'ROCKETRIDE_URI';
export const ROCKETRIDE_APIKEY_KEY = 'ROCKETRIDE_APIKEY';

/** Quote a value only when it contains characters that would break parsing. */
function quoteIfNeeded(value: string): string {
	return /[\s#=]/.test(value) ? `"${value}"` : value;
}

/**
 * Patches `.env` text by updating, adding, or removing keys while preserving
 * comments, blank lines, ordering, and unrelated user variables.
 *
 * - Existing keys present in `updates` are rewritten in place.
 * - Keys in `updates` not already present are appended (after a blank
 *   separator line when the file has trailing content).
 * - Keys in `keysToRemove` are dropped.
 * - When `existingText` is empty/whitespace, the file is generated from the
 *   `updates` alone (one `KEY=VALUE` line each, trailing newline).
 *
 * Idempotent: `mergeEnvText(mergeEnvText(t, u), u) === mergeEnvText(t, u)`.
 */
export function mergeEnvText(
	existingText: string,
	updates: Record<string, string>,
	keysToRemove?: Set<string>,
): string {
	// New/empty file — generate from scratch in insertion order.
	if (!existingText.trim()) {
		const keys = Object.keys(updates);
		if (keys.length === 0) {
			return existingText;
		}
		return keys.map((key) => `${key}=${quoteIfNeeded(updates[key])}`).join('\n') + '\n';
	}

	const lines = existingText.split('\n');
	const consumedKeys = new Set<string>();
	const resultLines: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		// Preserve blank lines and comments verbatim.
		if (!trimmed || trimmed.startsWith('#')) {
			resultLines.push(line);
			continue;
		}

		// Preserve anything that isn't a KEY=VALUE assignment verbatim.
		const match = trimmed.match(/^([^=]+)=(.*)$/);
		if (!match) {
			resultLines.push(line);
			continue;
		}

		const key = match[1].trim();

		if (keysToRemove && keysToRemove.has(key)) {
			continue;
		}

		if (key in updates) {
			resultLines.push(`${key}=${quoteIfNeeded(updates[key])}`);
			consumedKeys.add(key);
		} else {
			resultLines.push(line);
		}
	}

	// Append keys that weren't already present.
	const newKeys = Object.keys(updates).filter((k) => !consumedKeys.has(k));
	if (newKeys.length > 0) {
		const lastLine = resultLines[resultLines.length - 1];
		if (lastLine !== undefined && lastLine.trim() !== '') {
			resultLines.push('');
		}
		for (const key of newKeys) {
			resultLines.push(`${key}=${quoteIfNeeded(updates[key])}`);
		}
	}

	return resultLines.join('\n');
}

/** Inputs for {@link resolveConnectionEnv}. */
export interface ConnectionEnvArgs {
	/** Connection group — only the `development` group owns the project `.env`. */
	group: string;
	/** Resolved connection mode (local/docker/service/onprem/cloud). */
	mode: string;
	/** HTTP(S) base URL of the engine (e.g. `http://localhost:54321`). */
	httpUrl: string;
	/** The API key used to authenticate this connection. */
	apiKey: string;
}

/**
 * Decides which `ROCKETRIDE_*` vars the extension should persist to the
 * workspace `.env` for a given connection, or `null` when it should not touch
 * `.env` at all.
 *
 * Rules:
 * - Only the `development` connection writes `.env` (the SDK/CLI dev workflow);
 *   the `deployment` group must never fight over the same file.
 * - Cloud is skipped: it authenticates with a short-lived OAuth token, which is
 *   not usable as an SDK API key. Self-hosted modes (local/docker/service/
 *   onprem) get a real, reusable URI + key.
 * - A missing/empty `httpUrl` yields `null` (nothing useful to write).
 */
export function resolveConnectionEnv(args: ConnectionEnvArgs): Record<string, string> | null {
	const { group, mode, httpUrl, apiKey } = args;

	if (group !== 'development') {
		return null;
	}
	if (connectionModeUsesOAuth(mode)) {
		return null;
	}
	if (!httpUrl) {
		return null;
	}

	const updates: Record<string, string> = { [ROCKETRIDE_URI_KEY]: httpUrl };
	if (apiKey) {
		updates[ROCKETRIDE_APIKEY_KEY] = apiKey;
	}
	return updates;
}
