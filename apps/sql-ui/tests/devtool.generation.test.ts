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
// SQL DEV TOOL — generation tickets stay in the frame
// =============================================================================
//
// A generation ticket is a function: it cannot cross the op channel. In a
// dev-tool frame the REMOTE session checks it (sqlEnv.ts): a request whose
// ticket expired before it was sent is not sent at all, and an answer or a
// failure that arrives after its ticket expired is dropped as `stale`. What
// crosses is plain JSON (the harness's JSON wire records anything else).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer/errors';
import { createGeneration } from 'shared/explorer/generation';
import { PIPELINE, postgres, rig, toolRequests } from './devtoolRig';

describe('frame-local generation tickets (port of 740b69c6d)', () => {
	it('an expired ticket sends nothing to the controller', async () => {
		const r = await rig();
		try {
			const session = r.env.getSession(await r.env.resolveEndpoint(PIPELINE));
			const generation = createGeneration();
			const ticket = generation.next();
			generation.invalidate();
			const before = r.frameCalls.length;
			await assert.rejects(session.execute('SELECT 1', { idempotent: true, generation: ticket }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			assert.equal(r.frameCalls.length, before, 'no op was called');
			assert.equal(toolRequests(r.engine, 'execute').length, 0);
		} finally {
			r.dispose();
		}
	});

	it('an answer that arrives after the ticket expired is dropped; a current one lands; nothing but JSON crossed', async () => {
		let release: () => void = () => undefined;
		const r = await rig({ tool: (params) => (params.tool === 'execute' ? new Promise((resolve) => { release = () => resolve({ rows: [{ id: 1 }], affected_rows: 0 }); }) : postgres(params)) });
		try {
			const session = r.env.getSession(await r.env.resolveEndpoint(PIPELINE));
			const generation = createGeneration();
			const stale = generation.next();
			const pending = session.execute('SELECT 1', { idempotent: true, generation: stale });
			await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
			generation.invalidate();
			release();
			await assert.rejects(pending, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			const current = generation.next();
			const answered = session.execute('SELECT 2', { generation: current });
			await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
			release();
			assert.deepEqual(await answered, { rows: [{ id: 1 }], affected_rows: 0 });
			assert.deepEqual(r.h.violations, [], 'the ticket never crossed the wire');
		} finally {
			r.dispose();
		}
	});
});
