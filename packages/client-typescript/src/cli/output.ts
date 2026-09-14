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
 * CLI output channel with uniform `--json` semantics.
 *
 * Every CLI command routes its user-facing output through one Output
 * instance so the three output modes behave identically everywhere:
 *
 *   - human (default): line-oriented, append-only text on stdout.
 *   - `--json`: stdout carries EXACTLY one JSON value (the command result
 *     or an error envelope); human progress lines are suppressed so
 *     stdout stays machine-parseable.
 *   - `--json=<file>`: the JSON value is written to the file and the
 *     human lines keep flowing on stdout.
 *
 * Errors print as one `Error: <message> — <hint>` sentence on stderr in
 * every mode (stderr is never JSON), and in JSON modes the payload is an
 * `{ error: { message, hint } }` envelope so scripted callers never have
 * to parse prose.
 */

import * as fs from 'fs';

/** Parsed value of the `--json [file]` option: absent, bare, or a path. */
export type JsonOption = string | boolean | undefined;

/**
 * Uniform output channel for one CLI command invocation.
 */
export class Output {
	/** 'human' | 'stdout' (bare --json) | 'file' (--json=<path>). */
	private mode: 'human' | 'stdout' | 'file';

	/** Destination path when mode is 'file'. */
	private filePath: string = '';

	/** The command's JSON result; set once by result()/fail(). */
	private payload: unknown = undefined;

	/**
	 * Create the channel from the command's `--json` option value.
	 *
	 * @param json - Commander's `--json [file]` value: undefined (human
	 *   mode), true (JSON on stdout), or a file path (JSON to file).
	 */
	constructor(json: JsonOption) {
		if (json === undefined || json === false) {
			this.mode = 'human';
		} else if (json === true) {
			this.mode = 'stdout';
		} else {
			this.mode = 'file';
			this.filePath = json;
		}
	}

	/** Whether JSON output was requested in any form. */
	get jsonRequested(): boolean {
		return this.mode !== 'human';
	}

	/** Whether interactive prompts are allowed (never under bare --json). */
	get interactive(): boolean {
		return this.mode !== 'stdout' && process.stdin.isTTY === true;
	}

	/**
	 * Emit one human progress/result line. Suppressed in bare --json mode
	 * so stdout carries nothing but the final JSON value.
	 *
	 * @param text - The line to print.
	 */
	line(text: string): void {
		if (this.mode !== 'stdout') {
			console.log(text);
		}
	}

	/**
	 * Record the command's JSON result payload.
	 *
	 * @param value - JSON-serializable result of the command.
	 */
	result(value: unknown): void {
		this.payload = value;
	}

	/**
	 * Report a command failure: one sentence + next step on stderr, and an
	 * error envelope as the JSON payload.
	 *
	 * @param message - What went wrong, as a plain sentence.
	 * @param hint - The next step the user should take (may be empty).
	 * @returns 1, so callers can `return out.fail(...)`.
	 */
	fail(message: string, hint: string = ''): number {
		console.error(hint ? `Error: ${message} — ${hint}` : `Error: ${message}`);
		this.payload = { error: { message, ...(hint ? { hint } : {}) } };
		return 1;
	}

	/**
	 * Flush the JSON payload to its destination. Called exactly once, after
	 * the command finishes (success or failure).
	 */
	finish(): void {
		if (this.mode === 'human' || this.payload === undefined) {
			return;
		}
		const text = JSON.stringify(this.payload, null, 2);
		if (this.mode === 'stdout') {
			console.log(text);
		} else {
			fs.writeFileSync(this.filePath, text + '\n', 'utf-8');
		}
	}
}
