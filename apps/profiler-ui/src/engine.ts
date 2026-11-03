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
// PROFILER ENGINE — the view's narrow engine surface
// =============================================================================
//
// The profiler's whole engine surface is raw `rrext_*` DAP commands, which is
// exactly the SDK's `client.call()`. Every realm now holds a real client (the
// realm client's requests ride the shell bus), so the engine is one thin
// wrapper — the old controller-routed `profiler.call` tool op and the named
// client.* command allowlist are gone.
// =============================================================================

import type { RocketRideClient } from 'rocketride';

/** The engine surface the profiler view uses. */
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

/**
 * The engine over the realm's client.
 *
 * @param client - The realm's connected client, or null while disconnected.
 * @returns The engine (rebuild when the client/connection changes).
 */
export function createProfilerEngine(client: RocketRideClient | null): ProfilerEngine {
	return {
		ready: client !== null,
		call: <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
			if (!client) return Promise.reject(new Error('Not connected to a server.'));
			return client.call<T>(command, args);
		},
	};
}
