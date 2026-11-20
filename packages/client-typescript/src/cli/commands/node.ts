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
 * Custom node commands — `node convert`.
 *
 * `node convert` rewrites an old-format `services*.json` (`preconfig`,
 * `fields`, `shape`) into the current format and adds the node's `legacy`
 * block (breaking change B6). It is a WORKSPACE operation: no connection, no
 * configuration. The rules live in `../node_convert.ts`. Kept in exact parity
 * with the Python CLI's `rocketride/cli/commands/node.py`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { runCliCommand } from '../common';
import type { ConnectionOptions } from '../common';
import type { Output } from '../output';
import { conversionText, convertDefinition, loadJson } from '../node_convert';

// =============================================================================
// NODE CONVERT
// =============================================================================

/** Parsed `node convert` options. */
export interface NodeConvertOptions extends ConnectionOptions {
	out?: string;
	dryRun?: boolean;
}

/**
 * The `node convert` body: convert each file, write it (in place unless
 * `--out`) or print it under `--dry-run`, and report.
 *
 * @param files - The services*.json files.
 * @param options - Parsed command options.
 * @param out - Command output.
 * @returns The exit code: 0 when every file converted, 1 otherwise.
 */
export async function executeNodeConvert(files: string[], options: NodeConvertOptions, out: Output): Promise<number> {
	// --out names ONE destination, so it takes one file
	if (options.out && files.length !== 1) return out.fail('--out takes exactly one input file', 'convert the files one at a time');

	const results: Record<string, unknown>[] = [];
	let failed = 0;
	for (const file of files) {
		// Step 1: read and convert; a file that is not old-format is reported, not rewritten
		let conversion;
		try {
			conversion = convertDefinition(loadJson(fs.readFileSync(file, 'utf8')));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failed += 1;
			out.warn(`${file}: ${message}`);
			results.push({ file, error: message });
			continue;
		}

		// Step 2: write (in place unless --out), or print under --dry-run
		const target = options.out ?? file;
		if (options.dryRun) {
			out.line(conversionText(conversion).replace(/\n$/, ''));
		} else {
			fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
			fs.writeFileSync(target, conversionText(conversion), 'utf8');
			out.line(`Converted ${file} -> ${target}` + (conversion.legacy ? ' (legacy block added)' : ''));
		}
		for (const warning of conversion.warnings) out.warn(`${file}: ${warning}`);
		// A dry run writes nothing, so the result carries the definition itself
		results.push({
			file,
			out: options.dryRun ? null : target,
			legacy: conversion.legacy,
			warnings: conversion.warnings,
			...(options.dryRun ? { definition: conversion.definition } : {}),
		});
	}

	// Each failure was named on stderr; the JSON result keeps every file's outcome
	out.result({ files: results });
	if (failed) {
		out.line(`${failed} of ${files.length} file(s) did not convert`);
		return 1;
	}
	return 0;
}

// =============================================================================
// REGISTRATION
// =============================================================================

/**
 * Register the `node` command group on the program.
 *
 * @param program - The root commander program.
 */
export function registerNodeCommands(program: Command): void {
	const nodeCmd = program
		.command('node')
		.description('Custom node operations (no connection)')
		.addHelpText(
			'after',
			`
Examples:
  rocketride node convert nodes/my_node/services.json        convert in place
  rocketride node convert services.json --dry-run            print the result, write nothing`
		);

	// ── node convert ─────────────────────────────────────────────────────
	nodeCmd
		.command('convert <files...>')
		.description('Convert an old-format services.json (preconfig/fields/shape) to the current format and add its legacy block')
		.option('--out <file>', 'Write the converted definition here instead (one input file only)')
		.option('--dry-run', 'Print the converted definition instead of writing it')
		.option('--json [file]', 'Output the result as a JSON value (to stdout, or to the given file)')
		.action(async (files, options) => {
			await runCliCommand(options, (out) => executeNodeConvert(files, options, out));
		});
}
