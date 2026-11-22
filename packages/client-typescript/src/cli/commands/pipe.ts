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
 * Pipeline workspace commands — `pipe new`.
 *
 * `pipe new` is a WORKSPACE operation: it needs no connection and writes
 * `pipelines/<id>/<id>.pipe` with its store block, icon, README and
 * `assets/` through the SDK's one pipeline scaffold. Deploying the result is
 * `rocketride deploy add pipelines/<id>/<id>.pipe`.
 */

import { Command } from 'commander';
import { runCliCommand } from '../common';
import type { ConnectionOptions } from '../common';
import type { Output } from '../output';

// =============================================================================
// PIPE NEW
// =============================================================================

/** Parsed `pipe new` options. */
export interface PipeNewOptions extends ConnectionOptions {
	name?: string;
	dir?: string;
	workspace?: string;
}

/**
 * The `pipe new` body: scaffold through the SDK's one pipeline scaffold and
 * report.
 *
 * @param pipeId - The pipeline id.
 * @param options - Parsed command options.
 * @param out - Command output.
 * @returns The exit code.
 */
export async function executePipeNew(pipeId: string, options: PipeNewOptions, out: Output): Promise<number> {
	const { scaffoldPipe } = await import('../../app-pack/index.js');
	const created = scaffoldPipe(options.workspace ?? process.cwd(), pipeId, { name: options.name, dir: options.dir });
	for (const file of created.files) out.line(`  + ${file}`);
	out.line(`Created ${pipeId} at ${created.folder}`);
	out.line(`Edit ${created.pipePath} (the store block lists it), then deploy with: rocketride deploy add ${created.pipePath}`);
	out.result({ pipeId, folder: created.folder, pipePath: created.pipePath, files: created.files });
	return 0;
}

// =============================================================================
// REGISTRATION
// =============================================================================

/**
 * Register the `pipe` command group on the program.
 *
 * @param program - The root commander program.
 */
export function registerPipeCommands(program: Command): void {
	const pipeCmd = program
		.command('pipe')
		.description('Pipeline workspace operations (deploying and publishing: rocketride deploy)')
		.addHelpText(
			'after',
			`
Examples:
  rocketride pipe new ingest --name "Document ingest"   new pipeline in ./pipelines/ingest/
  rocketride deploy add pipelines/ingest/ingest.pipe    deploy it (deployment target)`,
		);

	// ── pipe new ─────────────────────────────────────────────────────────
	pipeCmd
		.command('new <id>')
		.description('Scaffold a new pipeline under ./pipelines/<id>/: the .pipe with its store block, README.md and assets/')
		.option('--name <text>', 'Display name (default: the id)')
		.option('--dir <dir>', 'Pipelines directory, relative to the workspace (default: pipelines)')
		.option('--workspace <dir>', 'Workspace root (default: current directory)')
		.option('--json [file]', 'Output the result as a JSON value (to stdout, or to the given file)')
		.action(async (id, options) => {
			await runCliCommand(options, (out) => executePipeNew(id, options, out));
		});
}
