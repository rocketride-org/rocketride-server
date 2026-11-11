// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EVIDENCE: model keys out of everything a trial writes
// =============================================================================

/**
 * The runner holds the model keys only to hand them to the engine's
 * environment. Every file a trial writes goes through a Scrubber first, and
 * the trial ends by scanning its own folder for the key values (findLeaks).
 * A task's canaries are fake keys and stay visible, so the leak checks can
 * find them.
 */

import fs from 'node:fs';
import path from 'node:path';

import { KEY_SHAPES } from './canary';

/** A key the runner holds: its name, and its value, which nothing prints. */
export interface HeldKey {
	name: string;
	value: string;
}

/** The model keys: the env file name the runner reads each one from, and the engine's name for it. */
export const MODEL_KEYS: ReadonlyArray<{ source: string; variable: string }> = [
	{ source: 'EVAL_ANTHROPIC_KEY', variable: 'ROCKETRIDE_ANTHROPIC_KEY' },
	{ source: 'EVAL_OPENAI_KEY', variable: 'ROCKETRIDE_OPENAI_KEY' },
];

/**
 * Names no process the runner starts takes from its environment: every name
 * a shell keeps a model key under. The engine gets the two model keys from
 * the env file only, so a shell's own key never stands in for an eval key.
 */
const NEVER_PASSED = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|ROCKETRIDE_ANTHROPIC_KEY|ROCKETRIDE_OPENAI_KEY|EVAL_[A-Za-z0-9_]*)$/;

/** Values shorter than this are not treated as secrets: too short to scan for without false hits. */
const MIN_SECRET = 8;

