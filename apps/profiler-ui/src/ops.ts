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
// PROFILER OPERATION VOCABULARY — frames ask, the controller executes
// =============================================================================
//
// The profiler's whole engine surface is raw `rrext_*` DAP commands against
// the host's connected engine, so ONE op carries them all. Frames hold no
// RocketRide client: the view calls through a ProfilerEngine — local
// (realm's client) in the full app, controller-routed in dev-tool frames.
// Connection reachability rides the shell's `host:connection` system topic.
// =============================================================================

import type { ToolOpMap, ToolOpSpec } from 'shell';

/** The profiler's op map — one op carries every raw extension command. */
export interface ProfilerOps extends ToolOpMap {
	/** One raw extension command against the controller's engine connection. */
	'profiler.call': ToolOpSpec<{ command: string; args?: Record<string, unknown> }, unknown>;
}

/** The engine surface the profiler view uses — never a client. */
export interface ProfilerEngine {
	/** Whether the engine is reachable (polling and actions gate on it). */
	ready: boolean;
	/**
	 * Invokes one `rrext_*` command.
	 *
	 * @param command - The extension command name.
	 * @param args - Command arguments.
	 * @returns The command result.
	 */
	call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** The raw-DAP commands the profiler issues, mapped onto the bus's NAMED
 *  client.* allowlist (the bus has no generic passthrough by design). */
const COMMAND_OPS: Record<string, string> = {
	rrext_cprofile_start: 'client.cprofileStart',
	rrext_cprofile_stop: 'client.cprofileStop',
	rrext_cprofile_status: 'client.cprofileStatus',
	rrext_cprofile_report: 'client.cprofileReport',
	rrext_cprofile_report_tree: 'client.cprofileReportTree',
	rrext_cprofile_threads: 'client.cprofileThreads',
	rrext_get_tasks: 'client.getTasks',
};

/**
 * Executes one profiler command over the shell bus — the LOCAL engine impl
 * for realms with no client object (every realm now).
 *
 * @param request - The realm's request function (ConnectionManager.request).
 * @param command - The raw command name (COMMAND_OPS key).
 * @param args - The command's arguments.
 * @returns The command's result.
 */
export async function callProfilerOp<T>(request: (op: string, params: unknown) => Promise<unknown>, command: string, args?: Record<string, unknown>): Promise<T> {
	const op = COMMAND_OPS[command];
	if (!op) throw new Error(`Profiler command '${command}' is not on the bus allowlist`);
	return request(op, args ?? {}) as Promise<T>;
}
