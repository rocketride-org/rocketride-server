/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Workspace `.env` handling shared by every RocketRide client front-end
 * (the CLI executable and the VS Code extension).
 *
 * The reader loads the workspace `.env` into `process.env` without
 * overriding the real environment (same precedence as the Python SDK's
 * loader). The writer is line-preserving: credential updates rewrite
 * only the keys they own and leave every other line of the user's
 * `.env` (comments, unrelated variables, ordering) untouched.
 *
 * Behavioral twin of `client-common/python`'s `env.py` — changes here
 * must be mirrored there.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The two connection pairs the clients read and write. */
export const ENV_DEV_URI = 'ROCKETRIDE_URI';
export const ENV_DEV_APIKEY = 'ROCKETRIDE_APIKEY';
export const ENV_DEPLOY_URI = 'ROCKETRIDE_DEPLOY_URI';
export const ENV_DEPLOY_APIKEY = 'ROCKETRIDE_DEPLOY_APIKEY';

/** The standard hard-stop message for a missing deploy pair. */
export const NO_DEPLOY_TARGET_MESSAGE = 'No deployment target configured. Set ROCKETRIDE_DEPLOY_URI / ROCKETRIDE_DEPLOY_APIKEY (or pass --uri/--apikey) - the development connection is never a deploy fallback.';

/**
 * Parse one `.env` line into a key/value pair.
 *
 * Supports `KEY=VALUE`, an optional `export ` prefix, single or double
 * quotes around the value, and `#` comment lines.
 *
 * @param line - Raw line from the file.
 * @returns The parsed pair, or null when the line is not an assignment.
 */
export function parseEnvLine(line: string): { key: string; value: string } | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith('#')) {
		return null;
	}
	const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
	const eq = withoutExport.indexOf('=');
	if (eq <= 0) {
		return null;
	}
	const key = withoutExport.slice(0, eq).trim();
	let value = withoutExport.slice(eq + 1).trim();
	// Strip one matching pair of surrounding quotes
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		value = value.slice(1, -1);
	}
	return { key, value };
}

/**
 * Load `<cwd>/.env` into `process.env` without overriding variables the
 * caller's real environment already defines (real environment wins).
 *
 * @param cwd - Directory holding the `.env` file (default: process.cwd()).
 */
export function loadDotEnv(cwd: string = process.cwd()): void {
	const envPath = path.join(cwd, '.env');
	if (!fs.existsSync(envPath)) {
		return;
	}
	// step: parse every assignment line and setdefault it into process.env
	const content = fs.readFileSync(envPath, 'utf-8');
	for (const line of content.split(/\r?\n/)) {
		const pair = parseEnvLine(line);
		if (pair && process.env[pair.key] === undefined) {
			process.env[pair.key] = pair.value;
		}
	}
}

/**
 * Update keys in `<cwd>/.env`, preserving every other line verbatim.
 *
 * Existing assignments to the given keys are rewritten in place; keys
 * with no existing assignment are appended at the end. Creates the file
 * when absent.
 *
 * @param updates - Key/value pairs to persist.
 * @param cwd - Directory holding the `.env` file (default: process.cwd()).
 * @returns The path of the file written.
 */
export function writeDotEnv(updates: Record<string, string>, cwd: string = process.cwd()): string {
	const envPath = path.join(cwd, '.env');
	const pending = new Map(Object.entries(updates));
	const lines: string[] = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8').split(/\r?\n/) : [];

	// step: rewrite lines that assign one of the updated keys
	const output = lines.map((line) => {
		const pair = parseEnvLine(line);
		if (pair && pending.has(pair.key)) {
			const value = pending.get(pair.key)!;
			pending.delete(pair.key);
			return `${pair.key}=${value}`;
		}
		return line;
	});

	// step: append keys that had no existing assignment
	if (pending.size > 0) {
		// Drop trailing blank lines so appends stay adjacent
		while (output.length > 0 && output[output.length - 1].trim() === '') {
			output.pop();
		}
		for (const [key, value] of pending) {
			output.push(`${key}=${value}`);
		}
	}

	fs.writeFileSync(envPath, output.join('\n') + '\n', 'utf-8');
	return envPath;
}
