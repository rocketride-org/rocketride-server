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

import { rewriteToolsListSse, type JsonRpcRequestFrame } from './proxy';
import type { LiveSession } from './types';

/**
 * Two tools the ENGINE does not have — injected into `tools/list` and short-circuited on
 * `tools/call` entirely at rocket-agent's MCP proxy (see `appendSyntheticToolsToListSse` /
 * `isSyntheticToolCall` / `handleSyntheticToolCall` below). opencode is the MCP client
 * pointed at our proxy, so a real engine change is never required to grow the agent's
 * tool surface this way. Schemas are already OpenAI-compatible (top-level `type:"object"`,
 * no top-level anyOf/oneOf/enum/etc — see `sanitizeToolSchema` in proxy.ts), and each carries
 * `readOnlyHint:true` since neither one mutates the pipeline document.
 */
export const SYNTHETIC_TOOLS = [
	{ name: 'present_gate',
		description: 'Ask the user to approve an IRREVERSIBLE step (running a pipeline that costs money, or publishing/deploying). Non-blocking: returns immediately; the user answers on the canvas and their next message carries the choice. Do NOT call for reversible actions (editing, validating, describing).',
		inputSchema: { type: 'object', properties: {
			id: { type: 'string', description: 'stable gate id, e.g. run-cost or publish' },
			brief: { type: 'string', description: 'one-line, plain-language summary of what will happen and its cost' },
			options: { type: 'array', items: { type: 'string' }, description: 'named choices, e.g. ["run","cancel"]' },
		}, required: ['id', 'brief', 'options'] },
		annotations: { readOnlyHint: true } },
	{ name: 'enter_phase',
		description: 'Load the skill for a lifecycle phase (designing | configuring | running | debugging). Returns that phase’s guidance and keeps it active until you enter another phase.',
		inputSchema: { type: 'object', properties: {
			name: { type: 'string', description: 'designing | configuring | running | debugging' },
		}, required: ['name'] },
		annotations: { readOnlyHint: true } },
] as const;

const SYNTHETIC_TOOL_NAMES = new Set<string>(SYNTHETIC_TOOLS.map((t) => t.name));

/**
 * Append the synthetic tool defs to the `result.tools` array of a buffered `tools/list` SSE
 * response, via proxy.ts's shared {@link rewriteToolsListSse} (the same parse/match/mutate/
 * restringify mechanics `sanitizeMcpToolSchemas` uses). Compose AFTER `sanitizeMcpToolSchemas`
 * so the synthetic entries also flow through the OpenAI schema shim (a no-op for these —
 * they're already clean — but keeps one consistent pipeline).
 */
export function appendSyntheticToolsToListSse(rawSse: string): string {
	return rewriteToolsListSse(rawSse, (obj) => {
		obj.result.tools.push(...SYNTHETIC_TOOLS);
	});
}

/** True when a parsed frame is a `tools/call` invocation naming one of `SYNTHETIC_TOOLS`. */
export function isSyntheticToolCall(frame: JsonRpcRequestFrame | undefined): boolean {
	return frame?.method === 'tools/call' && typeof frame.params?.name === 'string' && SYNTHETIC_TOOL_NAMES.has(frame.params.name);
}

/**
 * Everything a synthetic tool handler needs from the live session, without handing over the
 * whole `LiveSession` (or the `SessionManager`). Built fresh per call at the MCP route from
 * the resolved `LiveSession`:
 *  - `emit` → `live.events.emit('event', ...)` (rocket-agent's own panel event stream)
 *  - `setPhase` → sets `live.turn.activePhase`
 *  - `openGate` → sets `live.turn.awaitingGate`
 *  - `phaseBody` → looks up the seeded skill body for a phase name
 */
export interface SyntheticCtx {
	live: LiveSession;
	emit(event: unknown): void;
	setPhase(name: string): void;
	openGate(id: string, options: { brief: string; options: string[] }): void;
	phaseBody(name: string): string;
}

/** Shape of the MCP tool-result envelope handed back to opencode over the wire. */
interface McpToolResultEnvelope {
	content: Array<{ type: 'text'; text: string }>;
	structuredContent?: Record<string, unknown>;
}

function envelope(id: unknown, result: McpToolResultEnvelope): { jsonRpc: object } {
	return { jsonRpc: { jsonrpc: '2.0', id, result } };
}

/** Result of dispatching one synthetic tool call. `interrupt: true` tells the MCP route to fire
 * the `session.interrupt` backstop (present_gate only — enter_phase never sets it). */
export interface SyntheticToolResult {
	jsonRpc: object;
	interrupt?: boolean;
}

/**
 * Dispatch one synthetic `tools/call` frame — never forwarded upstream (the engine has no
 * idea these tools exist). `enter_phase` activates the phase (`ctx.setPhase`) and returns that
 * phase's guidance body. `present_gate` is non-blocking: it opens the gate on turn state
 * (`ctx.openGate`, so `buildTurnSystem` re-asserts "AWAITING GATE" on the next turn even if the
 * model ignores the "stop" instruction), emits a `gate.asked` panel event carrying the brief,
 * and tells the model in-band to stop calling tools. `interrupt: true` on the result is the
 * backstop for a model that ignores that text anyway — the MCP route uses it to fire
 * `deps.manager.interrupt(live)` right after this result is sent.
 */
export function handleSyntheticToolCall(frame: JsonRpcRequestFrame | undefined, ctx: SyntheticCtx): SyntheticToolResult {
	const id = frame?.id;
	const name = frame?.params?.name;
	const args = (frame?.params?.arguments ?? {}) as Record<string, unknown>;

	if (name === 'enter_phase') {
		const phase = String(args.name ?? '');
		// Resolve the body BEFORE activating the phase: an unknown name should never leave the
		// session "in" a phase that has no seeded guidance. `phaseBody` throws for anything outside
		// the four lifecycle phases (workspace.ts) — caught here and turned into a normal MCP error
		// envelope, so a bad `name` argument is a clean tool-call failure, never a crash of this route.
		let body: string;
		try {
			body = ctx.phaseBody(phase);
		} catch (err) {
			return { jsonRpc: { jsonrpc: '2.0', id, error: { code: -32602, message: (err as Error).message } } };
		}
		ctx.setPhase(phase);
		return { jsonRpc: envelope(id, { content: [{ type: 'text', text: body }] }).jsonRpc };
	}

	if (name === 'present_gate') {
		const gateId = String(args.id ?? '');
		const brief = String(args.brief ?? '');
		const options = Array.isArray(args.options) ? (args.options as string[]) : [];
		ctx.openGate(gateId, { brief, options });
		ctx.emit({ type: 'gate.asked', id: gateId, brief, options });
		return {
			jsonRpc: envelope(id, {
				content: [{ type: 'text', text: `Gate "${gateId}" presented — STOP now, do not call more tools; wait for the user's answer.` }],
				structuredContent: { status: 'awaiting', id: gateId },
			}).jsonRpc,
			interrupt: true,
		};
	}

	// Unreachable via isSyntheticToolCall-guarded callers; fail closed with an MCP error shape.
	return { jsonRpc: { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown synthetic tool: ${String(name)}` } } };
}
