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
 * Shared CLI plumbing: connection options, client lifecycle, error
 * shaping, and interactive prompts.
 *
 * Every command runs through {@link runCliCommand}, which owns the
 * Output lifecycle (JSON flush), converts thrown errors into the uniform
 * failure shape, disconnects any live clients, and exits with the
 * command's code — so individual commands contain only their own logic.
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { Command } from 'commander';
import { RocketRideClient } from '../client/client';
import { DAPMessage, PipelineConfig } from '../client/types';
import { CONST_DEFAULT_WEB_LOCAL } from '../client/constants';
import { Output, JsonOption } from './output';
import { ENV_DEV_URI, ENV_DEV_APIKEY, ENV_DEPLOY_URI, ENV_DEPLOY_APIKEY } from './env';

/** Options every connected command accepts. */
export interface ConnectionOptions {
	uri?: string;
	apikey?: string;
	json?: JsonOption;
	[key: string]: unknown;
}

/** Clients opened by the running command, disconnected on exit/signal. */
const activeClients = new Set<RocketRideClient>();

/**
 * Add the development-connection options (`--uri`, `--apikey`, `--json`).
 *
 * Defaults read the ROCKETRIDE_URI / ROCKETRIDE_APIKEY pair, which the
 * entry point has already seeded from the workspace `.env`.
 *
 * @param cmd - The commander command to extend.
 * @returns The same command, for chaining.
 */
export function addConnectionOptions(cmd: Command): Command {
	return cmd
		.option('--uri <uri>', `RocketRide server URI (can use ${ENV_DEV_URI} in .env or env var)`, process.env[ENV_DEV_URI] || CONST_DEFAULT_WEB_LOCAL)
		.option('--apikey <key>', `API key for server authentication (can use ${ENV_DEV_APIKEY} in .env or env var)`, process.env[ENV_DEV_APIKEY])
		.option('--json [file]', 'Output the result as a JSON value (to stdout, or to the given file)');
}

/**
 * Add the deployment-target options (`--uri`, `--apikey`, `--json`).
 *
 * Lifecycle verbs read the ROCKETRIDE_DEPLOY_* pair; the caller must
 * hard-stop when the pair is absent — the development connection is
 * never a deploy fallback.
 *
 * @param cmd - The commander command to extend.
 * @returns The same command, for chaining.
 */
export function addDeployConnectionOptions(cmd: Command): Command {
	return cmd
		.option('--uri <uri>', `Deployment target URI (can use ${ENV_DEPLOY_URI} env var)`, process.env[ENV_DEPLOY_URI])
		.option('--apikey <key>', `Deployment target API key (can use ${ENV_DEPLOY_APIKEY} env var)`, process.env[ENV_DEPLOY_APIKEY])
		.option('--json [file]', 'Output the result as a JSON value (to stdout, or to the given file)');
}

/**
 * Connect a client for the command, tracked for cleanup.
 *
 * @param options - Parsed command options carrying uri/apikey.
 * @param onEvent - Optional DAP event handler (e.g. upload progress lines).
 * @returns The connected client.
 */
export async function connectClient(options: ConnectionOptions, onEvent?: (message: DAPMessage) => Promise<void>): Promise<RocketRideClient> {
	const client = new RocketRideClient({
		uri: options.uri,
		auth: options.apikey,
		onEvent,
	});
	activeClients.add(client);
	await client.connect();
	return client;
}

/**
 * Disconnect every client the command opened. Safe to call repeatedly.
 */
export async function disconnectAll(): Promise<void> {
	const clients = [...activeClients];
	activeClients.clear();
	await Promise.all(clients.map((client) => client.disconnect().catch(() => {})));
}

/**
 * Derive the user-facing hint for a thrown error.
 *
 * Auth rejections name the fix (`rocketride login`); connection failures
 * point at the server address; everything else gets no hint.
 *
 * @param err - The thrown error.
 * @param uri - The server the command was talking to.
 * @returns A hint sentence, possibly empty.
 */
export function hintFor(err: unknown, uri?: string): string {
	const message = err instanceof Error ? err.message : String(err);
	if (/invalid api key|not authenticated|unauthorized|authentication failed|account is waitlisted/i.test(message)) {
		return `credentials for ${uri || 'the server'} were rejected — run 'rocketride login' to re-authenticate`;
	}
	if (/econnrefused|enotfound|timed? ?out|cannot reach|connection (failed|refused|closed)/i.test(message)) {
		return `is the server at ${uri || 'the configured URI'} running?`;
	}
	return '';
}