/** One `NAME=value` line of an env file, with an optional `export `. */
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/** A value without its surrounding quotes, or an unquoted value without a trailing ` # comment`. */
function unquote(raw: string): string {
	const quoted = /^(['"])(.*)\1$/.exec(raw);
	return quoted ? (quoted[2] ?? '') : raw.replace(/\s+#.*$/, '');
}

/**
 * Reads the two model keys from an env file, by their EVAL_ names, and skips
 * every other line. Errors name the file and the missing names, never a value.
 *
 * @param file - The env file.
 * @returns The keys, by the engine's names.
 */
export function readModelKeys(file: string): HeldKey[] {
	if (!fs.existsSync(file)) throw new Error(`no env file at ${file}; it must set ${MODEL_KEYS.map((k) => k.source).join(' and ')} (--env-file names another)`);
	const wanted = new Set(MODEL_KEYS.map((k) => k.source));
	const values = new Map<string, string>();
	for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
		const m = ENV_LINE.exec(line);
		if (m?.[1] && wanted.has(m[1])) values.set(m[1], unquote(m[2] ?? ''));
	}
	const missing = MODEL_KEYS.filter((k) => !values.get(k.source)).map((k) => k.source);
	if (missing.length) throw new Error(`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing or empty in ${file}`);
	return MODEL_KEYS.map((k) => ({ name: k.variable, value: values.get(k.source) as string }));
}

/**
 * A ROCKETRIDE_ variable whose name says it holds settings, not a secret: the
 * builder sets ROCKETRIDE_BUILD_ROOT and ROCKETRIDE_DIST_ROOT. Every other
 * ROCKETRIDE_ value counts as a secret, since the engine resolves any of them
 * into a pipeline (${ROCKETRIDE_...}).
 */
const SETTING_NAME = /^ROCKETRIDE_[A-Z0-9_]*_(ROOT|DIR|PATH|URL|URI|HOST|PORT|MODE|LEVEL)$/;

/**
 * The keys the engine will get: the two model keys from the env file, and
 * every other ROCKETRIDE_ variable in this process's environment except the
 * settings (SETTING_NAME).
 *
 * @param modelKeys - The model keys (readModelKeys).
 * @param env - The environment to read (process.env by default).
 * @returns The keys, each once, by the engine's name.
 */
export function heldKeys(modelKeys: HeldKey[], env: NodeJS.ProcessEnv = process.env): HeldKey[] {
	const keys = new Map(modelKeys.map((k) => [k.name, k.value]));
	for (const [name, value] of Object.entries(env)) {
		if (name.startsWith('ROCKETRIDE_') && !NEVER_PASSED.test(name) && !SETTING_NAME.test(name) && value && value.length >= MIN_SECRET && !keys.has(name)) keys.set(name, value);
	}
	return [...keys].map(([name, value]) => ({ name, value }));
}

/**
 * The environment without any model key name or other held key, for a
 * process that must not see a key (the dev servers, the browser, the app builds).
 *
 * @param env - The environment (process.env by default).
 */
export function withoutKeys(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const held = new Set(heldKeys([], env).map((k) => k.name));
	return Object.fromEntries(Object.entries(env).filter(([name]) => !NEVER_PASSED.test(name) && !held.has(name)));
}

/**
 * The engine's environment: this process's, without any model key name, plus
 * the two model keys from the env file under the engine's names.
 *
 * @param modelKeys - The model keys (readModelKeys).
 * @param env - The environment (process.env by default).
 */
export function engineEnv(modelKeys: HeldKey[], env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const base = Object.fromEntries(Object.entries(env).filter(([name]) => !NEVER_PASSED.test(name)));
	return { ...base, ...Object.fromEntries(modelKeys.map((k) => [k.name, k.value])) };
}

/**
 * Writes a stream to a file a line at a time, each line scrubbed, so a key
 * split across two chunks is still caught and nothing unscrubbed is ever on disk.
 *
 * @param fd - The open file.
 * @param scrubber - The scrubber.
 * @returns write(chunk) for each chunk, and end() for the last partial line.
 */
export function scrubbedLines(fd: number, scrubber: Scrubber): { write(chunk: Buffer | string): void; end(): void } {
	let rest = '';
	return {
		write(chunk) {
			const text = rest + chunk.toString();
			const cut = text.lastIndexOf('\n') + 1;
			rest = text.slice(cut);
			if (cut) fs.writeSync(fd, scrubber.scrub(text.slice(0, cut)));
		},
		end() {
			if (rest) fs.writeSync(fd, scrubber.scrub(rest));
			rest = '';
		},
	};
}

/** Blanks the held key values and key-shaped strings, keeping the task's canaries visible. */
export class Scrubber {
	private readonly keys: HeldKey[];
	private readonly keep: string[];

	/**
	 * @param keys - The keys whose values must not appear.
	 * @param keep - Fake values that stay visible (the task's canaries).
	 */
	constructor(keys: HeldKey[], keep: string[] = []) {
		this.keys = keys.filter((k) => k.value.length >= MIN_SECRET);
		this.keep = keep.filter(Boolean);
	}

	/** A scrubber that also keeps these values visible. */
	keeping(values: string[]): Scrubber {
		return new Scrubber(this.keys, [...this.keep, ...values]);
	}

	/**
	 * @param text - Text bound for an evidence file.
	 * @returns The text with each held value replaced by its name, and other key shapes (canary.ts KEY_SHAPES) blanked even when the runner does not hold the key.
	 */
	scrub(text: string): string {
		let out = text;
		for (const k of this.keys) out = out.split(k.value).join(`[redacted ${k.name}]`);
		const keepIt = (m: string) => (this.keep.some((c) => m.includes(c) || c.includes(m)) ? m : '[redacted]');
		for (const shape of KEY_SHAPES) out = out.replace(shape, keepIt);
		return out;
	}
}

/** Where a held key turned up. Names only. */
export interface Leak {
	file: string;
	key: string;
}

/**
 * Scans every file under a folder for each held key's value, and for the
 * value's first 16 characters, so a key cut short is found too.
 *
 * @param dir - The folder.
 * @param keys - The held keys.
 * @returns Each file and key name found, with the file relative to dir.
 */
export function findLeaks(dir: string, keys: HeldKey[]): Leak[] {
	const probes = keys.filter((k) => k.value.length >= MIN_SECRET).map((k) => ({ name: k.name, parts: [k.value, k.value.slice(0, 16)] }));
	if (!probes.length || !fs.existsSync(dir)) return [];
	const leaks: Leak[] = [];
	for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) {
		const file = path.join(dir, rel);
		if (!fs.statSync(file).isFile()) continue;
		const text = fs.readFileSync(file).toString('latin1');
		for (const p of probes) if (p.parts.some((part) => text.includes(part))) leaks.push({ file: rel, key: p.name });
	}
	return leaks;
}
