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
 * The helpers are exported individually: they are the unit-tested seams
 * (tests/validate.test.ts) and their contracts — message skeletons, report
 * shape, exit codes — are shared with the Python CLI.
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

/** One file's validation outcome. `processed` = the server returned a verdict. */
export interface FileValidationResult {
	file: string;
	valid: boolean;
	errors: unknown[];
	warnings: unknown[];
	processed: boolean;
}

/** One file's load outcome: a parsed config, or the per-file error text. */
export interface ValidateFileLoad {
	file: string;
	config?: Record<string, unknown>;
	error?: string;
}

/** The machine-readable report emitted under `--json`. */
export interface ValidateReport {
	files: Array<Omit<FileValidationResult, 'processed'>>;
	summary: { total: number; valid: number; invalid: number };
}

/**
 * Expand file arguments into a deduplicated, ordered list of paths.
 *
 * Literal paths and patterns that match nothing are kept verbatim so they
 * can be reported as unreadable files.
 *
 * @param patterns - File paths and/or glob patterns from the command line.
 * @returns Expanded file paths, deduplicated, preserving order.
 */
export function expandFilePatterns(patterns: string[]): string[] {
	const files: string[] = [];

	for (const pattern of patterns) {
		const matches = glob.sync(pattern, { nodir: true, windowsPathsNoEscape: process.platform === 'win32' }).sort();
		if (matches.length > 0) {
			files.push(...matches);
		} else {
			files.push(pattern);
		}
	}

	return [...new Set(files)];
}

/**
 * Load and parse a pipeline configuration file as strict JSON.
 *
 * Mirror of the Python CLI's loader: a path that is not an existing regular
 * file is reported as not found, and `.pipe` files may wrap the config in
 * `{"pipeline": {...}}` — the inner object is extracted when present. The
 * message skeletons match across both CLIs; they land verbatim in reports.
 *
 * @param file - Path to the pipeline configuration file.
 * @returns The parsed config, or the per-file error text.
 */
export function loadPipelineFile(file: string): ValidateFileLoad {
	if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
		return { file, error: `File not found: ${file}` };
	}

	let content: string;
	try {
		content = fs.readFileSync(file, 'utf-8');
	} catch (error) {
		return { file, error: `Cannot read ${file}: ${error instanceof Error ? error.message : error}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		return { file, error: `Invalid JSON in ${file}: ${error instanceof Error ? error.message : error}` };
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { file, error: `Invalid pipeline format in ${file}: expected a JSON object` };
	}

	// .pipe files wrap the config in { "pipeline": { ... } } — unwrap if present
	const record = parsed as Record<string, unknown>;
	const inner = record.pipeline;
	const config = inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : record;
	return { file, config };
}

/**
 * Render one validation error/warning as a display line.
 *
 * @param issue - A server-reported issue: string, `{ message, id? }`, or
 *   anything else (stringified).
 * @returns The formatted line, with the component id appended when present.
 */
export function formatValidationIssue(issue: unknown): string {
	if (typeof issue === 'string') {
		return issue;
	}
	if (issue && typeof issue === 'object') {
		const record = issue as Record<string, unknown>;
		const message = typeof record.message === 'string' ? record.message : JSON.stringify(issue);
		return record.id ? `${message} (${record.id})` : message;
	}
	return String(issue);
}

/**
 * Build the machine-readable report: per-file entries (without the internal
 * `processed` flag) plus the aggregate summary.
 *
 * @param results - Per-file validation results.
 * @returns The `--json` report payload.
 */
export function buildValidateReport(results: FileValidationResult[]): ValidateReport {
	const validCount = results.filter((r) => r.valid).length;
	return {
		files: results.map((r) => ({ file: r.file, valid: r.valid, errors: r.errors, warnings: r.warnings })),
		summary: { total: results.length, valid: validCount, invalid: results.length - validCount },
	};
}

/**
 * Compute the CI exit code from the aggregate results.
 *
 * @param results - Per-file validation results.
 * @returns 0 all valid / 1 any invalid / 2 when no file was processed.
 */
export function validateExitCode(results: FileValidationResult[]): number {
	if (results.length === 0 || !results.some((r) => r.processed)) {
		return 2;
	}
	return results.every((r) => r.valid) ? 0 : 1;
}

/**
 * The validate command's core: expand, load, connect, validate, report.
 *
 * Factored out of the commander action so tests can drive it directly with
 * a mocked connectClient and a chosen Output mode.
 *
 * @param files - File paths and/or glob patterns to validate.
 * @param options - Parsed commander options (uri, apikey, source, json).
 * @param out - The command's output channel.
 * @returns Exit code per the CI contract.
 */
export async function executeValidate(
	files: string[],
	options: { uri?: string; apikey?: string; source?: string; json?: boolean | string },
	out: Output,
): Promise<number> {
	// step: expand globs and load every file up front; load failures are
	// per-file errors
	const loads = expandFilePatterns(files).map(loadPipelineFile);

	// step: connect only if at least one file parsed. A connection failure is
	// exit code 2 by contract, so it is handled HERE — the shared runner's
	// catch-all would turn it into a 1.
	let client;
	if (loads.some((entry) => entry.config !== undefined)) {
		try {
			client = await connectClient(options);
		} catch (err) {
			console.error(`Error: Failed to connect to ${options.uri ?? 'server'}: ${err instanceof Error ? err.message : err}`);
			return 2;
		}
	}

	// step: validate each file in order, collecting per-file results
	const results: FileValidationResult[] = [];
	for (const entry of loads) {
		if (entry.config === undefined) {
			results.push({ file: entry.file, valid: false, errors: [{ message: entry.error }], warnings: [], processed: false });
			continue;
		}
		try {
			const result = await client!.validate({ pipeline: entry.config, source: options.source });
			const errors = Array.isArray(result.errors) ? result.errors : [];
			const warnings = Array.isArray(result.warnings) ? result.warnings : [];
			results.push({ file: entry.file, valid: errors.length === 0, errors, warnings, processed: true });
		} catch (err) {
			// The server rejected the request for this file — reported
			// per-file, but it does NOT count as processed.
			results.push({ file: entry.file, valid: false, errors: [{ message: err instanceof Error ? err.message : String(err) }], warnings: [], processed: false });
		}
	}

	// step: report (out.line is human-only; the JSON payload matches the
	// Python CLI's shape exactly)
	const report = buildValidateReport(results);
	for (const entry of results) {
		out.line(`${entry.file}: ${entry.valid ? 'valid' : 'invalid'}`);
		for (const issue of entry.errors) {
			out.line(`    error: ${formatValidationIssue(issue)}`);
		}
		for (const issue of entry.warnings) {
			out.line(`    warning: ${formatValidationIssue(issue)}`);
		}
	}
	out.line('');
	out.line(`Summary: ${report.summary.total} file(s), ${report.summary.valid} valid, ${report.summary.invalid} invalid`);
	out.result(report);

	return validateExitCode(results);
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
			await runCliCommand(options, (out) => executeValidate(files, options, out));
		});

	// Usage errors (e.g. missing <files...>) must exit with code 2 — commander's
	// default would be 1, which the CI contract reserves for "invalid pipeline".
	validateCmd.exitOverride((err) => {
		process.exit(err.exitCode === 0 ? 0 : 2);
	});

	addConnectionOptions(validateCmd);
}
