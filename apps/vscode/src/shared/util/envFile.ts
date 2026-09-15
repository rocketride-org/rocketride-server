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
 * SDK/CLI read. Two variable pairs mirror the extension's two connection
 * groups: `ROCKETRIDE_URI`/`ROCKETRIDE_APIKEY` for the DEVELOPMENT connection
 * (run/validate/iterate) and `ROCKETRIDE_DEPLOY_URI`/`ROCKETRIDE_DEPLOY_APIKEY`
 * for the DEPLOYMENT TARGET (deploy/publish/schedule). The deploy pair's
 * presence is the signal that a deploy target is configured — agents must
 * never fall back to the dev pair for lifecycle verbs.
 *
 * These functions are deliberately free of any `vscode` import so they can be
 * unit-tested standalone with `node:test` (see envFile.test.ts). The actual
 * filesystem read/write lives in the ConnectionManager, which already depends
 * on `vscode`.
 */

import type { ConnectionGroup, ConnectionMode } from '../../config';

/** The keys the RocketRide SDK/CLI look up to reach the development engine. */
export const ROCKETRIDE_URI_KEY = 'ROCKETRIDE_URI';
export const ROCKETRIDE_APIKEY_KEY = 'ROCKETRIDE_APIKEY';

/** The keys automation uses to reach the DEPLOYMENT TARGET server. */
export const ROCKETRIDE_DEPLOY_URI_KEY = 'ROCKETRIDE_DEPLOY_URI';
export const ROCKETRIDE_DEPLOY_APIKEY_KEY = 'ROCKETRIDE_DEPLOY_APIKEY';

/** The `.env` variable pair a connection group owns. */
export function envKeysForGroup(group: ConnectionGroup): { uriKey: string; apiKeyKey: string } {
	return group === 'deployment'
		? { uriKey: ROCKETRIDE_DEPLOY_URI_KEY, apiKeyKey: ROCKETRIDE_DEPLOY_APIKEY_KEY }
		: { uriKey: ROCKETRIDE_URI_KEY, apiKeyKey: ROCKETRIDE_APIKEY_KEY };
}

/**
 * Doctrine comments the sync maintains directly above each managed pair —
 * the one documentation layer that reaches every agent, because it travels
 * with the credential itself.
 */
export const DEV_PAIR_COMMENT = '# RocketRide development connection (managed): use for running, validating, and iterating - use(), send/chat, monitors, the app dev loop.';
export const DEPLOY_PAIR_COMMENT = '# RocketRide deployment target (managed): use for deploy.*, schedules, publishApp/submitApp, build logs. If these lines are absent, no deploy target is configured - ask the user; never deploy to the dev connection.';

/** Quote a value only when it contains characters that would break parsing. */
function quoteIfNeeded(value: string): string {
	const isWrappedInMatchingQuotes =
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"));
	if (!/[\s#=]/.test(value) && !isWrappedInMatchingQuotes) {
		return value;
	}

	// Written so client.py's parser reads back exactly the original value.
	if (value.endsWith('"') && !value.includes("'")) {
		return `'${value}'`;
	}
	return `"${value}"`;
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
	const updateEntries = Object.entries(updates);

	// New/empty file — generate from scratch in insertion order.
	if (!existingText.trim()) {
		if (updateEntries.length === 0) {
			return existingText;
		}
		const eol = existingText.includes('\r\n') ? '\r\n' : '\n';
		return updateEntries.map(([key, value]) => `${key}=${quoteIfNeeded(value)}`).join(eol) + eol;
	}

	// Match the file's existing line-ending convention so rewritten or appended
	// lines don't produce a mixed CRLF/LF file.
	const eol = existingText.includes('\r\n') ? '\r\n' : '\n';
	const lines = existingText.split(/\r?\n/);
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

		if (Object.hasOwn(updates, key)) {
			resultLines.push(`${key}=${quoteIfNeeded(updates[key])}`);
			consumedKeys.add(key);
		} else {
			resultLines.push(line);
		}
	}

	// Append keys that weren't already present.
	const newEntries = updateEntries.filter(([key]) => !consumedKeys.has(key));
	if (newEntries.length > 0) {
		const lastLine = resultLines[resultLines.length - 1];
		if (lastLine !== undefined && lastLine.trim() !== '') {
			resultLines.push('');
		}
		for (const [key, value] of newEntries) {
			resultLines.push(`${key}=${quoteIfNeeded(value)}`);
		}
	}

	return resultLines.join(eol);
}

/** Inputs for {@link resolveConnectionEnv}. */
export interface ConnectionEnvArgs {
	/** Connection group — only the `development` group owns the project `.env`. */
	group: ConnectionGroup;
	/** Resolved connection mode (local/docker/service/onprem/cloud). */
	mode: ConnectionMode;
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
 * - Each group writes ITS OWN pair: development owns `ROCKETRIDE_URI`/
 *   `ROCKETRIDE_APIKEY`, deployment owns the `ROCKETRIDE_DEPLOY_*` pair —
 *   the two never fight over the same keys.
 * - Every mode writes, cloud included: the cloud credential is the same
 *   persistent `rr_*` key the extension itself connects with (minted at
 *   sign-in; it is NOT a short-lived OAuth access token), so it is exactly
 *   as usable by the SDK/CLI as a self-hosted API key.
 * - A missing/empty `httpUrl` yields `null` (nothing useful to write).
 */
export function resolveConnectionEnv(args: ConnectionEnvArgs): Record<string, string> | null {
	const { group, httpUrl, apiKey } = args;

	if (!httpUrl || /[\r\n]/.test(httpUrl) || /[\r\n]/.test(apiKey)) {
		return null;
	}

	const { uriKey, apiKeyKey } = envKeysForGroup(group);
	const updates: Record<string, string> = { [uriKey]: httpUrl };
	if (apiKey) {
		updates[apiKeyKey] = apiKey;
	}
	return updates;
}

/**
 * Ensures the doctrine comment sits directly above each managed pair's URI
 * line, so any agent reading `.env` learns which pair serves which purpose
 * at the moment of use. Idempotent: comments are added only when the line
 * immediately above the URI assignment is not already the managed comment,
 * and stale copies of the managed comments elsewhere are removed first.
 */
export function applyManagedComments(envText: string): string {
	if (!envText.trim()) {
		return envText;
	}
	const eol = envText.includes('\r\n') ? '\r\n' : '\n';
	const managed: Array<[string, string]> = [
		[ROCKETRIDE_URI_KEY, DEV_PAIR_COMMENT],
		[ROCKETRIDE_DEPLOY_URI_KEY, DEPLOY_PAIR_COMMENT],
	];
	// Drop stale managed comments so moved/re-appended pairs re-anchor cleanly.
	const managedComments = new Set(managed.map(([, comment]) => comment));
	const lines = envText.split(/\r?\n/).filter((line) => !managedComments.has(line.trim()));

	for (const [uriKey, comment] of managed) {
		const index = lines.findIndex((line) => line.trim().startsWith(`${uriKey}=`));
		if (index === -1) {
			continue;
		}
		lines.splice(index, 0, comment);
	}
	return lines.join(eol);
}
