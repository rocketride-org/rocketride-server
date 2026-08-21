#!/usr/bin/env node

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
 * RocketRide CLI entry point.
 *
 * Command surface (kept in exact parity with the Python client's CLI):
 *
 *   init                       Initialize the workspace (login + provision)
 *   login                      (Re-)authenticate and save .env credentials
 *   list                       List active tasks
 *   start / stop / upload      Task lifecycle
 *   store dir/type/write/...   File store operations
 *   app create/deploy/verify   App lifecycle
 *   deploy add/list/publish/.. Deploy lifecycle (deployment target)
 *
 * All output is plain, line-oriented text; every command also accepts
 * `--json` / `--json=<file>` for a machine-readable result. Continuous
 * live monitoring is deliberately absent — the platform's event monitor
 * and server monitor apps own that job.
 *
 * Configuration comes from flags or the workspace `.env`
 * (ROCKETRIDE_URI/ROCKETRIDE_APIKEY for development,
 * ROCKETRIDE_DEPLOY_URI/ROCKETRIDE_DEPLOY_APIKEY for deploy verbs),
 * which `rocketride init` writes.
 */

import { Command } from 'commander';
import { loadDotEnv } from './env';
import { registerAuthCommands } from './commands/auth';
import { registerTaskCommands } from './commands/tasks';
import { registerStoreCommands } from './commands/store';
import { registerAppCommands } from './commands/app';
import { registerDeployCommands } from './commands/deploy';
import { disconnectAll } from './common';

// The workspace .env must be in process.env before the command groups
// REGISTER (their option defaults read it) — registration happens inside
// createProgram(), so loading here, ahead of it, is sufficient.
loadDotEnv();

/**
 * Install SIGINT/SIGTERM handlers: disconnect any live clients, then
 * exit with the conventional 128+signal code. A second signal — or a
 * hung cleanup — forces the exit.
 */
function setupSignalHandlers(): void {
	const FORCE_EXIT_TIMEOUT_MS = 5000;
	let shuttingDown = false;

	const signalHandler = async (signal: string) => {
		const exitCode = 128 + (signal === 'SIGINT' ? 2 : 15);
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		const forceExitTimer = setTimeout(() => process.exit(exitCode), FORCE_EXIT_TIMEOUT_MS);
		try {
			await disconnectAll();
		} finally {
			clearTimeout(forceExitTimer);
		}
		process.exit(exitCode);
	};

	process.on('SIGINT', () => void signalHandler('SIGINT'));
	process.on('SIGTERM', () => void signalHandler('SIGTERM'));
}

/**
 * Build the commander program with every command group registered.
 *
 * @returns The configured root command.
 */
function createProgram(): Command {
	const program = new Command();
	program.name('rocketride').description('RocketRide Unified Pipeline and File Management CLI').version('1.3.0');
	registerAuthCommands(program);
	registerTaskCommands(program);
	registerStoreCommands(program);
	registerAppCommands(program);
	registerDeployCommands(program);
	return program;
}

/**
 * CLI entry point: register signals, parse, run. Commands exit the
 * process themselves (via runCliCommand); reaching the end of parseAsync
 * without an exit means help/usage was printed.
 */
export async function main(): Promise<void> {
	setupSignalHandlers();
	const program = createProgram();
	try {
		await program.parseAsync(process.argv);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

// Entry point when script is run directly
if (require.main === module) {
	main().catch((error) => {
		console.error('Fatal error:', error);
		process.exit(1);
	});
}
