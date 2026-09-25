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
 * Profiler commands: `profile start/stop/run/status/list/report/threads/tree`.
 *
 * Thin wrappers over the client's cprofile* methods. `--token` names a
 * task, whose engine subprocess is profiled; without it the server
 * process is. Only `run` can profile the server process: the server ends
 * a session there when the connection that started it closes, and every
 * CLI invocation is its own connection.
 *
 * Kept in exact parity with the Python CLI's `cli/commands/profile.py` —
 * the text formats are pinned by identical expected output in both suites.
 */

import { Command } from 'commander';
import { RocketRideClient } from '../../client/client';
import { CProfileReportTreeResponse, CProfileStatusResponse, CProfileThreadInfo, CProfileTreeNode } from '../../client/types';
import { addConnectionOptions, connectClient, onInterrupt, runCliCommand } from '../common';
import { Output } from '../output';

/** Locale grouped counts are pinned to, as the Python CLI's `f'{n:,}'` is. */
const COUNT_LOCALE = 'en-US';

/** The longest delay one Node timer can wait; past it, it fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** How long `profile list` waits for one task's status before giving up on it. */
const LIST_TIMEOUT_SECONDS = 10;

/** One process in `profile list`: the server process (token null) or a task's. */
export interface ProfileListEntry {
	/** Task token, or null for the server process. */
	token: string | null;
	/** Task name from the task list, or null. */
	name: string | null;
	/** The process's profiling status, when it could be read. */
	status?: CProfileStatusResponse;
	/** Why the status could not be read. */
	error?: string;
}

/**
 * Help for `--token` on the commands that also work without one. Unlike
 * the task commands, no ROCKETRIDE_TOKEN default: a missing --token means
 * the server process, and the environment must not switch that silently.
 */
const TOKEN_HELP = 'Task token of the pipeline to profile (default: the server process)';

/**
 * Format a duration in seconds for the tables.
 *
 * @param seconds - Duration in seconds.
 * @returns E.g. `1.234s`.
 */
function formatSeconds(seconds: number): string {
	return `${seconds.toFixed(3)}s`;
}

/**
 * Format a share as a percentage with one decimal.
 *
 * @param pct - Percentage, 0-100 (a coroutine's can exceed 100).
 * @returns E.g. `45.6%`.
 */
function formatPercent(pct: number): string {
	return `${pct.toFixed(1)}%`;
}

/**
 * Describe what `--token` selects, for human output.
 *
 * @param token - Task token, or undefined for the server process.
 * @returns E.g. `task tk_abc` or `the server process`.
 */
function scopeOf(token?: string): string {
	return token ? `task ${token}` : 'the server process';
}

/**
 * Parse a non-negative decimal exactly as typed; one grammar in both CLIs.
 *
 * Digits alone do not make a number: enough of them overflow to Infinity,
 * which would pass every range check below and turn --duration into a wait
 * with no end.
 *
 * @param text - The option value.
 * @returns The number, or null when the text is not a finite one.
 */
function parseDecimal(text: string | undefined): number | null {
	if (text === undefined || !/^([0-9]+\.?[0-9]*|\.[0-9]+)$/.test(text)) {
		return null;
	}
	const value = Number(text);
	return Number.isFinite(value) ? value : null;
}

/**
 * Parse a non-negative integer exactly as typed; one grammar in both CLIs.
 *
 * Past 2^53 a JavaScript number no longer holds the digits it was given,
 * so such a count is refused rather than silently rounded; the Python CLI
 * refuses the same range to keep the two answering alike.
 *
 * @param text - The option value.
 * @returns The number, or null when the text is not an exact one.
 */
function parseCount(text: string | undefined): number | null {
	if (text === undefined || !/^[0-9]+$/.test(text)) {
		return null;
	}
	const value = Number(text);
	return Number.isSafeInteger(value) ? value : null;
}

/**
 * Refuse start/stop on the server process, naming the command that can.
 *
 * @param out - The command's output channel.
 * @param verb - `start` or `stop`.
 * @returns 1.
 */
function failWithoutToken(out: Output, verb: string): number {
	return out.fail(`profile ${verb} needs --token`, "a session on the server process ends with the connection that started it; profile the server with 'rocketride profile run'");
}

/**
 * Print how a stopped session went and where to read it.
 *
 * @param out - The command's output channel.
 * @param session - Session name from the stop response.
 * @param runtime - Session duration in seconds.
 * @param token - Task token, or undefined for the server process.
 */
function printStopped(out: Output, session: string | undefined, runtime: number | undefined, token?: string): void {
	out.line(`Profiling stopped: session '${session}' ran ${formatSeconds(runtime ?? 0)}`);
	out.line(`Read it with: rocketride profile report|threads|tree${token ? ` --token ${token}` : ''}`);
}

