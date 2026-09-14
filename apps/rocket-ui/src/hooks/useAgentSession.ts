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
// USE AGENT SESSION — attach to a rocket-agent session, stream its transcript
// =============================================================================
//
// Resumes the session if needed, finds-or-creates the inner OpenCode session,
// hydrates prior transcript, then opens two Bearer-authenticated SSE streams:
// OpenCode's /opencode/global/event (message parts, permissions, file edits)
// and rocket-agent's /events (saved, auth, workspace-cap). Both streams are
// torn down via a single AbortController on unmount/session change.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from 'shell';
import { agentApi, readSse } from '../services/agentApi';
import type { AgentEvent, OcEvent, OcGateAsk, OcMessage, OcPart, OcPermissionAsk, OcTokens } from '../services/agentTypes';

/** Running spend for the attached session — real cost when the model reports it, else an estimate. */
export interface SpendState {
	costUsd: number;
	tokens: OcTokens;
	estimated: boolean;
}

const ZERO: OcTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

/**
 * The RocketRide pipeline-builder agent, seeded into every session workspace at
 * `.opencode/agent/rr-builder.md` by rocket-agent's seedWorkspace(). OpenCode has no config
 * knob to make a custom agent the session default (built-in "build" stays default), so every
 * prompt MUST pass `agent` explicitly or the generic "build" agent answers with no RR system
 * prompt. Keep this in lockstep with the seeded file's basename.
 */
const RR_AGENT = 'rr-builder';

/** What the attached session actually loaded — surfaced in the panel header for visibility. */
export interface AgentInfo {
	/** The agent we ask opencode to run (RR_AGENT). */
	activeAgent: string;
	/** Every agent opencode discovered — if activeAgent isn't here, the seed failed. */
	agents: string[];
	/** Which MCP upstream this session is wired to: the full engine ('real') or the dev stub ('stub'). */
	engine?: 'real' | 'stub';
}

/** Return shape of {@link useAgentSession}. */
export interface UseAgentSessionResult {
	messages: ChatMessage[];
	isTyping: boolean;
	connected: boolean;
	status: string;
	spend: SpendState;
	/** Loaded agent + tool inventory for the header status line; null until fetched (or if the fetch fails). */
	agentInfo: AgentInfo | null;
	pendingPermission: OcPermissionAsk | null;
	/** The pending present_gate ask, if any — mirrors pendingPermission's plumbing. */
	pendingGate: OcGateAsk | null;
	/** Grows on each 'saved' event — drives the chips. */
	savedPipes: string[];
	send: (text: string) => void;
	/** Abort the in-flight opencode turn (the Stop button) — halts a hung/runaway generation. */
	stop: () => Promise<void>;
	answerPermission: (id: string, response: 'once' | 'always' | 'reject') => Promise<void>;
	answerGate: (id: string, option: string) => Promise<void>;
	save: () => Promise<string[]>;
}

