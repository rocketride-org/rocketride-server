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

/** A key the runner holds: its name, and its value, which nothing prints. */
export interface HeldKey {
	name: string;
	value: string;
}

/** The engine's names for the model keys, and the names a shell usually has them under. */
export const MODEL_KEYS: ReadonlyArray<{ variable: string; alias: string }> = [
	{ variable: 'ROCKETRIDE_ANTHROPIC_KEY', alias: 'ANTHROPIC_API_KEY' },
	{ variable: 'ROCKETRIDE_OPENAI_KEY', alias: 'OPENAI_API_KEY' },
];

/** Values shorter than this are not treated as secrets: too short to scan for without false hits. */
const MIN_SECRET = 8;

/** Key shapes to blank even when the runner does not hold the key; a shape must start a token, so a task id such as ask-01-which-vector-db is not one (canary.ts KEY_SHAPES). */
const KEY_SHAPES = [/(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{8,}/g, /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g];

/**
 * A ROCKETRIDE_ variable whose name says it holds settings, not a secret: the
 * builder sets ROCKETRIDE_BUILD_ROOT and ROCKETRIDE_DIST_ROOT. Every other
 * ROCKETRIDE_ value counts as a secret, since the engine resolves any of them
 * into a pipeline (${ROCKETRIDE_...}).
 */
const SETTING_NAME = /^ROCKETRIDE_[A-Z0-9_]*_(ROOT|DIR|PATH|URL|URI|HOST|PORT|MODE|LEVEL)$/;

/**
 * The keys in this process's environment that the engine will get: the
 * model keys under either name, and every other ROCKETRIDE_ variable except
 * the settings (SETTING_NAME).
 *
 * @param env - The environment to read (process.env by default).
 * @returns The keys, each once, by the engine's name.
 */
export function heldKeys(env: NodeJS.ProcessEnv = process.env): HeldKey[] {
	const keys = new Map<string, string>();
	for (const { variable, alias } of MODEL_KEYS) {
		const value = env[variable] || env[alias];
		if (value) keys.set(variable, value);
	}
	for (const [name, value] of Object.entries(env)) {
		if (name.startsWith('ROCKETRIDE_') && !SETTING_NAME.test(name) && value && value.length >= MIN_SECRET && !keys.has(name)) keys.set(name, value);
	}
	return [...keys].map(([name, value]) => ({ name, value }));
}

/**
 * The environment without the held keys or the model keys' other names, for
 * a process that must not see a key (the dev servers).
 *
 * @param env - The environment (process.env by default).
 */
export function withoutKeys(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const drop = new Set([...heldKeys(env).map((k) => k.name), ...MODEL_KEYS.flatMap((k) => [k.variable, k.alias])]);
	return Object.fromEntries(Object.entries(env).filter(([name]) => !drop.has(name)));
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
	 * @returns The text with each held value replaced by its name, and other key shapes blanked.
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