/**
 * Wait out `seconds`, or until Ctrl+C when no duration is given.
 *
 * Takes the first SIGINT/SIGTERM from the CLI's shutdown handler, so the
 * caller can still stop the session on its own connection.
 *
 * @param seconds - How long to wait, or undefined to wait for Ctrl+C.
 */
export function waitForStop(seconds?: number): Promise<void> {
	return new Promise((resolve) => {
		const deadline = seconds === undefined ? Infinity : Date.now() + seconds * 1000;
		let timer: NodeJS.Timeout | undefined;
		const done = () => {
			clearTimeout(timer);
			onInterrupt(null);
			resolve();
		};
		// Re-armed in steps: a longer timer fires at once, and without
		// --duration this timer is what keeps the process waiting
		const arm = () => {
			const left = deadline - Date.now();
			if (left <= 0) {
				done();
				return;
			}
			timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
		};
		onInterrupt(done);
		arm();
	});
}

/**
 * Render the `profile threads` table.
 *
 * @param threads - Threads from rrext_cprofile_threads, busiest first.
 * @returns The lines to print.
 */
export function formatThreads(threads: CProfileThreadInfo[]): string[] {
	if (threads.length === 0) {
		return ['No threads recorded'];
	}
	const total = threads.reduce((sum, thread) => sum + thread.ttot, 0);
	const header = ['ID', 'NAME', 'TID', 'TIME', 'SHARE'];
	const rows = threads.map((thread) => [String(thread.id), thread.name ?? '-', String(thread.tid), formatSeconds(thread.ttot), total > 0 ? formatPercent((thread.ttot / total) * 100) : '-']);
	const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i].length)));
	// NAME is the one text column; the rest are numbers, right-aligned
	const render = (cells: string[]) => cells.map((cell, i) => (i === 1 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ');
	return [render(header), ...rows.map(render), `${threads.length} thread(s), ${formatSeconds(total)} total`];
}

/**
 * Render the `profile tree` call tree.
 *
 * The synthetic `<root>` is not a row: its totals head the output, and
 * its children are the top level. Pruning happened on the server.
 *
 * @param result - Response from rrext_cprofile_report_tree.
 * @param thread - The thread id asked for, or undefined for all threads.
 * @returns The lines to print.
 */
export function formatTree(result: CProfileReportTreeResponse, thread?: number): string[] {
	const total = result.total_time;
	const which = thread === undefined ? 'all threads' : `thread ${thread}`;
	const lines = [`Call tree, ${which}: ${formatSeconds(total)}, ${result.total_calls.toLocaleString(COUNT_LOCALE)} calls`];
	const roots = result.tree?.children ?? [];
	if (roots.length === 0) {
		lines.push('No calls to show');
		return lines;
	}

	const row = (pct: string, cumtime: string, tottime: string, ncalls: string, label: string) => `${pct.padStart(6)}  ${cumtime.padStart(10)}  ${tottime.padStart(10)}  ${ncalls.padStart(10)}  ${label}`;

	// lead + connector prefixes this node's name; childLead prefixes its children's
	const walk = (node: CProfileTreeNode, lead: string, connector: string, childLead: string) => {
		const pct = total > 0 ? formatPercent((node.cumtime / total) * 100) : '-';
		const where = node.file ? `  (${node.line ? `${node.file}:${node.line}` : node.file})` : '';
		lines.push(row(pct, formatSeconds(node.cumtime), formatSeconds(node.tottime), node.ncalls.toLocaleString(COUNT_LOCALE), `${lead}${connector}${node.name}${where}`));
		node.children.forEach((child, i) => {
			const last = i === node.children.length - 1;
			walk(child, childLead, last ? '`-- ' : '+-- ', childLead + (last ? '    ' : '|   '));
		});
	};

	lines.push('');
	lines.push(row('CUM%', 'CUMTIME', 'TOTTIME', 'NCALLS', 'FUNCTION'));
	for (const root of roots) {
		walk(root, '', '', '');
	}
	return lines;
}

/**
 * Read one task's profiling status for `profile list`. Never throws: a task
 * that fails or does not answer in time is reported, not fatal to the list.
 *
 * @param client - The connected client.
 * @param token - The task's token.
 * @param name - The task's name from the task list.
 * @returns The task's entry, with its status or the error.
 */
async function readTaskStatus(client: RocketRideClient, token: string, name: string | null): Promise<ProfileListEntry> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`no answer within ${LIST_TIMEOUT_SECONDS}s`)), LIST_TIMEOUT_SECONDS * 1000);
	});
	try {
		return { token, name, status: await Promise.race([client.cprofileStatus(token), timeout]) };
	} catch (err) {
		return { token, name, error: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Render the `profile list` table.
 *
 * Processes whose status could not be read follow the table, one line
 * each; `activeOnly` drops the readable ones that are not profiling.
 *
 * @param entries - The server process first, then every task.
 * @param activeOnly - Keep only the processes being profiled.
 * @returns The lines to print.
 */
export function formatProfileList(entries: ProfileListEntry[], activeOnly = false): string[] {
	const shown = entries.filter((entry) => entry.status && (!activeOnly || entry.status.active));
	const failed = entries.filter((entry) => entry.error !== undefined);
	const profiling = entries.filter((entry) => entry.status?.active).length;
	const lines: string[] = [];

	if (shown.length === 0) {
		lines.push('No active profiling sessions');
	} else {
		const header = ['TOKEN', 'NAME', 'STATE', 'RUNNING', 'REPORT', 'SESSION'];
		const rows = shown.map((entry) => {
			const status = entry.status as CProfileStatusResponse;
			return [entry.token ?? '(server)', entry.name ?? '-', status.active ? 'active' : 'inactive', status.active ? formatSeconds(status.runtime ?? 0) : '-', status.active ? '-' : status.has_report ? 'yes' : 'no', (status.active && status.session) || '-'];
		});
		const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i].length)));
		// RUNNING is the one number, right-aligned; SESSION is last and unpadded
		const render = (cells: string[]) => cells.map((cell, i) => (i === cells.length - 1 ? cell : i === 3 ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join('  ');
		lines.push(render(header), ...rows.map(render));
	}

	for (const entry of failed) {
		lines.push(`${entry.token ?? '(server)'}: ${entry.error}`);
	}
	lines.push(`${entries.length} process(es), ${profiling} profiling${failed.length ? `, ${failed.length} unreadable` : ''}`);
	return lines;
}

