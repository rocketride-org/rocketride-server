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

import { appendSyntheticToolsToListSse, isSyntheticToolCall, handleSyntheticToolCall } from '../src/synthetics';
import { parseJsonRpcRequest } from '../src/proxy';

it('appends present_gate and enter_phase to a tools/list SSE result', () => {
	const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'validate_pipeline', inputSchema: { type: 'object', properties: {} } }] } })}\n\n`;
	const names = JSON.parse(/data: (.+)/.exec(appendSyntheticToolsToListSse(sse))![1]).result.tools.map((t: any) => t.name);
	expect(names).toEqual(expect.arrayContaining(['validate_pipeline', 'present_gate', 'enter_phase']));
});

it('recognizes a synthetic tools/call', () => {
	const frame = parseJsonRpcRequest(Buffer.from(JSON.stringify({ method: 'tools/call', params: { name: 'enter_phase', arguments: { name: 'configuring' } } })));
	expect(isSyntheticToolCall(frame)).toBe(true);
});

it('enter_phase returns the phase body and sets active phase', () => {
	const calls: string[] = [];
	const frame = parseJsonRpcRequest(Buffer.from(JSON.stringify({ id: 7, method: 'tools/call', params: { name: 'enter_phase', arguments: { name: 'configuring' } } })));
	const out = handleSyntheticToolCall(frame, { setPhase: (n) => calls.push(n), phaseBody: () => 'CONFIGURE PHASE BODY', emit: () => {}, openGate: () => {}, live: {} as any });
	expect(calls).toEqual(['configuring']);
	expect(JSON.stringify(out.jsonRpc)).toContain('CONFIGURE PHASE BODY');
	// enter_phase never triggers the session.interrupt backstop — only present_gate does.
	expect(out.interrupt).toBeFalsy();
});

it('enter_phase turns an unknown phase (phaseBody throw) into an MCP error envelope, not a crash', () => {
	const calls: string[] = [];
	const frame = parseJsonRpcRequest(Buffer.from(JSON.stringify({ id: 9, method: 'tools/call', params: { name: 'enter_phase', arguments: { name: 'bogus' } } })));
	const phaseBody = (): string => { throw new Error('enter_phase: unknown phase "bogus" (expected one of designing, configuring, running, debugging)'); };
	const out = handleSyntheticToolCall(frame, { setPhase: (n) => calls.push(n), phaseBody, emit: () => {}, openGate: () => {}, live: {} as any });
	// The bad name never activates a phase — setPhase must not run when phaseBody rejects it.
	expect(calls).toEqual([]);
	const jsonRpc = out.jsonRpc as { error?: { message: string } };
	expect(jsonRpc.error?.message).toContain('unknown phase');
	expect(out.interrupt).toBeFalsy();
});

it('present_gate opens a gate, emits gate.asked, and tells the model to stop', () => {
	const emitted: any[] = []; let opened: any = null;
	const frame = parseJsonRpcRequest(Buffer.from(JSON.stringify({ id: 3, method: 'tools/call', params: { name: 'present_gate', arguments: { id: 'run-cost', brief: 'Run costs ~$0.04', options: ['run', 'cancel'] } } })));
	const out = handleSyntheticToolCall(frame, { emit: (e) => emitted.push(e), openGate: (id, o) => (opened = { id, o }), setPhase: () => {}, phaseBody: () => '', live: {} as any });
	expect(opened).toEqual({ id: 'run-cost', o: { brief: 'Run costs ~$0.04', options: ['run', 'cancel'] } });
	// Assert id/brief/options on the EMITTED event itself, not just on the separate openGate
	// capture above — this is what the panel actually receives over the session's event stream.
	expect(emitted[0]).toMatchObject({ type: 'gate.asked', id: 'run-cost', brief: expect.stringContaining('$0.04'), options: ['run', 'cancel'] });
	expect(JSON.stringify(out.jsonRpc).toLowerCase()).toContain('stop');
	// The route uses this to fire the session.interrupt backstop — present_gate must be non-blocking
	// (returns immediately) but the model can still ignore the "stop" text and try another tool call.
	expect(out.interrupt).toBe(true);
});
