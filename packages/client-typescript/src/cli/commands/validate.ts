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
 * `validate` — check pipeline files against the server without executing them.
 *
 * Expands shell-style glob patterns in-CLI (so behavior is identical on
 * shells that do not expand globs, e.g. Windows), parses each file as strict
 * JSON, and sends each parsed pipeline to the server via the SDK validate()
 * method. Kept in exact parity with the Python CLI's
 * `cli/commands/validate.py`.
 *
 * Exit codes (the `validate-pipes` GitHub Action depends on these):
 *   0: all files valid
 *   1: at least one file failed validation
 *   2: usage error, connection failure, or no file could be processed at all
 *      (a file counts as processed only when the server returns a verdict)
 */

import * as fs from 'fs';
import * as glob from 'glob';
import { Command } from 'commander';
import { addConnectionOptions, connectClient, runCliCommand } from '../common';
import { Output } from '../output';

/** One file's validation outcome, as reported in the JSON payload. */
interface FileValidationEntry {
	file: string;
	valid: boolean;
	errors: unknown[];
	warnings: unknown[];
}

/**
 * Expand file arguments into a deduplicated, ordered list of paths.
 *
 * Literal paths are kept as-is; anything else is treated as a glob pattern.
 * Patterns that match nothing are kept verbatim so they can be reported as
 * unreadable files.
 *
 * @param patterns - File paths and/or glob patterns from the command line.
 * @returns Expanded file paths, deduplicated, preserving order.
 */
function expandFiles(patterns: string[]): string[] {
	const expanded: string[] = [];
	for (const pattern of patterns) {
		if (fs.existsSync(pattern) && fs.statSync(pattern).isFile()) {
			expanded.push(pattern);
			continue;
		}
		// Not a literal file — try shell-style glob expansion
		const matches = glob
			.globSync(pattern)
			.filter((p) => fs.existsSync(p) && fs.statSync(p).isFile())
			.sort();
		if (matches.length > 0) {
			expanded.push(...matches);
		} else {
			// Keep the unmatched pattern so it is reported per-file below
			expanded.push(pattern);
		}
	}
	// step: dedupe while preserving order
	return [...new Set(expanded)];
}

/**
 * Load and parse a pipeline configuration file as strict JSON.
 *
 * `.pipe` files may wrap the configuration in `{"pipeline": {...}}`; the
 * inner object is extracted when present. Error messages are kept identical
 * to the Python CLI's, since they land verbatim in the JSON report.
 *
 * @param filePath - Path to the pipeline configuration file.
 * @returns The parsed pipeline configuration.
 * @throws Error when the file is missing, unreadable, or not a JSON object.
 */
function loadPipeline(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
		throw new Error(`File not found: ${filePath}`);
	}
	let content: string;
	try {
		content = fs.readFileSync(filePath, 'utf-8');
	} catch (err) {
		throw new Error(`Cannot read ${filePath}: ${err instanceof Error ? err.message : err}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (err) {
		throw new Error(`Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : err}`);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid pipeline format in ${filePath}: expected a JSON object`);
	}
	// .pipe files wrap the config in { "pipeline": { ... } } — unwrap if present
	const inner = (parsed as Record<string, unknown>).pipeline;
	return typeof inner === 'object' && inner !== null && !Array.isArray(inner) ? (inner as Record<string, unknown>) : (parsed as Record<string, unknown>);
}

/**
 * Emit one file's verdict with its errors and warnings.
 *
 * @param entry - Per-file result.
 * @param out - The command's output channel.
 */
function entryLines(entry: FileValidationEntry, out: Output): void {
	out.line(`${entry.file}: ${entry.valid ? 'valid' : 'invalid'}`);
	for (const [kind, items] of [
		['error', entry.errors],
		['warning', entry.warnings],
	] as const) {
		for (const item of items) {
			const record = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : undefined;
			const message = record && 'message' in record ? String(record.message) : String(item);
			const suffix = record && record.id ? ` (${record.id})` : '';
			out.line(`    ${kind}: ${message}${suffix}`);
		}
	}
}

/**
 * Register the `validate` command on the program.
 *
 * @param program - The root commander program.
 */
export function registerValidateCommands(program: Command): void {
	const validateCmd = program
		.command('validate')
		.description('Validate pipeline files without executing them')
		.argument('<files...>', 'Pipeline .pipe files or glob patterns to validate')
		.option('--source <id>', 'Override source component ID for validation')
		.addHelpText(
			'after',
			'\nExit codes:\n' +
				'  0  all files valid\n' +
				'  1  at least one file failed validation\n' +
				'  2  usage error, connection failure, or no file could be processed at all\n' +
				'     (no file received a server validation verdict)',
		)
		.action(async (files: string[], options) => {
			await runCliCommand(options, async (out) => {
				// step: expand globs and literal paths into the working file list
				const expanded = expandFiles(files);

				// step: parse every file up front; parse failures are per-file errors
				const pipelines = new Map<string, Record<string, unknown> | undefined>();
				const parseErrors = new Map<string, string>();
				for (const file of expanded) {
					try {
						pipelines.set(file, loadPipeline(file));
					} catch (err) {
						pipelines.set(file, undefined);
						parseErrors.set(file, err instanceof Error ? err.message : String(err));
					}
				}

				// step: connect only if at least one file parsed. A connection
				// failure is exit code 2 by contract, so it is handled HERE —
				// the shared runner's catch-all would turn it into a 1.
				let client;
				if ([...pipelines.values()].some((config) => config !== undefined)) {
					try {
						client = await connectClient(options);
					} catch (err) {
						console.error(`Error: Unable to connect to server: ${err instanceof Error ? err.message : err}`);
						return 2;
					}
				}

				// step: validate each file in order, collecting per-file results
				const results: FileValidationEntry[] = [];
				let processed = 0;
				for (const file of expanded) {
					const config = pipelines.get(file);
					if (config === undefined) {
						results.push({ file, valid: false, errors: [{ message: parseErrors.get(file) }], warnings: [] });
						continue;
					}
					try {
						const result = await client!.validate({ pipeline: config, source: options.source });
						const errors = Array.isArray(result.errors) ? result.errors : [];
						const warnings = Array.isArray(result.warnings) ? result.warnings : [];
						results.push({ file, valid: errors.length === 0, errors, warnings });
						processed += 1;
					} catch (err) {
						// The server rejected the request for this file — reported
						// per-file, but it does NOT count as processed.
						results.push({ file, valid: false, errors: [{ message: err instanceof Error ? err.message : String(err) }], warnings: [] });
					}
				}

				// step: aggregate summary + report (out.line is human-only; the
				// JSON payload matches the Python CLI's shape exactly)
				const validCount = results.filter((entry) => entry.valid).length;
				const summary = { total: results.length, valid: validCount, invalid: results.length - validCount };
				for (const entry of results) {
					entryLines(entry, out);
				}
				out.line('');
				out.line(`Summary: ${summary.total} file(s), ${summary.valid} valid, ${summary.invalid} invalid`);
				out.result({ files: results, summary });

				// step: exit code per the CI contract
				if (processed === 0) {
					return 2;
				}
				return summary.invalid === 0 ? 0 : 1;
			});
		});

	// Usage errors (e.g. missing <files...>) must exit with code 2 — commander's
	// default would be 1, which the CI contract reserves for "invalid pipeline".
	validateCmd.exitOverride((err) => {
		process.exit(err.exitCode === 0 ? 0 : 2);
	});

	addConnectionOptions(validateCmd);
}