/**
 * Register the `profile` command group on the program.
 *
 * @param program - The root commander program.
 */
export function registerProfileCommands(program: Command): void {
	const profileCmd = program.command('profile').description('Profile the server process or a pipeline');

	// ── profile start ────────────────────────────────────────────────────
	const startCmd = profileCmd
		.command('start')
		.description('Start profiling a pipeline and return; stop it with profile stop')
		.option('--token <token>', 'Task token of the pipeline to profile (required)')
		.option('--session <name>', 'Session name shown in the report (default: session_<timestamp>)')
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				if (!options.token) {
					return failWithoutToken(out, 'start');
				}
				const client = await connectClient(options);
				const started = await client.cprofileStart(options.token, options.session);
				if (started.status === 'error') {
					return out.fail(started.message || 'Profiling did not start');
				}
				out.line(`Profiling started: session '${started.session}' on ${scopeOf(options.token)}`);
				out.line(`Stop it with: rocketride profile stop --token ${options.token}`);
				out.result(started);
				return 0;
			});
		});
	addConnectionOptions(startCmd);

	// ── profile stop ─────────────────────────────────────────────────────
	const stopCmd = profileCmd
		.command('stop')
		.description('Stop profiling a pipeline')
		.option('--token <token>', 'Task token of the pipeline being profiled (required)')
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				if (!options.token) {
					return failWithoutToken(out, 'stop');
				}
				const client = await connectClient(options);
				const stopped = await client.cprofileStop(options.token);
				if (stopped.status === 'error') {
					return out.fail(stopped.message || 'Profiling did not stop');
				}
				printStopped(out, stopped.session, stopped.runtime, options.token);
				out.result(stopped);
				return 0;
			});
		});
	addConnectionOptions(stopCmd);

	// ── profile run ──────────────────────────────────────────────────────
	const runCmd = profileCmd
		.command('run')
		.description('Profile until Ctrl+C or --duration, then stop; the way to profile the server process')
		.option('--token <token>', TOKEN_HELP)
		.option('--session <name>', 'Session name shown in the report (default: session_<timestamp>)')
		.option('--duration <seconds>', 'Stop after this many seconds (default: at Ctrl+C)')
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				let seconds: number | undefined;
				if (options.duration !== undefined) {
					const parsed = parseDecimal(options.duration);
					if (parsed === null || parsed <= 0) {
						return out.fail('--duration must be a positive number of seconds');
					}
					seconds = parsed;
				}
				const client = await connectClient(options);
				const started = await client.cprofileStart(options.token, options.session);
				if (started.status === 'error') {
					return out.fail(started.message || 'Profiling did not start');
				}
				out.line(`Profiling started: session '${started.session}' on ${scopeOf(options.token)}`);
				// stderr: a prompt, so it shows under bare --json without breaking stdout
				console.error(seconds === undefined ? 'Press Ctrl+C to stop.' : `Stopping in ${options.duration}s — press Ctrl+C to stop sooner.`);
				await waitForStop(seconds);
				const stopped = await client.cprofileStop(options.token);
				if (stopped.status === 'error') {
					return out.fail(stopped.message || 'Profiling did not stop');
				}
				printStopped(out, stopped.session, stopped.runtime, options.token);
				out.result(stopped);
				return 0;
			});
		});
	addConnectionOptions(runCmd);

	// ── profile status ───────────────────────────────────────────────────
	const statusCmd = profileCmd
		.command('status')
		.description('Show whether a profiling session is active')
		.option('--token <token>', TOKEN_HELP)
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectClient(options);
				const status = await client.cprofileStatus(options.token);
				const scope = scopeOf(options.token);
				if (status.active) {
					out.line(`Profiling active on ${scope}: session '${status.session}', running ${formatSeconds(status.runtime ?? 0)} (owner ${status.owner})`);
				} else {
					out.line(`Profiling inactive on ${scope}; ${status.has_report ? 'a report is available' : 'no report yet'}`);
				}
				out.result(status);
				return 0;
			});
		});
	addConnectionOptions(statusCmd);

	// ── profile list ─────────────────────────────────────────────────────
	const listCmd = profileCmd
		.command('list')
		.description('Show the profiling status of the server process and of every task')
		.option('--active', 'Only the processes being profiled')
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectClient(options);
				const entries: ProfileListEntry[] = [{ token: null, name: null, status: await client.cprofileStatus() }];
				const tasks = await client.getTasks();
				entries.push(...(await Promise.all(tasks.map((task) => readTaskStatus(client, String(task.token), task.name == null ? null : String(task.name))))));
				const activeOnly = options.active === true;
				formatProfileList(entries, activeOnly).forEach((line) => out.line(line));
				// The same filter as the text; an unreadable process is kept, its state unknown
				out.result({ processes: entries.filter((entry) => !activeOnly || entry.error !== undefined || entry.status?.active) });
				return 0;
			});
		});
	addConnectionOptions(listCmd);

	// ── profile report ───────────────────────────────────────────────────
	const reportCmd = profileCmd
		.command('report')
		.description('Print the text report of the last session')
		.option('--token <token>', TOKEN_HELP)
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectClient(options);
				const result = await client.cprofileReport(options.token);
				// Formatted by the server; printed as is
				out.line(result.report.replace(/\n+$/, ''));
				out.result(result);
				return 0;
			});
		});
	addConnectionOptions(reportCmd);

	// ── profile threads ──────────────────────────────────────────────────
	const threadsCmd = profileCmd
		.command('threads')
		.description('List the threads of the last session, busiest first')
		.option('--token <token>', TOKEN_HELP)
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				const client = await connectClient(options);
				const result = await client.cprofileThreads(options.token);
				if (result.error) {
					return out.fail(result.error);
				}
				formatThreads(result.threads).forEach((line) => out.line(line));
				out.result(result);
				return 0;
			});
		});
	addConnectionOptions(threadsCmd);

	// ── profile tree ─────────────────────────────────────────────────────
	const treeCmd = profileCmd
		.command('tree')
		.description('Print the call tree of the last session')
		.option('--token <token>', TOKEN_HELP)
		.option('--thread <id>', "Thread id from the ID column of 'profile threads' (default: all threads)")
		.option('--min-pct <pct>', 'Hide calls below this share of the total time', '0.1')
		.option('--max-depth <depth>', 'Maximum tree depth', '50')
		.option('--include-system', 'Keep stdlib and other system functions (default)')
		.option('--no-include-system', 'Hide system functions, keeping the project code they call')
		.action(async (options) => {
			await runCliCommand(options, async (out) => {
				const thread = options.thread === undefined ? undefined : parseCount(options.thread);
				if (thread === null) {
					return out.fail("--thread must be a thread id from 'rocketride profile threads'");
				}
				const minPct = parseDecimal(options.minPct);
				if (minPct === null || minPct > 100) {
					return out.fail('--min-pct must be a number from 0 to 100');
				}
				const maxDepth = parseCount(options.maxDepth);
				if (maxDepth === null || maxDepth < 1) {
					return out.fail('--max-depth must be a positive integer');
				}
				const client = await connectClient(options);
				const result = await client.cprofileReportTree(options.token, maxDepth, minPct, options.includeSystem !== false, thread);
				if (result.error) {
					return out.fail(result.error);
				}
				formatTree(result, thread).forEach((line) => out.line(line));
				out.result(result);
				return 0;
			});
		});
	addConnectionOptions(treeCmd);
}