/**
 * Run one CLI command action with uniform lifecycle handling.
 *
 * Owns the Output construction and flush, error conversion, client
 * cleanup, and the process exit code.
 *
 * The exit itself is NATURAL: we set `process.exitCode` and let the
 * event loop drain, because a hard `process.exit()` in the same tick
 * that websocket transports are closing trips libuv's Windows
 * `async.c` assertion (exit 0xC0000409) at teardown. An unref'd timer
 * force-exits only if something leaks a handle and the process would
 * otherwise hang.
 *
 * @param options - Parsed command options (carries `--json` and `--uri`).
 * @param fn - The command body; returns its exit code.
 */
export async function runCliCommand(options: ConnectionOptions, fn: (out: Output) => Promise<number>): Promise<void> {
	const out = new Output(options.json);
	let code = 0;
	try {
		code = await fn(out);
	} catch (err) {
		code = out.fail(err instanceof Error ? err.message : String(err), hintFor(err, options.uri));
	} finally {
		await disconnectAll();
		out.finish();
	}
	process.exitCode = code;
	const forceExit = setTimeout(() => process.exit(code), 2000);
	forceExit.unref();
}

/**
 * Load and validate a pipeline configuration file.
 *
 * @param pipelineFile - Path to the JSON pipeline file.
 * @returns The parsed configuration.
 * @throws Error when the file is missing or not valid JSON.
 */
export function loadPipelineConfig(pipelineFile: string): PipelineConfig {
	if (!fs.existsSync(pipelineFile) || !fs.statSync(pipelineFile).isFile()) {
		throw new Error(`Pipeline file not found: ${pipelineFile}`);
	}
	const content = fs.readFileSync(pipelineFile, 'utf-8');
	try {
		return JSON.parse(content);
	} catch (error) {
		throw new Error(`Invalid JSON format in ${pipelineFile}: ${error}`);
	}
}

/**
 * Prompt for one line of input on the terminal.
 *
 * @param question - The prompt text (no trailing space needed).
 * @param fallback - Pre-filled default shown in brackets; returned on empty input.
 * @returns The entered (or defaulted) value, trimmed.
 */
export function promptLine(question: string, fallback: string = ''): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const suffix = fallback ? ` [${fallback}]` : '';
	return new Promise((resolve) => {
		rl.question(`${question}${suffix}: `, (answer) => {
			rl.close();
			resolve(answer.trim() || fallback);
		});
	});
}

/**
 * Prompt for a secret on the terminal without echoing it.
 *
 * @param question - The prompt text.
 * @returns The entered value, trimmed.
 */
export function promptHidden(question: string): Promise<string> {
	return new Promise((resolve) => {
		const stdin = process.stdin;
		const stdout = process.stdout;
		stdout.write(`${question}: `);
		const wasRaw = stdin.isTTY ? stdin.isRaw : false;
		if (stdin.isTTY) {
			stdin.setRawMode(true);
		}
		let value = '';
		const onData = (chunk: Buffer) => {
			const char = chunk.toString('utf-8');
			if (char === '\r' || char === '\n' || char === String.fromCharCode(4)) {
				// Enter / EOF finishes the secret
				stdin.removeListener('data', onData);
				if (stdin.isTTY) {
					stdin.setRawMode(wasRaw);
				}
				stdin.pause();
				stdout.write('\n');
				resolve(value.trim());
			} else if (char === String.fromCharCode(3)) {
				// Ctrl+C aborts the process, matching normal terminal behavior
				stdout.write('\n');
				process.exit(130);
			} else if (char === String.fromCharCode(127) || char === '\b') {
				value = value.slice(0, -1);
			} else {
				value += char;
			}
		};
		stdin.resume();
		stdin.on('data', onData);
	});
}

/**
 * Format a byte count for human output (e.g. `2.3 MB`).
 *
 * @param sizeBytes - The size in bytes.
 * @returns The formatted size string.
 */
export function formatSize(sizeBytes: number): string {
	if (sizeBytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let unitIndex = 0;
	let size = sizeBytes;
	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}
	return unitIndex === 0 ? `${Math.floor(size)} ${units[unitIndex]}` : `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Format a unix-seconds timestamp for human output, or `-` when absent.
 *
 * @param seconds - Unix timestamp in seconds.
 * @returns Localized date-time string.
 */
export function formatWhen(seconds?: number | null): string {
	if (!seconds) return '-';
	return new Date(seconds * 1000).toLocaleString();
}
