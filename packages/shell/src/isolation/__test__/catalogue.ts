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

// =============================================================================
// CASE CATALOGUE — one valid message per capability row, as the SDK sends it
// =============================================================================
//
// Hand-written (not derived from the table) so the table tests have an
// independent oracle: T5 and T7 check that every table row has a case here,
// and that every case is allowed with its capability and refused one key over.
// =============================================================================

/// <reference types="node" />

import type { DAPMessage } from 'rocketride';
import { dap } from './realm';
import type { IOpenedRealm } from './realm';
import { openFs, openPipe, startRun } from './util';

/** Values a case needs from a prepared realm. */
export interface ICaseCtx {
	token: string;
	projectId: string;
	source: string;
	pipeId: number;
	fsHandle: string;
	/** `apps/<appKey>/<name>`. */
	path: (name: string) => string;
}

/** One valid call. */
export interface ICase {
	name: string;
	op: string;
	command?: string;
	/** `params` of a bus request, or the DAP message for `client.request`. */
	build(ctx: ICaseCtx): { params: Record<string, unknown>; message?: DAPMessage };
	/** Emit lane (no reply): the op is `emitOp`ed, never `request`ed. */
	emit?: boolean;
}

const rrbin = (n: number): { __rrbin: true; b64: string } => ({ __rrbin: true, b64: Buffer.alloc(n).toString('base64') });

const dapCase = (name: string, command: string, build: (ctx: ICaseCtx) => { args?: Record<string, unknown>; top?: Record<string, unknown> }): ICase => ({
	name,
	op: 'client.request',
	command,
	build(ctx) {
		const { args, top } = build(ctx);
		const message = dap(command, args, top);
		return { params: { message }, message };
	},
});

/** Every row of the v1 table, as one valid call. */
export const CASES: ICase[] = [
	dapCase('rrext_ping', 'rrext_ping', () => ({})),
	dapCase('execute', 'execute', (c) => ({ args: { pipeline: { components: [], source: c.source }, source: c.source, ttl: 60 } })),
	dapCase('terminate', 'terminate', (c) => ({ args: { token: c.token } })),
	dapCase('rrext_get_task_status', 'rrext_get_task_status', (c) => ({ args: { token: c.token } })),
	dapCase('rrext_get_pipeline', 'rrext_get_pipeline', (c) => ({ args: { token: c.token } })),
	dapCase('restart', 'restart', (c) => ({ args: { token: c.token, pipeline: { components: [], source: c.source }, projectId: c.projectId, source: c.source } })),
	dapCase('rrext_get_token', 'rrext_get_token', (c) => ({ args: { projectId: c.projectId, source: c.source } })),
	dapCase('rrext_monitor', 'rrext_monitor', (c) => ({ args: { types: ['summary'], token: c.token } })),
	dapCase('rrext_process open', 'rrext_process', (c) => ({ args: { subcommand: 'open', object: {}, mimeType: 'text/plain', token: c.token } })),
	dapCase('rrext_process write', 'rrext_process', (c) => ({ args: { subcommand: 'write', pipe_id: c.pipeId, data: rrbin(4), token: c.token } })),
	dapCase('rrext_process close', 'rrext_process', (c) => ({ args: { subcommand: 'close', pipe_id: c.pipeId, token: c.token } })),
	dapCase('fs_open', 'rrext_store', (c) => ({ args: { subcommand: 'fs_open', path: c.path('f.txt'), mode: 'r' } })),
	dapCase('fs_read', 'rrext_store', (c) => ({ args: { subcommand: 'fs_read', handle: c.fsHandle, offset: 0, length: 4 } })),
	dapCase('fs_write', 'rrext_store', (c) => ({ args: { subcommand: 'fs_write', handle: c.fsHandle, data: rrbin(4) } })),
	dapCase('fs_close', 'rrext_store', (c) => ({ args: { subcommand: 'fs_close', handle: c.fsHandle, mode: 'w' } })),
	dapCase('fs_delete', 'rrext_store', (c) => ({ args: { subcommand: 'fs_delete', path: c.path('f.txt') } })),
	dapCase('fs_rmdir', 'rrext_store', (c) => ({ args: { subcommand: 'fs_rmdir', path: c.path('d'), recursive: false } })),
	dapCase('fs_list_dir', 'rrext_store', (c) => ({ args: { subcommand: 'fs_list_dir', path: c.path('d') } })),
	dapCase('fs_stat', 'rrext_store', (c) => ({ args: { subcommand: 'fs_stat', path: c.path('f.txt') } })),
	dapCase('fs_mkdir', 'rrext_store', (c) => ({ args: { subcommand: 'fs_mkdir', path: c.path('d') } })),
	dapCase('fs_get_json', 'rrext_store', (c) => ({ args: { subcommand: 'fs_get_json', path: c.path('f.json') } })),
	dapCase('fs_put_json', 'rrext_store', (c) => ({ args: { subcommand: 'fs_put_json', path: c.path('f.json'), value: { a: 1 } } })),
	dapCase('fs_rename', 'rrext_store', (c) => ({ args: { subcommand: 'fs_rename', old_path: c.path('a.txt'), new_path: c.path('b.txt') } })),
	{ name: 'client.addMonitor', op: 'client.addMonitor', build: (c) => ({ params: { key: { token: c.token }, types: ['summary'] } }) },
	{ name: 'client.removeMonitor', op: 'client.removeMonitor', build: (c) => ({ params: { key: { token: c.token }, types: ['summary'] } }) },
	{ name: 'shell.frameToken.refresh', op: 'shell.frameToken.refresh', build: () => ({ params: {} }) },
	{ name: 'shell.notify', op: 'shell.notify', build: () => ({ params: { message: 'hello' } }) },
	{ name: 'shell.statusMessage', op: 'shell.statusMessage', build: () => ({ params: { message: 'working' } }) },
	{ name: 'shell.loginRequest', op: 'shell.loginRequest', build: () => ({ params: {} }) },
	{ name: 'shell.openExternal', op: 'shell.openExternal', build: () => ({ params: { url: 'https://ex.com/a' } }) },
	{ name: 'shell.prefs.attach', op: 'shell.prefs.attach', emit: true, build: () => ({ params: { partition: 'app:acme.alpha' } }) },
	{ name: 'shell.setPref', op: 'shell.setPref', emit: true, build: () => ({ params: { partition: 'app:acme.alpha', key: 'k', value: 1 } }) },
];

/** A realm with a live run, an open pipe and an open store handle, for case building. */
export async function prepareCtx(realm: IOpenedRealm, appKey: string): Promise<ICaseCtx> {
	const run = await startRun(realm);
	const path = (name: string): string => `apps/${appKey}/${name}`;
	const pipeId = await openPipe(realm, run.token);
	const fsHandle = await openFs(realm, path('open.txt'), 'w');
	return { token: run.token, projectId: run.projectId, source: run.source, pipeId, fsHandle, path };
}

/** Plausible, unowned values: what a core-only realm sends (the capability check comes first). */
export function dummyCtx(appKey: string): ICaseCtx {
	return { token: 'rh_AAAAAAAAAAAAAAAAAAAAAA', projectId: 'rp_AAAAAAAAAAAAAAAAAAAAAA', source: 'chat_1', pipeId: 1, fsHandle: 'fsh-0', path: (name) => `apps/${appKey}/${name}` };
}