function ts(): string {
	return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Attach to a rocket-agent session and stream its transcript, spend, and
 * pending permission asks.
 *
 * @param sessionId - The rocket-agent session id, or null while unattached.
 * @param onFileChange - Called with the relative path on each OpenCode `file.edited` event.
 * @param openDocUri - The store-path form of the pipe currently open on the canvas (Layer-2
 *   grounding); sent as the `x-rr-open-doc` header on every prompt so the server can name it
 *   in the per-turn `<live-state>` block. Undefined outside a canvas context (the standalone
 *   `agent:` tab has no open doc).
 * @returns Live transcript + status, plus `send`/`answerPermission`/`save` actions.
 */
export function useAgentSession(sessionId: string | null, onFileChange?: (file: string) => void, openDocUri?: string): UseAgentSessionResult {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [isTyping, setIsTyping] = useState(false);
	const [connected, setConnected] = useState(false);
	const [status, setStatus] = useState('idle');
	const [spend, setSpend] = useState<SpendState>({ costUsd: 0, tokens: ZERO, estimated: false });
	const [pendingPermission, setPendingPermission] = useState<OcPermissionAsk | null>(null);
	const [pendingGate, setPendingGate] = useState<OcGateAsk | null>(null);
	const [savedPipes, setSavedPipes] = useState<string[]>([]);
	const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
	const oidRef = useRef<string | null>(null);
	const nextId = useRef(1);
	const byOcId = useRef(new Map<string, number>()); // OpenCode part id -> ChatMessage id
	const msgRole = useRef(new Map<string, string>()); // OpenCode message id -> role (message.part.updated omits it)
	const pendingEchoes = useRef<number[]>([]); // optimistic user-echo ids awaiting their live SSE part (FIFO, in send order)
	const openDocRef = useRef<string | undefined>(openDocUri); // latest open-doc URI, read by `send` without re-binding it

	useEffect(() => {
		openDocRef.current = openDocUri;
	}, [openDocUri]);

	const upsert = useCallback((ocId: string, patch: Omit<ChatMessage, 'id'>) => {
		// Allocate the id and record the OpenCode-part->ChatMessage mapping OUTSIDE the
		// updater. React StrictMode double-invokes state updaters in dev to surface
		// impurity; a `nextId.current++` / `byOcId.set()` inside would run twice, and the
		// DISCARDED first pass would poison `byOcId` so the KEPT second pass takes the
		// update branch against a message it never appended — silently dropping it (the
		// bug that left bot bubbles unrendered while applyPart still logged). The updater
		// below is pure and idempotent: both StrictMode passes yield the same result.
		let id = byOcId.current.get(ocId);
		if (id === undefined) {
			id = nextId.current++;
			byOcId.current.set(ocId, id);
		}
		const mid = id;
		setMessages((prev) => (prev.some((m) => m.id === mid) ? prev.map((m) => (m.id === mid ? { ...m, ...patch, id: mid } : m)) : [...prev, { ...patch, id: mid }]));
	}, []);

	const applyPart = useCallback(
		(msg: OcMessage | undefined, part: OcPart) => {
			if (part.type === 'text' && part.text !== undefined) {
				// message.part.updated carries no message role; fall back to the role recorded from
				// the message.updated event (or history) for this part's messageID.
				const role = msg?.role ?? msgRole.current.get((part as { messageID?: string }).messageID ?? '');
				// Reconcile the optimistic echo: send() renders the user's message instantly under a
				// synthetic id, then opencode streams that same message back as its own text part with a
				// different id. Without this the two never dedupe and the user sees their message twice.
				// The first not-yet-seen user part after a send adopts the oldest pending echo's id, so
				// upsert() updates that bubble in place instead of appending a duplicate. FIFO holds
				// because prompts (and their echoed parts) arrive in send order.
				if (role === 'user' && byOcId.current.get(part.id) === undefined && pendingEchoes.current.length > 0) {
					byOcId.current.set(part.id, pendingEchoes.current.shift()!);
				}
				upsert(part.id, { text: part.text, sender: role === 'user' ? 'user' : 'bot', timestamp: ts() });
			} else if (part.type === 'reasoning' && part.text !== undefined) {
				// Model "thinking" — a trace step, NOT a chat bubble. Populated only by models that emit
				// reasoning (empty on gpt-4o); folds into the same collapsible trace group as tool calls.
				upsert(part.id, { text: part.text, sender: 'status', sseType: 'reasoning', timestamp: ts() });
			} else if (part.type === 'tool') {
				// Tool call → a trace step. Consecutive 'status' parts fold into MessageList's collapsible
				// trace group. Show tool name, args (state.input), result (state.output), and live status,
				// re-rendered in place as the tool advances running → completed/error.
				const st = part.state;
				const args = st?.input !== undefined ? JSON.stringify(st.input).slice(0, 120) : '';
				const out = st?.output ? ` → ${st.output.slice(0, 200)}` : '';
				const status = st?.status ?? 'running';
				upsert(part.id, { text: `**${part.tool ?? 'tool'}**(${args})${out} · ${status}`, sender: 'status', sseType: 'tool', timestamp: ts() });
			}
		},
		[upsert],
	);

	// Attach: resume if needed, find-or-create the inner OpenCode session, hydrate history, open both SSE streams.
	useEffect(() => {
		if (!sessionId) return;
		const ac = new AbortController();
		// A fast session switch (or unmount) aborts `ac` while the health/resume/
		// oc/hydrate chain is in flight. `ac.signal` is threaded through every
		// call() below so the whole chain rejects on abort instead of resolving
		// late with the OLD session's data — but the reject/resolve race and the
		// setState call are still two separate steps, so every setState in this
		// effect is additionally wrapped in `safeSet` as a structural guarantee
		// that a superseded run can never clobber the newer effect's state.
		const safeSet = (fn: () => void): void => {
			if (!ac.signal.aborted) fn();
		};
		void (async () => {
			try {
				const health = await agentApi.health(sessionId, ac.signal);
				if (health.status === 'archived' || !health.opencode) await agentApi.resume(sessionId, ac.signal);
				safeSet(() => setStatus(health.status === 'archived' ? 'active' : health.status));
				const inner = await agentApi.oc<Array<{ id: string }>>(sessionId, 'GET', '/session', undefined, ac.signal);
				const oid = inner[0]?.id ?? (await agentApi.oc<{ id: string }>(sessionId, 'POST', '/session', {}, ac.signal)).id;
				oidRef.current = oid;
				const history = await agentApi.oc<Array<{ info: OcMessage; parts: OcPart[] }>>(sessionId, 'GET', `/session/${oid}/message`, undefined, ac.signal);
				byOcId.current.clear();
				msgRole.current.clear();
				pendingEchoes.current = [];
				safeSet(() => setMessages([]));
				for (const m of history) {
					if (m.info?.id && m.info?.role) msgRole.current.set(m.info.id, m.info.role);
					for (const p of m.parts) applyPart(m.info, p);
				}
				safeSet(() => setSpend(computeSpend(history.map((h) => h.info))));
				safeSet(() => setConnected(true));
				// Visibility: capture which agent this session loaded + which engine it's wired to, for the
				// header status line. `health.engine` (fetched above) is the authoritative stub/real signal;
				// listAgents confirms rr-builder actually loaded. Best-effort — a failure leaves agentInfo
				// null and simply hides the line; it never blocks the attach.
				void agentApi.listAgents(sessionId, ac.signal)
					.then((agents) => safeSet(() => setAgentInfo({ activeAgent: RR_AGENT, agents: agents.map((a) => a.name), engine: health.engine })))
					.catch((e) => console.warn('[rr-agent] agent info fetch failed', e));
				// Stream 1: OpenCode events (message parts, permissions, file edits).
				// P4-V2 RESOLVED: use `/event`, NOT `/global/event`. `/global/event` wraps every
				// event in a `{ payload: {...} }` envelope, so `e.type` is undefined and the
				// handler below drops all events; `/event` emits the SDK-shaped `{ type, properties }`.
				readSse(
					`/agent/sessions/${sessionId}/opencode/event`,
					(raw) => {
						// A chunk can carry several buffered frames that drain
						// synchronously before the next reader.read() observes the
						// abort — guard here too, not just around the chain above.
						if (ac.signal.aborted) return;
						const e = raw as OcEvent;
						const _pp = (e.properties ?? {}) as { part?: { type?: string; text?: string; messageID?: string } };
						console.log('[rr-agent] SSE', (e as { type?: string }).type, _pp.part ? `part=${_pp.part.type} text=${JSON.stringify((_pp.part.text ?? '').slice(0, 40))} msg=${_pp.part.messageID}` : '');
						const p = (e.properties ?? {}) as Record<string, unknown>;
						if (e.type === 'message.part.updated') applyPart(p.info as OcMessage | undefined, p.part as OcPart);
						else if (e.type === 'message.updated') {
							const info = p.info as OcMessage;
							// Record the role so message.part.updated (which omits it) can attribute parts.
							if (info?.id && info?.role) msgRole.current.set(info.id, info.role);
							if (info?.role === 'assistant') setSpend((s) => mergeSpend(s, info));
						} else if (e.type === 'session.idle') setIsTyping(false);
						else if (e.type === 'session.error') {
							// Visibility: opencode reports backend failures (bad agent, model/auth error, MCP
							// failure) as session.error — surface them in the thread instead of dropping them,
							// which previously left the panel silently stuck with no answer. First line only
							// (stack traces stay out of the bubble); dedupe an immediately-repeated error.
							const err = p.error as { name?: string; data?: { message?: string } } | undefined;
							const emsg = (err?.data?.message ?? err?.name ?? 'session error').split('\n')[0].slice(0, 300);
							setIsTyping(false);
							const errId = nextId.current++;
							setMessages((prev) => (prev[prev.length - 1]?.text === `⚠️ ${emsg}` ? prev : [...prev, { id: errId, text: `⚠️ ${emsg}`, sender: 'system', timestamp: ts(), isError: true }]));
						} else if (e.type === 'permission.asked') setPendingPermission(p as unknown as OcPermissionAsk);
						else if (e.type === 'permission.replied') setPendingPermission(null);
						else if (e.type === 'file.edited' && typeof p.file === 'string') onFileChange?.(p.file);
					},
					ac.signal,
					// A local abort ends this stream deliberately (session switch /
					// unmount) — it must not retroactively mark the NEW session
					// disconnected, so only a real stream failure sets this false.
				).catch(() => safeSet(() => setConnected(false)));
				// Stream 2: rocket-agent events (saved, snapshot, auth, cap).
				void readSse(
					`/agent/sessions/${sessionId}/events`,
					(raw) => {
						if (ac.signal.aborted) return;
						const e = raw as AgentEvent;
						if (e.type === 'saved' && e.pipes) { setSavedPipes((prev) => [...prev, ...e.pipes!.filter((x) => !prev.includes(x))]); for (const p of e.pipes) { window.dispatchEvent(new CustomEvent('project:saved', { detail: { projectId: p } })); /* project:saved refreshes the Pipelines bar — same event the Save button fires */ window.dispatchEvent(new CustomEvent('rocketride:externalFileChanged', { detail: { path: p.replace(/^\.projects\//, '') } })); /* re-read the OPEN canvas doc so agent edits show live; strip the store's `.projects/` prefix to match the document URI */ } }
						else if (e.type === 'auth.expired') setStatus('paused_auth');
						else if (e.type === 'auth.refreshed') setStatus('active');
						else if (e.type === 'workspace_full') setStatus('workspace_full');
							else if (e.type === 'save.failed' && e.pipes?.length) { const errId = nextId.current++; setMessages((prev) => [...prev, { id: errId, text: `⚠️ Couldn't save "${e.pipes!.join(', ')}" to the project (invalid JSON — fix it and it'll auto-save)`, sender: 'system', timestamp: ts(), isError: true }]); }
							else if (e.type === 'gate.asked') setPendingGate(e as unknown as OcGateAsk);
							else if (e.type === 'gate.answered') setPendingGate(null);
					},
					ac.signal,
				).catch(() => undefined);
			} catch (err) {
				// Includes the abort itself (fetch rejects with AbortError when
				// `ac` fires mid-chain) — safeSet no-ops in that case, so a
				// superseded/unmounted run never reports itself as an error.
				safeSet(() => {
					setConnected(false);
					setStatus(`error: ${(err as Error).message}`);
				});
			}
		})();
		return () => ac.abort();
	}, [sessionId, applyPart, onFileChange]);

	const send = useCallback(
		(text: string) => {
			if (!sessionId || !oidRef.current) return;
			// Allocate ids outside the updater — see the upsert note on StrictMode purity.
			const echoId = nextId.current++;
			pendingEchoes.current.push(echoId); // adopted by this message's live SSE part (see applyPart) so it isn't duplicated
			setMessages((prev) => [...prev, { id: echoId, text, sender: 'user', timestamp: ts() }]);
			setIsTyping(true);
			// P4-V6: omit `model` if the locked config pins a default; else send the pinned constant.
			// Layer-2 grounding: tell the server which pipe is open on the canvas (`x-rr-open-doc`) so
			// it can name it in the per-turn `system` block — read from the ref so this callback never
			// re-binds on every canvas navigation (see the `openDocRef` effect above).
			void agentApi
				.oc(sessionId, 'POST', `/session/${oidRef.current}/prompt_async`, { agent: RR_AGENT, parts: [{ type: 'text', text }] }, undefined, openDocRef.current ? { 'x-rr-open-doc': openDocRef.current } : undefined)
				.catch((err: Error) => {
					setIsTyping(false);
					const errId = nextId.current++;
					setMessages((prev) => [...prev, { id: errId, text: err.message, sender: 'system', timestamp: ts(), isError: true }]);
				});
		},
		[sessionId],
	);

	const stop = useCallback(async () => {
		if (!sessionId || !oidRef.current) return;
		// Optimistically drop the typing indicator, then abort the inner opencode turn via the same
		// passthrough send/answerPermission use. `/session/{oid}/abort` is the SDK's Session.abort()
		// (not the `session.interrupt` TUI keybind) — the server exempts it from the workspace-full
		// block so Stop always works. Swallow errors: a dead/already-idle turn must not surface a scare.
		setIsTyping(false);
		await agentApi.oc(sessionId, 'POST', `/session/${oidRef.current}/abort`, {}).catch(() => undefined);
	}, [sessionId]);

	const answerPermission = useCallback(
		async (permId: string, response: 'once' | 'always' | 'reject') => {
			if (!sessionId || !oidRef.current) return;
			await agentApi.oc(sessionId, 'POST', `/session/${oidRef.current}/permissions/${permId}`, { response }); // P4-V3
			setPendingPermission(null);
		},
		[sessionId],
	);

	const answerGate = useCallback(
		async (gateId: string, option: string) => {
			if (!sessionId) return;
			// Close the gate-answer loop. Order matters: (1) optimistically clear the card, (2) POST
			// /gate so the answer is audited + `gate.answered` emitted, then (3) fire a NEW prompt so
			// the model actually resumes — its prior turn was aborted by present_gate's interrupt, so
			// without this the run would never proceed. `awaitingGate` is still set at send() time, so
			// the server injects the answering context into this turn and consumes it one-shot.
			setPendingGate(null);
			await agentApi.answerGate(sessionId, gateId, option);
			send(`Proceed with gate "${gateId}": ${option}`);
		},
		[sessionId, send],
	);

	const save = useCallback(async () => {
		if (!sessionId) return [];
		return (await agentApi.save(sessionId)).pipes;
	}, [sessionId]);

	return { messages, isTyping, connected, status, spend, agentInfo, pendingPermission, pendingGate, savedPipes, send, stop, answerPermission, answerGate, save };
}

function addTokens(a: OcTokens, b?: OcTokens): OcTokens {
	if (!b) return a;
	return { input: a.input + b.input, output: a.output + b.output, reasoning: a.reasoning + b.reasoning, cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write } };
}

/** Sum spend across a hydrated transcript's assistant messages — real cost if any message reports one, else an estimate. */
export function computeSpend(infos: OcMessage[]): SpendState {
	let cost = 0;
	let tokens = ZERO;
	let sawCost = false;
	for (const m of infos.filter((x) => x.role === 'assistant')) {
		if (typeof m.cost === 'number' && m.cost > 0) {
			cost += m.cost;
			sawCost = true;
		}
		tokens = addTokens(tokens, m.tokens);
	}
	return sawCost ? { costUsd: cost, tokens, estimated: false } : { costUsd: estimateUsd(tokens), tokens, estimated: true };
}

function mergeSpend(s: SpendState, m: OcMessage): SpendState {
	const tokens = addTokens(s.tokens, m.tokens);
	if (!s.estimated && typeof m.cost === 'number' && m.cost > 0) return { costUsd: s.costUsd + m.cost, tokens, estimated: false };
	return { costUsd: estimateUsd(tokens), tokens, estimated: true };
}

/** Fallback price table — ALWAYS labeled "estimate" in the UI (P4-V1). Update alongside the OpenCode pin. */
const USD_PER_MTOK: Record<string, { in: number; out: number }> = { default: { in: 3, out: 15 } };

function estimateUsd(t: OcTokens): number {
	const p = USD_PER_MTOK.default!;
	return (t.input + t.cache.write) * (p.in / 1e6) + t.output * (p.out / 1e6);
}
