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
// AGENT TYPES — rocket-agent + OpenCode wire shapes (single source)
// =============================================================================
//
// Mirrors the rocket-agent HTTP API (Phase 3) and the OpenCode wire subset
// consumed by useAgentSession. Keep this the ONE place these shapes are
// declared — everything else imports from here.
// =============================================================================

/** Lifecycle state of a rocket-agent session. */
export type SessionStatus = 'active' | 'paused_auth' | 'workspace_full' | 'archived';

/** A rocket-agent session as returned by the sessions list/create/resume endpoints. */
export interface AgentSessionRecord {
	sessionId: string;
	title: string;
	/** D1: the pipeline path the session was opened against. */
	pipePath: string;
	pipesTouched: string[];
	status: SessionStatus;
	lastActivity: number;
	createdAt: number;
}

/** Event frame from the rocket-agent `/agent/sessions/:id/events` SSE stream. */
export interface AgentEvent {
	type: 'snapshot' | 'saved' | 'save.failed' | 'auth.expired' | 'auth.refreshed' | 'workspace_full';
	sha?: string;
	file?: string;
	pipes?: string[];
}

/**
 * OpenCode wire subset (verify against @opencode-ai/sdk@1.18.16 types.gen.ts — P4-V1/V2).
 * Only the fields useAgentSession actually reads are modeled here.
 */
export interface OcTokens {
	input: number;
	output: number;
	reasoning: number;
	cache: { read: number; write: number };
}

export interface OcMessage {
	id: string;
	sessionID: string;
	role: 'user' | 'assistant';
	cost?: number;
	tokens?: OcTokens;
	modelID?: string;
	providerID?: string;
}

export interface OcPart {
	id: string;
	messageID: string;
	sessionID: string;
	type: string;
	text?: string;
	tool?: string;
	// `input` = the tool call's arguments (opencode ToolState.input); modeled for the trace view.
	state?: { status?: string; title?: string; output?: string; input?: unknown };
}

export interface OcPermissionAsk {
	id: string;
	sessionID: string;
	title?: string;
	type?: string;
	metadata?: Record<string, unknown>;
}

export interface OcEvent {
	type: string;
	properties?: Record<string, unknown>;
}
