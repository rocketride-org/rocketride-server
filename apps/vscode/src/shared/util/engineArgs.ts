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

/** Append the next character as an escaped literal, advancing the index.
 *  Only consumes the backslash when escaping special characters (whitespace,
 *  quotes, backslash).  For all other characters the backslash is preserved
 *  so that e.g. Windows paths like `C:\Users` are not mangled. */
function appendEscapedChar(current: string, input: string, index: number): { value: string; nextIndex: number } {
	const next = input[index + 1];
	if (next === undefined) {
		return { value: `${current}\\`, nextIndex: index };
	}
	if (next === '\\' || next === '"' || next === "'" || /\s/.test(next)) {
		return { value: `${current}${next}`, nextIndex: index + 1 };
	}
	return { value: `${current}\\${next}`, nextIndex: index + 1 };
}

/**
 * Split a command-line string into argv-style tokens without invoking a shell.
 *
 * Supports:
 * - whitespace-delimited flags
 * - single and double quoted segments
 * - backslash escaping outside quotes
 * - backslash escaping of `"` and `\\` inside double quotes
 */
export function splitEngineArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = '';
	let quote: "'" | '"' | null = null;

	for (let i = 0; i < input.length; i += 1) {
		const char = input[i];

		if (quote === "'") {
			if (char === "'") {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}

		if (quote === '"') {
			if (char === '"') {
				quote = null;
				continue;
			}
			if (char === '\\') {
				const next = input[i + 1];
				if (next === '"' || next === '\\') {
					current += next;
					i += 1;
					continue;
				}
			}
			current += char;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (char === '\\') {
			const escaped = appendEscapedChar(current, input, i);
			current = escaped.value;
			i = escaped.nextIndex;
			continue;
		}

		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = '';
			}
			continue;
		}

		current += char;
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * Build the effective engine arguments array from raw user settings.
 *
 * Tokenizes the raw args string (handling quoted paths and escapes),
 * then conditionally appends `--trace=servicePython` when debug output
 * is enabled and no `--trace` flag is already present.
 */
export function buildEffectiveEngineArgs(rawArgs: string | string[] | undefined, debugOutput: boolean): string[] {
	const argsStr = Array.isArray(rawArgs) ? rawArgs.join(' ') : String(rawArgs || '');
	const result = splitEngineArgs(argsStr.trim());
	const hasTrace = result.some((arg) => arg === '--trace' || arg.startsWith('--trace='));

	if (debugOutput && !hasTrace) {
		result.push('--trace=servicePython');
	}

	return result;
}
